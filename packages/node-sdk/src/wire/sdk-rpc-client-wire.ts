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
 * Deliberate wire-transport semantics:
 * - `closeSession` is a LOCAL DETACH ONLY (unsubscribe + drop the registered
 *   handlers + drop the bridge's dedupe/queued state + drop any armed-but-
 *   unsent permission/plan-mode override) — no HTTP call, the server-side
 *   session stays alive and resumable, and a later reattach re-presents
 *   interactions that are still pending. The wire has no per-connection
 *   session-close verb, and the daemon owns the session lifetime.
 *   `deleteSession` drops the same overrides.
 * - `deleteSession` maps to `:archive` (the wire's only session-removal verb).
 * - Turns and state reads map onto the prompts / status / messages REST
 *   surface: `steer` is submit-then-`prompts:steer`, `cancel` is `:abort`,
 *   `compact` / `undoHistory` are `:compact` / `:undo`, and `getContext`
 *   serves the newest message page only. `agent_id` is never sent — every
 *   turn override addresses the main agent.
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
import { createWriteStream, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  AGENT_WIRE_PROTOCOL_VERSION,
  ErrorCodes,
  KimiError,
  noopTelemetryClient,
} from '@moonshot-ai/agent-core';
import type { AgentContextData } from '@moonshot-ai/agent-core';
import { ensureKimiHome, resolveConfigPath, resolveKimiHome } from '@moonshot-ai/agent-core-v2';
import { assertKimiHostIdentity } from '@moonshot-ai/kimi-code-oauth';

import { KimiAuthFacade } from '#/auth';
import type { ApprovalHandler, QuestionHandler } from '#/events';
import {
  SDKRpcClientBase,
  type ActivateSkillRpcInput,
  type SessionIdRpcInput,
  type SessionPromptRpcInput,
  type SetSessionModelRpcInput,
  type SetSessionModelRpcResult,
  type SetSessionPermissionRpcInput,
  type SetSessionPlanModeRpcInput,
  type SetSessionThinkingRpcInput,
} from '#/rpc';
import type {
  AgentBackgroundTaskInfo,
  BackgroundTaskInfo,
  CompactOptions,
  CreateSessionOptions,
  ExportSessionInput,
  ExportSessionResult,
  ForkSessionInput,
  GetConfigOptions,
  GoalToolResult,
  JsonObject,
  KimiConfig,
  KimiConfigPatch,
  KimiHostIdentity,
  ListSessionsOptions,
  McpServerInfo,
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
  WireConfig,
  WireProviderConfig,
  WireSession,
  WireSessionStatus,
  WireSessionUsage,
  WireSkill,
  WireSnapshot,
  WireTask,
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
    lastAssistantText: session.last_assistant_text,
    workDir: session.metadata.cwd,
    sessionDir: '',
    createdAt: Date.parse(session.created_at),
    updatedAt: Date.parse(session.updated_at),
    archived: session.archived,
    metadata: session.metadata as JsonObject,
  };
}

/** `WireSkill` → the v1 `SkillSummary` the SDK surface serves. */
function wireSkillToSummary(skill: WireSkill): SkillSummary {
  return {
    name: skill.name,
    description: skill.description,
    path: skill.path,
    source: skill.source,
    type: skill.type,
    disableModelInvocation: skill.disable_model_invocation,
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function snakeToCamel(key: string): string {
  return key.replaceAll(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

function camelToSnake(key: string): string {
  return key.replaceAll(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

/**
 * `WireProviderConfig` (redacted: `has_api_key` only) → the closest
 * `ProviderConfig`-shaped read. The wire never returns the real credential —
 * `apiKey` / `oauth` are left unset, matching what the route actually redacts.
 */
function wireProviderToProviderConfig(provider: WireProviderConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { type: provider.type };
  if (provider.base_url !== undefined) out['baseUrl'] = provider.base_url;
  if (provider.default_model !== undefined) out['defaultModel'] = provider.default_model;
  return out;
}

/**
 * `WireConfig` → `KimiConfig`. Mirrors kap-server's `toConfigResponse`
 * exactly: a shallow top-level key conversion (only the domain name is
 * snake_cased on the wire; each domain's VALUE already arrives camelCase),
 * plus the same `providers` redaction reversed on read.
 */
function wireConfigToKimiConfig(config: WireConfig): KimiConfig {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === 'providers') {
      const providers: Record<string, unknown> = {};
      for (const [id, provider] of Object.entries(value as Record<string, WireProviderConfig>)) {
        providers[id] = wireProviderToProviderConfig(provider);
      }
      out['providers'] = providers;
      continue;
    }
    out[snakeToCamel(key)] = value;
  }
  return out as KimiConfig;
}

/**
 * `KimiConfigPatch` → the `POST /config` request body. The route
 * (`convertKeysSnakeToCamel`) recursively snake_cases every key at every
 * depth before dispatching per-domain patches, so the patch is converted the
 * other way at every depth too, or it would not round-trip.
 */
function kimiConfigPatchToWirePatch(patch: KimiConfigPatch): Record<string, unknown> {
  return toSnakeCaseDeep(patch) as Record<string, unknown>;
}

function toSnakeCaseDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toSnakeCaseDeep);
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[camelToSnake(key)] = toSnakeCaseDeep(v);
    return out;
  }
  return value;
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
    busy: status.busy,
  };
}

