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
 *   handlers) — no HTTP call, the server-side session stays alive and
 *   resumable. The wire has no per-connection session-close verb, and the
 *   daemon owns the session lifetime.
 * - `deleteSession` maps to `:archive` (the wire's only session-removal verb).
 * - `resumeSession` subscribes at the snapshot cursor and replays the
 *   snapshot's pending interactions into the bridge; the returned
 *   `ResumedSessionSummary` carries `agents: {}` / `warning: undefined` and a
 *   best-effort `sessionMetadata` — replay detail is refined in M4.
 * - `sessionDir` is `''` everywhere: the server never exposes its on-disk
 *   layout over the wire.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ErrorCodes, KimiError, noopTelemetryClient } from '@moonshot-ai/agent-core';
import { ensureKimiHome, resolveConfigPath, resolveKimiHome } from '@moonshot-ai/agent-core-v2';
import { assertKimiHostIdentity } from '@moonshot-ai/kimi-code-oauth';

import { KimiAuthFacade } from '#/auth';
import { SDKRpcClientBase, type SessionIdRpcInput } from '#/rpc';
import type {
  CreateSessionOptions,
  ForkSessionInput,
  JsonObject,
  KimiHostIdentity,
  ListSessionsOptions,
  OAuthRefreshOutcome,
  RenameSessionInput,
  ResumeSessionInput,
  ResumedSessionSummary,
  SessionSummary,
  TelemetryClient,
} from '#/types';

import { CursorSupervisor } from './cursor-supervisor';
import { translateWireEvent } from './event-translator';
import { WireHttpClient } from './http-client';
import type { WireSession, WireSnapshot, WsEventFrame } from './protocol';
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

export class SDKRpcClientWire extends SDKRpcClientBase {
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity: KimiHostIdentity | undefined;
  readonly telemetry: TelemetryClient;
  readonly auth: KimiAuthFacade;

  private readonly http: WireHttpClient;
  private readonly supervisor: CursorSupervisor;
  private readonly bridge: InteractionBridge;

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
    const created = await this.http.createSession({
      metadata: { cwd: input.workDir },
    });
    // No subscription: an empty session produces no events; resume/prompt
    // attaches the cursor when there is something to stream.
    return wireSessionToSummary(created);
  }

  override async resumeSession(input: ResumeSessionInput): Promise<ResumedSessionSummary> {
    const snapshot = await this.http.getSnapshot(input.id);
    await this.supervisor.subscribe(input.id, {
      seq: snapshot.as_of_seq,
      epoch: snapshot.epoch,
    });
    this.bridge.replayPending(input.id, snapshot);
    return {
      ...wireSessionToSummary(snapshot.session),
      sessionMetadata: snapshotToSessionMeta(snapshot),
      agents: {},
      warning: undefined,
    };
  }

  /**
   * Local detach ONLY — unsubscribe the event cursor and drop the registered
   * interaction handlers. No HTTP call: the server-side session keeps running
   * and stays resumable. This is the wire transport's core ownership rule.
   */
  override async closeSession(input: SessionIdRpcInput): Promise<void> {
    await this.supervisor.unsubscribe(input.sessionId);
    this.clearSessionHandlers(input.sessionId);
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
