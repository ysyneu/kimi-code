/**
 * CursorSupervisor — owns per-session `{seq, epoch}` cursors on top of a
 * {@link WsConnectionLike}: records one cursor per subscribed session,
 * advances them from durable event frames, reconnects with exponential
 * backoff when the socket drops (a FRESH connection per attempt), re-sends
 * ONE `subscribe` control frame carrying ALL recorded cursors after every
 * successful (re)connect, and dispatches `resync_required` to the caller.
 *
 * Ported from `apps/kimi-web/src/api/daemon/ws.ts` with the deprecated
 * inline `client_hello` subscriptions removed: reconnect = `connect()` then
 * one `subscribe` control frame.
 */
import {
  resyncRequiredPayloadSchema,
  VOLATILE_EVENT_TYPES,
  type ResyncRequiredPayload,
  type SessionCursor,
} from './protocol';
import type { WsCloseInfo, WsConnectionLike, WsIncomingFrame, WsLogger } from './ws-connection';

/**
 * Advance a session cursor from a durable event envelope. Volatile frames
 * never move the cursor (their seq is the same watermark, never ahead); a
 * stale seq only regresses the cursor while no epoch is recorded yet.
 */
export function advanceCursor(
  cursor: SessionCursor,
  frame: { seq?: number; volatile?: boolean; epoch?: string },
): SessionCursor {
  if (frame.volatile === true) return cursor;
  if (typeof frame.seq !== 'number') return cursor;
  if (frame.seq <= cursor.seq && cursor.epoch !== undefined) return cursor;
  return { seq: Math.max(frame.seq, cursor.seq), epoch: frame.epoch ?? cursor.epoch };
}

export interface CursorSupervisorOptions {
  /** Factory for a fresh, unconnected connection — called once per attempt. */
  readonly makeConnection: () => WsConnectionLike;
  /** Server announced the client is out of sync for a session; reload state. */
  readonly onResync: (sessionId: string) => void;
  readonly logger?: WsLogger;
}

/** Backoff schedule: 1s → 2s → … capped at 30s, plus 0–250ms jitter. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;
const RECONNECT_JITTER_MS = 250;

/** Frame types the connection layer already handles; never reach onEventFrame. */
const CONNECTION_FRAME_TYPES: ReadonlySet<string> = new Set([
  'ack',
  'ping',
  'pong',
  'server_hello',
]);

const noopLogger: WsLogger = () => {};

export class CursorSupervisor {
  private connection: WsConnectionLike | null = null;
  private connected = false;
  private closed = false;

  /** Sessions we manage: sessionId → last known cursor. */
  private readonly cursors = new Map<string, SessionCursor>();

  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnecting = false;

  private readonly eventHandlers = new Set<(frame: WsIncomingFrame) => void>();
  private readonly stateHandlers = new Set<(connected: boolean) => void>();
  private readonly logger: WsLogger;

  constructor(private readonly options: CursorSupervisorOptions) {
    this.logger = options.logger ?? noopLogger;
  }

  /** First connect. Throws if the first attempt fails. */
  async start(): Promise<void> {
    if (this.closed) throw new Error('CursorSupervisor is closed');
    await this.connectOnce();
  }

  /**
   * Subscribe to a session at `cursor` (default `{ seq: 0 }`). The cursor is
   * recorded immediately; when connected, a `subscribe` control frame goes out
   * now, otherwise the next successful connect carries it.
   */
  async subscribe(sessionId: string, cursor: SessionCursor = { seq: 0 }): Promise<void> {
    this.cursors.set(sessionId, cursor);
    if (!this.connected || this.connection === null) return;
    await this.connection.sendControl('subscribe', {
      session_ids: [sessionId],
      cursors: { [sessionId]: cursor },
    });
  }

  /** Unsubscribe from a session's events. */
  async unsubscribe(sessionId: string): Promise<void> {
    this.cursors.delete(sessionId);
    if (!this.connected || this.connection === null) return;
    await this.connection.sendControl('unsubscribe', { session_ids: [sessionId] });
  }

  /**
   * Register a handler for non-control frames (event envelopes carry the
   * cursor fields `seq` / `session_id` / `epoch` / `volatile`). The supervisor
   * advances the session cursor BEFORE forwarding. Returns an unsubscribe
   * handle.
   */
  onEventFrame(handler: (frame: WsIncomingFrame) => void): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  /** Register a connection-state observer. Returns an unsubscribe handle. */
  connectionState(handler: (connected: boolean) => void): () => void {
    this.stateHandlers.add(handler);
    return () => {
      this.stateHandlers.delete(handler);
    };
  }