/**
 * `WireSessionUsage` → the SDK `SessionUsage`. The wire row only carries
 * session totals — no per-model or current-turn split.
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

/**
 * `WireTask` (subagent-kind only) → v1 `AgentBackgroundTaskInfo`. Mirrors
 * resume-replay's `wireSubagentToBackgroundTaskInfo`: `bash` tasks map to
 * v1's `process` kind, whose required `pid` this route's `Task` shape never
 * carries, and `tool` tasks (kap-server's kind for question-driven flows)
 * map to v1's `question` kind, whose required `questionCount` isn't on the
 * wire either — both are dropped rather than fabricated.
 */
function wireTaskToBackgroundTaskInfo(task: WireTask): AgentBackgroundTaskInfo | undefined {
  if (task.kind !== 'subagent') return undefined;
  return {
    kind: 'agent',
    taskId: task.id,
    description: task.description,
    status: task.status === 'cancelled' ? 'killed' : task.status,
    startedAt: Date.parse(task.started_at ?? task.created_at),
    endedAt: task.completed_at !== undefined ? Date.parse(task.completed_at) : null,
    agentId: task.id,
  };
}

/**
 * Mirrors v1's `defaultExportZipName` (agent-core's session-export.ts) so a
 * caller who omits `outputPath` gets the same filename shape regardless of
 * transport.
 */
