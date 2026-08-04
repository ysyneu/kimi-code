/**
 * `SDKRpcClientWire` — the third `SDKRpcClientBase` transport: the SDK talks
 * to a running kap-server over the `/api/v1` REST + WS wire instead of
 * hosting an engine in-process. Session lifecycle (list / create / resume /
 * rename / archive / fork) maps onto the REST surface; the event stream and
 * the interaction bridge ride a single WS owned by a {@link CursorSupervisor},
 * whose per-session `{seq, epoch}` cursors survive reconnects.
 *
 * Migration model mirrors `SDKRpcClientV2`: only the methods overridden below
 * are available on this transport; everything else falls through to
 * `getRpc()`, which fails loudly with `not_implemented`.
 *
 * Deliberate M1 semantics:
 * - `closeSession` is a LOCAL DETACH ONLY (unsubscribe + drop the registered
 *   handlers + drop the bridge's dedupe/queued state) — no HTTP call, the
 *   server-side session stays alive and resumable, and a later reattach
 *   re-presents interactions that are still pending. The wire has no
 *   per-connection session-close verb, and the daemon owns the session
 *   lifetime.
 * - `deleteSession` maps to `:archive` (the wire's only session-removal verb).
 * - Turns and state reads map onto the prompts / status / messages REST
 *   surface: `steer` is submit-then-`prompts::steer`, `cancel` is `:abort`,
 *   `compact` / `undoHistory` are `:compact` / `:undo`, and `getContext`
 *   serves the newest message page only. `agent_id` is never sent — every
 *   turn override addresses the main agent (M1).
 * - `resumeSession` subscribes at the snapshot cursor and replays the
 *   snapshot's pending interactions into the bridge; replayed (and live)
 *   interactions queue until the consumer registers its handlers — consumers
 *   register them after `resumeSession` returns, so attach never auto-cancels
 *   a genuinely pending approval/question. The returned
 *   `ResumedSessionSummary` carries a populated `agents.main` built from the
 *   snapshot + paged messages (see `resume-replay.ts`) so the TUI's replay
 *   contract renders the session's history, plus a best-effort
 *   `sessionMetadata` and `warning: undefined`.
 * - `sessionDir` is `''` everywhere: the server never exposes its on-disk
 *   layout over the wire.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ErrorCodes, KimiError, noopTelemetryClient } from '@moonshot-ai/agent-core';
import type { AgentContextData } from '@moonshot-ai/agent-core';
import { ensureKimiHome, resolveConfigPath, resolveKimiHome } from '@moonshot-ai/agent-core-v2';
import { assertKimiHostIdentity } from '@moonshot-ai/kimi-code-oauth';

import { KimiAuthFacade } from '#/auth';
import type { ApprovalHandler, QuestionHandler } from '#/events';
import {
  SDKRpcClientBase,
  type SessionIdRpcInput,
  type SessionPromptRpcInput,
  type SetSessionPermissionRpcInput,
} from '#/rpc';
import type {
  CompactOptions,
  CreateSessionOptions,
  ForkSessionInput,
  JsonObject,
  KimiHostIdentity,
  ListSessionsOptions,
  McpStartupMetrics,
  OAuthRefreshOutcome,
  PermissionMode,
  PluginCommandDef,
  PluginSummary,
  PromptPart,
  RenameSessionInput,
  ResumeSessionInput,
  ResumedSessionSummary,
  SessionStatus,
  SessionSummary,
  SessionUsage,
  SkillSummary,
  TelemetryClient,
} from '#/types';

import { CursorSupervisor } from './cursor-supervisor';
import { translateWireEvent } from './event-translator';
import { WireHttpClient } from './http-client';
import { EnvelopeError } from './protocol';
import type {
  WireSession,
  WireSessionStatus,
  WireSessionUsage,
  WireSnapshot,
  WsEventFrame,
} from './protocol';
import {
  buildResumedMainAgentState,
  collectReplayMessages,
  wireMessageToContextMessage,
} from './resume-replay';
import { InteractionBridge } from './reverse-rpc';
import { WsConnection } from './ws-connection';

export interface SDKRpcClientWireOptions {
  /** Loopback base URL of a running kap-server, e.g. `http://127.0.0.1:58627`. */
  readonly serverUrl: string;
  /** Bearer token; when omitted, read from `<homeDir>/server.token`. */
  readonly token?: string;
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly identity?: KimiHostIdentity;
  readonly telemetry?: TelemetryClient;
  readonly onOAuthRefresh?: (outcome: OAuthRefreshOutcome) => void;
  readonly uiMode?: string;
}