  /** Stop reconnecting and close the current connection. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const connection = this.connection;
    this.connection = null;
    this.connected = false;
    await connection?.close();
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  /**
   * One connect attempt on a fresh connection; throws on failure. The socket
   * is only installed (`this.connection` / `connected = true`) after BOTH the
   * handshake and the resubscribe succeed — a live but subscription-less
   * socket is silent event loss, so a failed resubscribe tears the socket
   * down and counts as a failed attempt.
   */
  private async connectOnce(): Promise<void> {
    const connection = this.options.makeConnection();
    connection.onFrame((frame) => this.handleFrame(frame));
    const offClose = connection.onClose((info) => this.handleClose(info));
    await connection.connect();
    if (this.closed) {
      offClose();
      await connection.close();
      return;
    }
    try {
      await this.resubscribeAll(connection);
    } catch (err) {
      // Detach first so the deliberate teardown doesn't look like a drop.
      offClose();
      await connection.close().catch(() => {});
      throw err;
    }
    this.connection = connection;
    this.connected = true;
    this.reconnectAttempts = 0;
    this.notifyState(true);
  }

  /** Re-send ONE subscribe carrying ALL recorded cursors (reconnect contract). */
  private async resubscribeAll(connection: WsConnectionLike): Promise<void> {
    if (this.cursors.size === 0) return;
    await connection.sendControl('subscribe', {
      session_ids: [...this.cursors.keys()],
      cursors: Object.fromEntries(this.cursors),
    });
  }

  private handleClose(info: WsCloseInfo): void {
    // close() clears this.connection before closing, so a client-initiated
    // close never lands here with the supervisor still open.
    if (this.closed) return;
    this.connection = null;
    this.connected = false;
    this.notifyState(false);
    this.logger('info', 'ws-supervisor: connection closed, scheduling reconnect', {
      code: info.code,
      reason: info.reason,
    });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null || this.reconnecting) return;
    const base = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts);
    const delay = base + Math.floor(Math.random() * RECONNECT_JITTER_MS);
    this.reconnectAttempts += 1;
    this.logger('info', 'ws-supervisor: reconnect scheduled', {
      delayMs: delay,
      attempt: this.reconnectAttempts,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async reconnect(): Promise<void> {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    try {
      await this.connectOnce();
    } catch (err) {
      this.logger('warn', 'ws-supervisor: reconnect attempt failed', { err: String(err) });
    } finally {
      this.reconnecting = false;
    }
    // Every failed attempt (connect, handshake, or resubscribe) continues the
    // backoff sequence — the loop must survive a down server indefinitely.
    // Scheduling happens AFTER `reconnecting` clears, or scheduleReconnect's
    // in-flight guard would swallow the retry and stall the loop for good.
    if (!this.connected && !this.closed) this.scheduleReconnect();
  }

  // ---------------------------------------------------------------------------
  // Frame handling
  // ---------------------------------------------------------------------------

  private handleFrame(frame: WsIncomingFrame): void {
    if (CONNECTION_FRAME_TYPES.has(frame.type)) return;

    if (frame.type === 'resync_required') {
      this.handleResyncRequired(frame);
      return;
    }

    if (frame.type === 'error' && frame.session_id === undefined) {
      const payload = frame.payload as { code?: unknown; msg?: unknown } | undefined;
      this.logger('error', 'ws-supervisor: error frame', { code: payload?.code, msg: payload?.msg });
      return;
    }

    // Advance the recorded cursor BEFORE forwarding, so a handler that throws
    // can't wedge the watermark.
    const sessionId = frame.session_id;
    if (typeof sessionId === 'string') {
      const cursor = this.cursors.get(sessionId);
      if (cursor !== undefined) {
        this.cursors.set(
          sessionId,
          advanceCursor(cursor, {
            seq: frame.seq,
            volatile: frame.volatile === true || VOLATILE_EVENT_TYPES.has(frame.type),
            epoch: frame.epoch,
          }),
        );
      }
    }

    for (const handler of this.eventHandlers) {
      try {
        handler(frame);
      } catch (err) {
        this.logger('warn', 'ws-supervisor: event frame handler threw', { err: String(err) });
      }
    }
  }

  private handleResyncRequired(frame: WsIncomingFrame): void {
    const parsed = resyncRequiredPayloadSchema.safeParse(frame.payload);
    if (!parsed.success) {
      this.logger('warn', 'ws-supervisor: dropped malformed resync_required', {
        err: parsed.error.message,
      });
      return;
    }
    const payload: ResyncRequiredPayload = parsed.data;
    // Adopt the announced cursor so the next reconnect doesn't re-trigger the
    // same resync before the caller's reload lands.
    this.cursors.set(payload.session_id, { seq: payload.current_seq, epoch: payload.epoch });
    this.options.onResync(payload.session_id);
  }

  private notifyState(connected: boolean): void {
    for (const handler of this.stateHandlers) {
      try {
        handler(connected);
      } catch (err) {
        this.logger('warn', 'ws-supervisor: state handler threw', { err: String(err) });
      }
    }
  }
}