function defaultDebugExportZipName(sessionId: string, now: Date): string {
  const shortId = sessionId.slice(0, 8);
  const timestamp = now.toISOString().replaceAll(/[-:]/g, '').replace(/T/, '-').slice(0, 15);
  return `kimi-debug-${shortId}-${timestamp}.zip`;
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
    // The wire list filters by workspace id, not workDir; this transport lists
    // everything and leaves bucket filtering to the caller (matching the daemon
    // clients).
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
    // The explicit agent options are dropped by the create route the same
    // way; apply them through the `agent_config` profile patch `setModel` /
    // `setPermission` already use, mirroring the in-process transports that
    // bind the requested model/thinking/permission at create time. Options
    // left unset keep the server-side defaults: the config `default_model`
    // binds at the first turn (kap-server's `ensureMainAgentBound`) and the
    // config default permission mode applies at agent materialization.
    if (
      input.model !== undefined ||
      input.thinking !== undefined ||
      input.permission !== undefined
    ) {
      await this.http.updateSessionProfile(created.id, {
        agent_config: {
          model: input.model,
          thinking: input.thinking,
          permission_mode: input.permission,
        },
      });
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
    // keeping the wire attach order intact. `includeSubagents` cannot be
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
   * Session diagnostic archive. SHAPE MISMATCH, handled honestly: the base
   * RPC writes a session directory to a local zip with a rich manifest
   * (`outputPath` + diagnostics fields); the route
   * (`POST /sessions/{id}/export`) instead streams a zip archive over HTTP
   * with no manifest of its own reachable from the response. This downloads
   * the stream to `outputPath` (defaulting to the same
   * `kimi-debug-<shortId>-<timestamp>.zip` name v1 uses when the caller
   * omits one) and returns the shape `exportSession`'s only real caller
   * (`handleExportDebugZipCommand`, apps/kimi-code's session slash commands)
   * actually reads — `zipPath` — with the rest honestly degraded:
   *   - `entries` is always `[]`: the route answers a raw zip stream with no
   *     entry manifest, and unzipping it just to list entries is out of
   *     scope for a thin wire override.
   *   - `sessionDir` is `''`, matching every other wire-transport read (the
   *     server never exposes its on-disk layout over the wire).
   *   - `manifest` is reconstructed from what THIS request/environment
   *     actually knows (`sessionId`, the caller's `version` /
   *     `installSource` / `shellEnv`, this process's `os` / `nodejsVersion`,
   *     and the real `AGENT_WIRE_PROTOCOL_VERSION` constant) — never
   *     fabricated. The fields that live inside the archive's OWN manifest
   *     (`title`, `workspaceDir`, activity timestamps, log paths) are not
   *     reachable without unzipping and are left `undefined`.
   * The route's request body only accepts `web_log` / `desktop`, neither of
   * which `ExportSessionInput` carries: `includeGlobalLog` / `version` /
   * `installSource` / `shellEnv` cannot reach the server at all — it always
   * bundles its own global log and stamps its own host identity version
   * into the archive's real (in-zip) manifest regardless of what the caller
   * passes here.
   */
  override async exportSession(input: ExportSessionInput): Promise<ExportSessionResult> {
    const now = new Date();
    const outputPath = input.outputPath ?? resolve(defaultDebugExportZipName(input.id, now));
    const stream = await this.http.exportSession(input.id);
    await mkdir(dirname(outputPath), { recursive: true });
    await pipeline(stream, createWriteStream(outputPath));
    return {
      zipPath: outputPath,
      entries: [],
      sessionDir: '',
      manifest: {
        sessionId: input.id,
        exportedAt: now.toISOString(),
        kimiCodeVersion: input.version,
        wireProtocolVersion: AGENT_WIRE_PROTOCOL_VERSION,
        os: process.platform,
        nodejsVersion: process.version,
        installSource: input.installSource,
        shellEnv: input.shellEnv,
      },
    };
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
  // Wire scope note: the prompt route's `agent_id` is never sent, so every
  // override below addresses the session's main agent regardless of
  // `withInteractiveAgent` — subagent targeting arrives with the agents view.
  // -----------------------------------------------------------------------

  override async prompt(input: WirePromptRpcInput): Promise<void> {
    await this.http.submitPrompt(input.sessionId, {
      content: input.input.map(toWireContent),
      disabled_tools: input.disabledTools,
      model: input.model,
      profile: input.profile,
    });
  }

  /**
   * SDK steer = inject content into the running turn. The wire expresses this
   * as submit-then-steer: the prompt queues behind the active turn and
   * `prompts:steer` moves it in. On an idle session the submission starts a
   * turn directly (v1's idle-steer-launches-a-turn semantics), so no steer
   * call follows.
   */
  override async steer(input: WirePromptRpcInput): Promise<void> {
    const submitted = await this.http.submitPrompt(input.sessionId, {
      content: input.input.map(toWireContent),
      model: input.model,
      profile: input.profile,
    });
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
   * The newest message page only (no `before_id` paging) with the live
   * context token count from the status surface.
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

  override async getGoal(input: SessionIdRpcInput): Promise<GoalToolResult> {
    return { goal: await this.http.getSessionGoal(input.sessionId) };
  }

  /**
   * Start the session's side-channel "by the way" agent, resolving to the
   * started agent id — `POST /sessions/{id}:btw`. `agent_id` is never sent,
   * matching every other turn override above.
   */
  override async startBtw(input: SessionIdRpcInput): Promise<string> {
    return (await this.http.startBtw(input.sessionId)).agent_id;
  }

  /**
   * Background tasks for the session's main agent — `GET
   * /sessions/{id}/tasks`. Only `subagent`-kind tasks survive the wire
   * projection into `BackgroundTaskInfo` — see `wireTaskToBackgroundTaskInfo`
   * above for why `bash` / `tool` tasks are dropped instead of fabricated.
   * `activeOnly` maps onto the route's `status` filter (`running` is the
   * only non-terminal wire status); `limit` has no route query parameter,
   * so it caps the mapped result client-side instead of being dropped.
   */
  override async listBackgroundTasks(
    input: SessionIdRpcInput & { activeOnly?: boolean; limit?: number },
  ): Promise<readonly BackgroundTaskInfo[]> {
    const items = await this.http.listTasks(input.sessionId, {
      status: input.activeOnly === true ? 'running' : undefined,
    });
    const mapped = items
      .map(wireTaskToBackgroundTaskInfo)
      .filter((info): info is AgentBackgroundTaskInfo => info !== undefined);
    return input.limit === undefined ? mapped : mapped.slice(0, input.limit);
  }

  /**
   * A background task's buffered output — `GET
   * /sessions/{id}/tasks/{task_id}` with `with_output=true`. The base
   * method's `tail` option (its only output-size input) maps onto the
   * route's `output_bytes` query param; omitted, the route falls back to
   * its own 32 KiB default instead of this client picking one.
   */
  override async getBackgroundTaskOutput(
    input: SessionIdRpcInput & { taskId: string; tail?: number },
  ): Promise<string> {
    const task = await this.http.getTask(input.sessionId, input.taskId, {
      with_output: true,
      output_bytes: input.tail,
    });
    return task.output_preview ?? '';
  }

  /**
   * Stop a background task — `POST /sessions/{id}/tasks/{task_id}:cancel`
   * (its handler calls `stopByUser`, i.e. stop semantics despite the
   * `:cancel` name). The route accepts no body, so `reason` cannot be
   * forwarded to the server and is unused here.
   */
  override async stopBackgroundTask(
    input: SessionIdRpcInput & { taskId: string; reason?: string },
  ): Promise<void> {
    await this.http.cancelTask(input.sessionId, input.taskId);
  }

  /**
   * Skill activation — REST analogue of the `/<skill>` slash command
   * (`POST /sessions/{id}/skills/{name}:activate`). The base surface had no
   * wire override for this method: every call fell through to `getRpc()`
   * and threw `not_implemented` unconditionally, so skill dispatch from the
   * agents view — which always talks over the wire — has never worked.
   * `agent_id` is never sent, matching every other turn override above.
   */
  override async activateSkill(input: ActivateSkillRpcInput): Promise<void> {
    await this.http.activateSkill(input.sessionId, input.name, { args: input.args });
  }

  // -----------------------------------------------------------------------
  // Config
  //
  // None of these four was overridden: every call fell through to getRpc()
  // and threw not_implemented unconditionally, so `/login`'s post-auth config
  // refresh and model activation always failed on the wire transport
  // ("Authentication successful, but failed to refresh config: [not_implemented]
  // This SDK method is not available on the wire transport.").
  // -----------------------------------------------------------------------

  /** Global Kimi configuration, secrets redacted — `GET /config`. */
  override async getConfig(input?: GetConfigOptions): Promise<KimiConfig> {
    // The server owns the config file and always answers with the live
    // value, so there is nothing for a `reload` flag to force here.
    void input;
    return wireConfigToKimiConfig(await this.http.getConfig());
  }

  /** Patch the global Kimi configuration (merge semantics) — `POST /config`. */
  override async setConfig(input: KimiConfigPatch): Promise<KimiConfig> {
    return wireConfigToKimiConfig(await this.http.setConfig(kimiConfigPatchToWirePatch(input)));
  }

  /**
   * Apply a model change to the session's main agent —
   * `POST /sessions/{id}/profile` with `agent_config.model`.
   */
  override async setModel(input: SetSessionModelRpcInput): Promise<SetSessionModelRpcResult> {
    await this.http.setModel(input.sessionId, input.model);
    return { model: input.model };
  }

  /**
   * Apply a thinking-effort change to the session's main agent —
   * `POST /sessions/{id}/profile` with `agent_config.thinking`.
   */
  override async setThinking(input: SetSessionThinkingRpcInput): Promise<void> {
    await this.http.setThinking(input.sessionId, input.effort);
  }

  /**
   * Delete a provider and read the resulting config —
   * `DELETE /providers/{provider_id}` (kap-server's modelCatalog route). The
   * route answers 204 with no body on success, so the resulting `KimiConfig`
   * is read back through the same `getConfig` path used elsewhere on this
   * transport rather than parsed off the delete response.
   */
  override async removeProvider(providerId: string): Promise<KimiConfig> {
    await this.http.deleteProvider(providerId);
    return wireConfigToKimiConfig(await this.http.getConfig());
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

  /**
   * Skills visible to a new session in `workDir`, without creating one — the
   * base surface had no wire override for this, so every call fell through
   * to `getRpc()` and threw `not_implemented` unconditionally (the agents-
   * view dispatch menu's skill warm-up has never actually worked live). The
   * server route (`GET /workspaces/{workspace_id}/skills`) takes a
   * REGISTERED workspace id, not a raw path, so `workDir` is registered
   * (idempotently — same `createOrTouch` semantics `POST /sessions` already
   * relies on for `metadata.cwd`) first, so a `kimi agents` launch in a
   * directory with no prior session still resolves instead of 404-ing as
   * `workspace.not_found`.
   */
  override async listWorkspaceSkills(workDir: string): Promise<readonly SkillSummary[]> {
    const workspace = await this.http.createOrTouchWorkspace(workDir);
    const skills = await this.http.listWorkspaceSkills(workspace.id);
    return skills.map(wireSkillToSummary);
  }

  // -----------------------------------------------------------------------
  // Session rows + connection state (wire-only — the base surface drops both)
  // -----------------------------------------------------------------------

  /**
   * The full wire rows behind {@link listSessions}: `SessionSummary` drops
   * `busy` / `pending_interaction` / `last_turn_reason`, and the global
   * `work_changed` fan-out is change-driven only (no connect-time snapshot),
   * so a cold-open roster or a post-reconnect reconciliation seeds from
   * these rows instead.
   */
  async listSessionRows(): Promise<readonly WireSession[]> {
    const page = await this.http.listSessions({ workspace_id: undefined });
    return page.items;
  }

  /**
   * Observe the WS connection state; `true` fires on every successful
   * (re)connect. Global fan-out events have no journal, so whatever they
   * carried during a drop is lost — consumers re-seed on the reconnect edge.
   * Returns an unsubscribe handle.
   */
  onConnectionState(handler: (connected: boolean) => void): () => void {
    return this.supervisor.connectionState(handler);
  }

  // -----------------------------------------------------------------------
  // Degrade surface
  //
  // The TUI reads these unconditionally on startup/attach; kap-server has no
  // routes backing them, so they degrade to empty values instead of loud
  // not_implemented failures.
  // -----------------------------------------------------------------------

  /** wire degrade: kap-server has no plugin routes. */
  override async listPlugins(): Promise<readonly PluginSummary[]> {
    return [];
  }

  /** wire degrade: kap-server has no plugin routes. */
  override async listPluginCommands(
    input: SessionIdRpcInput,
  ): Promise<readonly PluginCommandDef[]> {
    void input;
    return [];
  }

  /**
   * wire degrade: kap-server has no plugin routes. Skills get a
   * server-side route later; revisit when kap-server exposes one.
   */
  override async listSkills(input: SessionIdRpcInput): Promise<readonly SkillSummary[]> {
    void input;
    return [];
  }

  /** wire degrade: kap-server has no session-scoped MCP route. */
  override async listMcpServers(): Promise<readonly McpServerInfo[]> {
    return [];
  }

  /** wire degrade: kap-server has no plugin routes. */
  override async getMcpStartupMetrics(input: SessionIdRpcInput): Promise<McpStartupMetrics> {
    void input;
    return { durationMs: 0 };
  }

  /**
   * Permission mode rides the session profile route's `agent_config` — the
   * same immediate verb kimi-web uses — so a mid-run mode change reaches the
   * server now (and fans out to every live agent server-side) instead of
   * waiting for the next prompt submission.
   */
  override async setPermission(input: SetSessionPermissionRpcInput): Promise<void> {
    await this.http.setPermission(input.sessionId, input.mode);
  }

  /** Same immediate profile-route shape as `setPermission`, for plan mode. */
  override async setPlanMode(input: SetSessionPlanModeRpcInput): Promise<void> {
    await this.http.setPlanMode(input.sessionId, input.enabled);
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

/** Best-effort v1 `SessionMeta` from a wire snapshot (no agent roster). */
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