/**
 * Wire-side prompt input. The base `SessionPromptRpcInput` is a closed
 * interface, so the wire transport widens it with the per-prompt overrides
 * the kap-server prompt route accepts (`model` / `profile`, verified in
 * rest-prompt's `promptSubmissionSchema`); the overrides below narrow the
 * parameter type, which TS allows on method overrides.
 */
export interface WirePromptRpcInput extends SessionPromptRpcInput {
  readonly model?: string;
  readonly profile?: string;
}

/**
 * Read the kap-server bearer token from `<homeDir>/server.token` (the file
 * the server's persistent token store writes). Never logs the token, never
 * writes the file — a missing/unreadable file means no server is running at
 * this home, so the error says exactly that.
 */
function readServerToken(homeDir: string): string {
  const path = join(homeDir, 'server.token');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    throw new KimiError(
      ErrorCodes.AUTH_LOGIN_REQUIRED,
      `No kap-server token found at "${path}" — pass an explicit token or start a server with this home directory.`,
      { details: { cause: String(error) } },
    );
  }
  const token = raw.trim();
  if (token === '') {
    throw new KimiError(
      ErrorCodes.AUTH_LOGIN_REQUIRED,
      `The kap-server token file at "${path}" is empty — pass an explicit token or restart the server.`,
    );
  }
  return token;
}

/** `WireSession` → the v1 `SessionSummary` the SDK surface serves. */
function wireSessionToSummary(session: WireSession): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    lastPrompt: session.last_prompt,
    workDir: session.metadata.cwd,
    sessionDir: '',
    createdAt: Date.parse(session.created_at),
    updatedAt: Date.parse(session.updated_at),
    archived: session.archived,
    metadata: session.metadata as JsonObject,
  };
}

/**
 * kosong `PromptPart` → the protocol message content the prompt route
 * validates (`messageContentSchema` in agent-core-v2's protocolMessage.ts).
 * The wire carries media as `{ type: 'image' | 'video', source }`; a kosong
 * URL part maps to the `url` source kind, forwarding the provider file id.
 */
export function toWireContent(part: PromptPart): Record<string, unknown> {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'image_url':
      return {
        type: 'image',
        source: { kind: 'url', url: part.imageUrl.url, id: part.imageUrl.id },
      };
    case 'video_url':
      return {
        type: 'video',
        source: { kind: 'url', url: part.videoUrl.url, id: part.videoUrl.id },
      };
  }
}

/** `WireSessionStatus` → the SDK `SessionStatus`. */
function wireStatusToSessionStatus(status: WireSessionStatus): SessionStatus {
  return {
    model: status.model,
    thinkingEffort: status.thinking_level,
    permission: status.permission as PermissionMode,
    planMode: status.plan_mode,
    swarmMode: status.swarm_mode,
    contextTokens: status.context_tokens,
    maxContextTokens: status.max_context_tokens,
    contextUsage: status.context_usage,
    // The wire status surface carries no token-usage breakdown.
    usage: undefined,
  };
}

/**
 * `WireSessionUsage` → the SDK `SessionUsage`. The wire row only carries
 * session totals — no per-model or current-turn split (M1).
 */
function wireUsageToSessionUsage(usage: WireSessionUsage): SessionUsage {
  return {
    total: {
      inputOther: usage.input_tokens,
      output: usage.output_tokens,
      inputCacheRead: usage.cache_read_tokens,
      inputCacheCreation: usage.cache_creation_tokens,
    },
    byModel: undefined,
    currentTurn: undefined,
  };
}

