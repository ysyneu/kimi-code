/**
 * WS connection for kap-server's `/api/v1/ws` — owns the socket, performs the
 * `server_hello` → `client_hello` → ack handshake, correlates control-message
 * acks back to their sender by `id`, and fans every other frame out to
 * subscribers.
 *
 * Ported from `packages/klient/test/e2e/harness/ws.ts` with these changes:
 * bearer auth rides the `Authorization` header, reporting and the unmatched-frame
 * queue are gone (a dropped frame is a bug and only logged), and batched
 * messages (a JSON array of frames) are unpacked element by element.
 */
import { WebSocket } from 'ws';
import { z } from 'zod';

import {
  wsEventFrameSchema,
  wsFrameSchema,
  type WsEventFrame,
  type WsFrame,
} from './protocol';

/**
 * Frame as delivered to `onFrame` handlers and waiters: the control/ack fields
 * plus the event cursor fields (`seq` / `session_id` / `epoch` / `volatile` /
 * `offset`) when the frame is an event envelope. Parsing never strips unknown
 * keys (forward-compat), so extra server fields pass through too.
 */
export type WsIncomingFrame = WsFrame &
  Partial<Pick<WsEventFrame, 'seq' | 'epoch' | 'volatile' | 'offset' | 'session_id'>>;

// Plain `z.object` strips undeclared keys; both schemas get a catchall so
// event cursor fields (and any future server fields) survive parsing.
const incomingEventFrameSchema = wsEventFrameSchema.catchall(z.unknown());
const incomingControlFrameSchema = wsFrameSchema.catchall(z.unknown());

/** Payload of the server's `server_hello` frame. */
export interface WsServerHello {
  readonly ws_connection_id: string;
  readonly protocol_version: number;
  readonly max_event_buffer_size: number;
}

export interface WsCloseInfo {
  readonly code: number;
  readonly reason: string;
}

export type WsLogger = (
  level: 'info' | 'warn' | 'error' | 'debug',
  msg: string,
  meta?: unknown,
) => void;

export interface WsConnectionOptions {
  readonly url: string;
  readonly token: string;
  /** Stable id for `client_hello`; generated when omitted. */
  readonly clientId?: string;
  readonly logger?: WsLogger;
}

/**
 * Structural subset of {@link WsConnection} consumed by reconnect/supervision
 * layers, so they can be driven by a fake in tests.
 */
export interface WsConnectionLike {
  connect(): Promise<WsServerHello>;
  sendControl<T>(type: string, payload: unknown): Promise<T>;
  onFrame(handler: (frame: WsIncomingFrame) => void): () => void;
  onClose(handler: (info: WsCloseInfo) => void): () => void;
  close(): Promise<void>;
}

type FrameWaiter = (frame: WsIncomingFrame) => boolean;

interface PendingWaiter {
  match: FrameWaiter;
  resolve: (frame: WsIncomingFrame) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 10_000;

const noopLogger: WsLogger = () => {};

export class WsConnection implements WsConnectionLike {
  private ws: WebSocket | null = null;
  private readonly waiters: PendingWaiter[] = [];
  private readonly frameHandlers = new Set<(frame: WsIncomingFrame) => void>();
  private readonly closeHandlers = new Set<(info: WsCloseInfo) => void>();
  private readonly clientId: string;
  private readonly logger: WsLogger;
  private closed = false;
  private closeInfo: WsCloseInfo | null = null;
  private closeWaiters: Array<(info: WsCloseInfo) => void> = [];

  constructor(private readonly options: WsConnectionOptions) {
    this.clientId = options.clientId ?? `client-${crypto.randomUUID()}`;
    this.logger = options.logger ?? noopLogger;
  }

  /**
   * Open the socket, wait for `server_hello`, answer with `client_hello`, and
   * resolve with the hello payload once the server acks the handshake.
   */
  async connect(): Promise<WsServerHello> {
    // Register the waiter BEFORE opening: `server_hello` can be emitted in the
    // same macrotask as `open`, ahead of any post-`await` continuation.
    const helloFramePromise = this.waitForFrame(
      (frame) => frame.type === 'server_hello',
      DEFAULT_TIMEOUT_MS,
    );
    // Swallow the waiter's rejection if the socket never opens (e.g. a 401 at
    // the upgrade) — `open()`'s own rejection is the one the caller sees.
    helloFramePromise.catch(() => {});
    await this.open();
    const helloFrame = await helloFramePromise;
    await this.hello(this.clientId);
    return helloFrame.payload as WsServerHello;
  }

  /** Send `client_hello` and require a `code === 0` ack. Exposed for reconnects. */
  async hello(clientId: string): Promise<void> {
    await this.sendControl<unknown>('client_hello', { client_id: clientId });
  }

  /** Send a control frame and await its ack (matched by `id`); throws on `code !== 0`. */
  async sendControl<T>(type: string, payload: unknown): Promise<T> {
    const id = `ctl-${crypto.randomUUID()}`;
    const ackPromise = this.waitForFrame(
      (frame) => frame.type === 'ack' && frame.id === id,
      DEFAULT_TIMEOUT_MS,
    );
    this.send({ type, id, payload });
    const ack = await ackPromise;
    if (ack.code !== 0) {
      throw new Error(`ws control '${type}' rejected (code=${ack.code}): ${ack.msg ?? ''}`);
    }
    return ack.payload as T;
  }

  /** Register a frame subscriber. Returns an unsubscribe handle. */
  onFrame(handler: (frame: WsIncomingFrame) => void): () => void {
    this.frameHandlers.add(handler);
    return () => {
      this.frameHandlers.delete(handler);
    };
  }

  /** Register a close subscriber. Returns an unsubscribe handle. */
  onClose(handler: (info: WsCloseInfo) => void): () => void {
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  /** Initiate close from the client side and wait for the socket to close. */
  async close(): Promise<void> {
    if (!this.ws || this.closed) return;
    this.ws.close();
    await this.waitClosed();
  }

  /** Open the socket; resolves once `open` fires, rejects on upgrade errors (e.g. 401). */
  private async open(): Promise<void> {
    if (this.ws) return;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.options.url, {
        headers: { authorization: `Bearer ${this.options.token}` },
      });
      this.ws = ws;
      ws.once('open', () => resolve());
      ws.once('error', (err) => {
        if (this.closed) return;
        reject(err);
      });
      ws.on('message', (data) => this.handleMessage(data));
      ws.on('close', (code, reason) => this.handleClose(code, String(reason ?? '')));
    });
  }

  private send(frame: object): void {
    if (!this.ws) throw new Error('ws not open');
    this.ws.send(JSON.stringify(frame));
  }

  /**
   * Wait for the next frame matching `predicate`. Waiters are single-shot and
   * reject on close or timeout. There is no unmatched-frame queue: frames that
   * match no waiter only reach `onFrame` subscribers.
   */
  private waitForFrame(predicate: FrameWaiter, timeoutMs: number): Promise<WsIncomingFrame> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error(`ws closed before matching frame arrived (code=${this.closeInfo?.code})`));
        return;
      }
      const waiter: PendingWaiter = {
        match: predicate,
        resolve: (frame) => {
          if (waiter.timer) clearTimeout(waiter.timer);
          resolve(frame);
        },
        reject: (err) => {
          if (waiter.timer) clearTimeout(waiter.timer);
          reject(err);
        },
      };
      waiter.timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`waitForFrame timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  private waitClosed(): Promise<WsCloseInfo> {
    if (this.closeInfo) return Promise.resolve(this.closeInfo);
    return new Promise((resolve) => {
      this.closeWaiters.push(resolve);
    });
  }

  private handleMessage(data: unknown): void {
    let parsed: unknown;
    try {
      const raw = typeof data === 'string' ? data : String(data);
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger('warn', 'ws: dropped non-JSON frame', { err: String(err) });
      return;
    }
    // The server may flush subscription traffic as a JSON array of frames.
    if (Array.isArray(parsed)) {
      for (const element of parsed) this.dispatchFrame(element);
      return;
    }
    this.dispatchFrame(parsed);
  }

  private dispatchFrame(raw: unknown): void {
    // Event envelopes carry a numeric `seq`; control/ack frames never do.
    const isEvent =
      typeof raw === 'object' &&
      raw !== null &&
      typeof (raw as { seq?: unknown }).seq === 'number';
    const result = isEvent
      ? incomingEventFrameSchema.safeParse(raw)
      : incomingControlFrameSchema.safeParse(raw);
    if (!result.success) {
      this.logger('warn', 'ws: dropped malformed frame', { err: result.error.message });
      return;
    }
    const frame: WsIncomingFrame = result.data;

    if (frame.type === 'ping') {
      this.send({ type: 'pong', payload: { nonce: pingNonce(frame) } });
    }

    // Subscribers observe every frame, regardless of whether a waiter consumes it.
    for (const handler of this.frameHandlers) {
      try {
        handler(frame);
      } catch (err) {
        this.logger('warn', 'ws: frame handler threw', { err: String(err) });
      }
    }

    // The first waiter whose predicate matches consumes the frame (single-shot).
    for (let i = 0; i < this.waiters.length; i++) {
      const waiter = this.waiters[i];
      if (waiter === undefined) continue;
      let matches = false;
      try {
        matches = waiter.match(frame);
      } catch (err) {
        this.logger('warn', 'ws: waiter predicate threw', { err: String(err) });
      }
      if (matches) {
        this.waiters.splice(i, 1);
        waiter.resolve(frame);
        return;
      }
    }
    this.logger('debug', 'ws: frame matched no waiter', { type: frame.type });
  }

  private handleClose(code: number, reason: string): void {
    this.closed = true;
    this.closeInfo = { code, reason };
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(new Error(`ws closed (code=${code}) before matching frame arrived`));
    }
    for (const resolve of this.closeWaiters.splice(0)) resolve(this.closeInfo);
    for (const handler of this.closeHandlers) {
      try {
        handler(this.closeInfo);
      } catch (err) {
        this.logger('warn', 'ws: close handler threw', { err: String(err) });
      }
    }
  }
}

function pingNonce(frame: WsFrame): string {
  const payload = frame.payload as { nonce?: unknown } | undefined;
  return typeof payload?.nonce === 'string' ? payload.nonce : '';
}