export class SDKRpcClientWire extends SDKRpcClientBase {
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity: KimiHostIdentity | undefined;
  readonly telemetry: TelemetryClient;
  readonly auth: KimiAuthFacade;

  private readonly http: WireHttpClient;
  private readonly supervisor: CursorSupervisor;
  private readonly bridge: InteractionBridge;
  // Handler-presence probes for the bridge: the base class auto-cancels an
  // approval (dismisses a question) when no handler is registered — correct
  // for the in-process engines, but on the wire a pending interaction can
  // arrive at attach time, before the consumer registers its handlers. The
  // bridge queues those interactions instead, and these sets are how it knows.
  private readonly approvalHandlerSessions = new Set<string>();
  private readonly questionHandlerSessions = new Set<string>();
  // Deferred permission overrides (design §4.1): the wire has no standalone
  // setPermission verb, so the mode waits here and rides the NEXT prompt/steer
  // submission for that session as `permission_mode`, then clears.
  private readonly pendingPermissions = new Map<string, PermissionMode>();

  constructor(options: SDKRpcClientWireOptions) {
    super();
    // The wire transport authenticates with the server home's bearer token —
    // a secret that must never leave the loopback interface.
    const url = new URL(options.serverUrl);
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        'The wire transport only supports a loopback serverUrl (127.0.0.1 or localhost).',
      );
    }
    this.identity =
      options.identity === undefined ? undefined : assertKimiHostIdentity(options.identity);
    this.homeDir = resolveKimiHome(options.homeDir);
    this.configPath = resolveConfigPath({
      homeDir: this.homeDir,
      configPath: options.configPath,
    });
    ensureKimiHome(this.homeDir);
    this.telemetry = options.telemetry ?? noopTelemetryClient;
    this.auth = new KimiAuthFacade({
      homeDir: this.homeDir,
      configPath: this.configPath,
      identity: this.identity,
      onRefresh: options.onOAuthRefresh,
    });

    const token = options.token ?? readServerToken(this.homeDir);
    this.http = new WireHttpClient({ baseUrl: options.serverUrl, token });
    this.bridge = new InteractionBridge({
      http: this.http,
      requestApproval: (request) => this.requestApproval(request),
      requestQuestion: (request) => this.requestQuestion(request),
      hasApprovalHandler: (sessionId) => this.approvalHandlerSessions.has(sessionId),
      hasQuestionHandler: (sessionId) => this.questionHandlerSessions.has(sessionId),
    });
    this.supervisor = new CursorSupervisor({
      makeConnection: () =>
        new WsConnection({
          url: `${options.serverUrl.replace(/^http/, 'ws')}/api/v1/ws`,
          token,
        }),
      onResync: (sessionId) => {
        void this.resyncSession(sessionId);
      },
    });
    this.supervisor.onEventFrame((frame) => {
      const event = translateWireEvent(frame as WsEventFrame);
      if (event === null) return;
      this.receiveEvent(event);
      // The interaction types are wire-only — the v1 Event union never
      // declared them (the in-process engines push approvals through the
      // handler callbacks, not the event stream), so compare as a string.
      const type: string = event.type;
      if (type === 'event.approval.requested' || type === 'event.question.requested') {
        this.bridge.handleEvent(event as unknown as { type: string });
      }
    });
  }

  protected getRpc(): Promise<never> {
    throw new KimiError(
      ErrorCodes.NOT_IMPLEMENTED,
      'This SDK method is not available on the wire transport.',
    );
  }

  /** The server owns the config file; the client never writes one. */
  async ensureConfigFile(): Promise<void> {}

  /** Connect the event supervisor. Called once by the factory before use. */
  async start(): Promise<void> {
    await this.supervisor.start();
  }

  async close(): Promise<void> {
    await this.supervisor.close();
  }

  // -----------------------------------------------------------------------
  // Interaction handlers
  //
  // Consumers register handlers after `resumeSession` returns, so replayed
  // (and early live) interactions sit queued in the bridge; registration
  // flushes them, firing each pending id exactly once per attach.
  // -----------------------------------------------------------------------

  override setApprovalHandler(sessionId: string, handler: ApprovalHandler | undefined): void {
    super.setApprovalHandler(sessionId, handler);
    if (handler === undefined) {
      this.approvalHandlerSessions.delete(sessionId);
      return;
    }
    this.approvalHandlerSessions.add(sessionId);
    this.bridge.flush(sessionId, 'approval');
  }

  override setQuestionHandler(sessionId: string, handler: QuestionHandler | undefined): void {
    super.setQuestionHandler(sessionId, handler);
    if (handler === undefined) {
      this.questionHandlerSessions.delete(sessionId);
      return;
    }
    this.questionHandlerSessions.add(sessionId);
    this.bridge.flush(sessionId, 'question');
  }

  override clearSessionHandlers(sessionId: string): void {
    super.clearSessionHandlers(sessionId);
    this.approvalHandlerSessions.delete(sessionId);
    this.questionHandlerSessions.delete(sessionId);
  }

  // -----------------------------------------------------------------------
  // Session lifecycle
  // -----------------------------------------------------------------------

  override async listSessions(
    input: ListSessionsOptions = {},
  ): Promise<readonly SessionSummary[]> {
    // The wire list filters by workspace id, not workDir; M1 lists everything
    // and leaves bucket filtering to the caller (matching the daemon clients).
    void input;
    const page = await this.http.listSessions({ workspace_id: undefined });
    return page.items.map(wireSessionToSummary);
  }

  override async createSession(input: CreateSessionOptions): Promise<SessionSummary> {
    if (input.workDir === undefined || input.workDir === '') {
      throw new KimiError(
        ErrorCodes.REQUEST_WORK_DIR_REQUIRED,
        'createSession on the wire transport requires a workDir.',
      );
    }
    // cwd wins on conflict — the route requires it and rejects a mismatch.
    const created = await this.http.createSession({
      metadata: { ...input.metadata, cwd: input.workDir },
    });
    // The create route reads only `metadata.cwd` / `title` from the body and
    // drops every other custom key; custom metadata is persisted through the
    // profile route instead (mirrors v2's post-create `update({ custom })`).
    if (input.metadata !== undefined && Object.keys(input.metadata).length > 0) {
      await this.http.updateSessionProfile(created.id, { metadata: { ...input.metadata } });
    }
    // No subscription: an empty session produces no events; resume/prompt
    // attaches the cursor when there is something to stream.
    // v1/v2 return the caller's metadata verbatim on create (not the merged
    // custom map a later listing reports) — same here.
    return { ...wireSessionToSummary(created), metadata: input.metadata };
  }

  override async resumeSession(input: ResumeSessionInput): Promise<ResumedSessionSummary> {
    const snapshot = await this.http.getSnapshot(input.id);
    await this.supervisor.subscribe(input.id, {
      seq: snapshot.as_of_seq,
      epoch: snapshot.epoch,
    });
    this.bridge.replayPending(input.id, snapshot);
    // Read-only detail fetches happen after the subscribe + pending replay,
    // keeping the M1 attach order intact. `includeSubagents` cannot be
    // honored: the messages surface serves the main agent only, so `agents`
    // always carries exactly `main`.
    const [status, messages] = await Promise.all([
      this.http.getSessionStatus(input.id),
      collectReplayMessages(
        (beforeId) => this.http.getMessages(input.id, { before_id: beforeId, limit: 100 }),
        snapshot.messages,
        input.replayTurnLimit,
      ),
    ]);
    return {
      ...wireSessionToSummary(snapshot.session),
      sessionMetadata: snapshotToSessionMeta(snapshot),
      agents: {
        main: buildResumedMainAgentState(snapshot, status, messages, input.replayTurnLimit),
      },
      warning: undefined,
    };
  }

  /**
   * Local detach ONLY — unsubscribe the event cursor, drop the registered
   * interaction handlers, and forget the bridge's dedupe/queued state so a
   * later reattach re-presents still-pending interactions. No HTTP call: the
   * server-side session keeps running and stays resumable. This is the wire
   * transport's core ownership rule.
   */
  override async closeSession(input: SessionIdRpcInput): Promise<void> {
    await this.supervisor.unsubscribe(input.sessionId);
    this.clearSessionHandlers(input.sessionId);
    this.bridge.forgetSession(input.sessionId);
  }

  override async deleteSession(input: SessionIdRpcInput): Promise<void> {
    await this.http.sessionAction(input.sessionId, 'archive');
  }

  override async renameSession(input: RenameSessionInput): Promise<void> {
    await this.http.updateSessionProfile(input.id, { title: input.title });
  }

  /**
   * `forkId` / `turnIndex` have no wire equivalent (the server mints the id
   * and forks the whole session); only `title` / `metadata` cross.
   */
  override async forkSession(input: ForkSessionInput): Promise<SessionSummary> {
    const forked = await this.http.forkSession(input.id, {
      title: input.title,
      metadata: input.metadata,
    });
    return wireSessionToSummary(forked);
  }

  // -----------------------------------------------------------------------
  // Turns and state
  //
  // M1 scope note: the prompt route's `agent_id` is never sent, so every
  // override below addresses the session's main agent regardless of
  // `withInteractiveAgent` — subagent targeting arrives with the agents view.
  // -----------------------------------------------------------------------

  override async prompt(input: WirePromptRpcInput): Promise<void> {
    const permissionMode = this.pendingPermissions.get(input.sessionId);
    await this.http.submitPrompt(input.sessionId, {
      content: input.input.map(toWireContent),
      disabled_tools: input.disabledTools,
      model: input.model,
      profile: input.profile,
      permission_mode: permissionMode,
    });
    // Cleared only after a successful submission: a failed prompt must not
    // silently drop the caller's mode change.
    if (permissionMode !== undefined) this.pendingPermissions.delete(input.sessionId);
  }

  /**
   * SDK steer = inject content into the running turn. The wire expresses this
   * as submit-then-steer: the prompt queues behind the active turn and
   * `prompts::steer` moves it in. On an idle session the submission starts a
   * turn directly (v1's idle-steer-launches-a-turn semantics), so no steer
   * call follows.
   */
  override async steer(input: WirePromptRpcInput): Promise<void> {
    const permissionMode = this.pendingPermissions.get(input.sessionId);
    const submitted = await this.http.submitPrompt(input.sessionId, {
      content: input.input.map(toWireContent),
      model: input.model,
      profile: input.profile,
      permission_mode: permissionMode,
    });
    if (permissionMode !== undefined) this.pendingPermissions.delete(input.sessionId);
    if (submitted.status === 'queued') {
      await this.http.steerPrompts(input.sessionId, { prompt_ids: [submitted.prompt_id] });
    }
  }

  override async cancel(input: SessionIdRpcInput): Promise<void> {
    await this.http.sessionAction(input.sessionId, 'abort');
  }

  override async getStatus(input: SessionIdRpcInput): Promise<SessionStatus> {
    return wireStatusToSessionStatus(await this.http.getSessionStatus(input.sessionId));
  }

  /**
   * M1: the newest message page only (no `before_id` paging) with the live
   * context token count from the status surface. The TUI's replay path (M4)
   * will specify exactly what it needs; refine then.
   */
  override async getContext(input: SessionIdRpcInput): Promise<AgentContextData> {
    const [{ items }, status] = await Promise.all([
      this.http.getMessages(input.sessionId),
      this.http.getSessionStatus(input.sessionId),
    ]);
    return { history: items.map(wireMessageToContextMessage), tokenCount: status.context_tokens };
  }

  override async getUsage(input: SessionIdRpcInput): Promise<SessionUsage> {
    const session = await this.http.getSession(input.sessionId);
    return wireUsageToSessionUsage(session.usage);
  }

  override async compact(input: SessionIdRpcInput & CompactOptions): Promise<void> {
    await this.http.compactSession(input.sessionId, { instruction: input.instruction });
  }

  override async undoHistory(input: SessionIdRpcInput & { count: number }): Promise<void> {
    await this.http.undoSession(input.sessionId, { count: input.count });
  }

  override async getSessionWarnings(input: SessionIdRpcInput) {
    return this.http.getSessionWarnings(input.sessionId);
  }

  // -----------------------------------------------------------------------
  // Workspace trust (wire-only — the base surface has no trust concept)
  // -----------------------------------------------------------------------

  /**
   * Resolve the session's workspace and read its trust state. A session the
   * server doesn't know maps to `undefined` — the 40401 (session.not_found)
   * envelope is contained here so the agents view can treat a vanished row as
   * "no trust info"; every other failure propagates.
   */
  async getWorkspaceTrustForSession(sessionId: string): Promise<boolean | undefined> {
    let session: WireSession;
    try {
      session = await this.http.getSession(sessionId);
    } catch (error) {
      if (error instanceof EnvelopeError && error.code === 40401) return undefined;
      throw error;
    }
    return this.http.getWorkspaceTrust(session.workspace_id);
  }

  // -----------------------------------------------------------------------
  // Degrade surface
  //
  // The TUI reads these unconditionally on startup/attach; kap-server has no
  // routes backing them, so they degrade to empty values instead of loud
  // not_implemented failures.
  // -----------------------------------------------------------------------

  /** wire degrade: kap-server has no plugin routes (design §4.1). */
  override async listPlugins(): Promise<readonly PluginSummary[]> {
    return [];
  }

  /** wire degrade: kap-server has no plugin routes (design §4.1). */
  override async listPluginCommands(
    input: SessionIdRpcInput,
  ): Promise<readonly PluginCommandDef[]> {
    void input;
    return [];
  }

  /**
   * wire degrade: kap-server has no plugin routes (design §4.1). Skills get a
   * server-side route later; revisit when kap-server exposes one.
   */
  override async listSkills(input: SessionIdRpcInput): Promise<readonly SkillSummary[]> {
    void input;
    return [];
  }

  /** wire degrade: kap-server has no plugin routes (design §4.1). */
  override async getMcpStartupMetrics(input: SessionIdRpcInput): Promise<McpStartupMetrics> {
    void input;
    return { durationMs: 0 };
  }

  /**
   * The wire has no standalone setPermission verb (design §4.1): the mode is
   * stored per session and rides the next prompt/steer submission as
   * `permission_mode`, then clears.
   */
  override async setPermission(input: SetSessionPermissionRpcInput): Promise<void> {
    this.pendingPermissions.set(input.sessionId, input.mode);
  }

  /**
   * The supervisor announced this session's cursor is unrecoverable: reload
   * the snapshot, re-subscribe at the new watermark, and re-feed pending
   * interactions. Fire-and-forget from the resync callback, so failures are
   * contained here — the next reconnect's resync will retry.
   */
  private async resyncSession(sessionId: string): Promise<void> {
    try {
      const snapshot = await this.http.getSnapshot(sessionId);
      await this.supervisor.subscribe(sessionId, {
        seq: snapshot.as_of_seq,
        epoch: snapshot.epoch,
      });
      this.bridge.replayPending(sessionId, snapshot);
    } catch {
      // Contained: a failed resync leaves the session unsubscribed, and the
      // supervisor's reconnect path keeps the client alive regardless.
    }
  }
}

/** Best-effort v1 `SessionMeta` from a wire snapshot (M1: no agent roster). */
function snapshotToSessionMeta(snapshot: WireSnapshot): ResumedSessionSummary['sessionMetadata'] {
  const session = snapshot.session;
  return {
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    title: session.title,
    isCustomTitle: false,
    lastPrompt: session.last_prompt,
    workDir: session.metadata.cwd,
    agents: {},
    custom: session.metadata as Record<string, unknown>,
  };
}
