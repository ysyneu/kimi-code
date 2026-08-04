/**
 * WsConnection against a real kap-server: handshake, ack correlation, frame
 * routing, and upgrade-time auth rejection.
 *
 * The fixture (server/home/token/wsUrl) is hoisted to file scope so the
 * follow-up cursor-supervisor tests in this lane can share one server.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  startServer,
  type RunningServer,
  type ServerHostIdentity,
} from '@moonshot-ai/kap-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { advanceCursor, CursorSupervisor } from '#/wire/cursor-supervisor';
import { WsConnection, type WsIncomingFrame } from '#/wire/ws-connection';

/** Neutral fixture identity, mirroring kap-server's own test helper. */
const TEST_HOST_IDENTITY: ServerHostIdentity = {
  productName: 'test-host',
  version: '0.0.0-test',
  platform: 'test_platform',
};

let server: RunningServer;
let home: string;
let token: string;
let wsUrl: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'kimi-sdk-wire-realtime-'));
  server = await startServer({
    hostIdentity: TEST_HOST_IDENTITY,
    host: '127.0.0.1',
    port: 0,
    homeDir: home,
    logLevel: 'silent',
  });
  token = server.authTokenService.getToken();
  wsUrl = `ws://127.0.0.1:${server.port}/api/v1/ws`;
});

afterAll(async () => {
  await server.close();
  // The server may still be flushing async writes (cache shards) at close.
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Minimal session create over plain HTTP — the lane's REST client lands separately. */
async function createSession(cwd: string): Promise<{ id: string }> {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/sessions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ metadata: { cwd } }),
  });
  const env = (await res.json()) as { code: number; data: { id: string } };
  expect(env.code).toBe(0);
  return env.data;
}

describe('WsConnection', () => {
  it('completes the handshake and round-trips subscribe acks', async () => {
    const created = await createSession(home);
    const ws = new WsConnection({ url: wsUrl, token });
    const hello = await ws.connect();
    expect(hello.protocol_version).toBe(2);
    expect(hello.ws_connection_id).toBeTruthy();
    expect(hello.max_event_buffer_size).toBeGreaterThan(0);

    const ack = await ws.sendControl<{ accepted: string[]; not_found: string[] }>('subscribe', {
      session_ids: [created.id],
    });
    expect(ack.accepted).toContain(created.id);
    expect(ack.not_found).toEqual([]);
    await ws.close();
  });

  it('receives global events without any subscription', async () => {
    const ws = new WsConnection({ url: wsUrl, token });
    await ws.connect();
    const seen = new Promise<string>((resolve) => {
      const off = ws.onFrame((frame) => {
        if (frame.type === 'event.session.created') {
          off();
          resolve(frame.type);
        }
      });
    });
    await createSession(home);
    await expect(seen).resolves.toBe('event.session.created');
    await ws.close();
  });

  it('preserves seq/session_id/epoch on event frames delivered to onFrame', async () => {
    const ws = new WsConnection({ url: wsUrl, token });
    await ws.connect();
    const seen = new Promise<{
      seq?: number;
      session_id?: string;
      epoch?: string;
      timestamp?: string;
      payload?: unknown;
    }>((resolve) => {
      const off = ws.onFrame((frame) => {
        if (frame.type === 'event.session.created') {
          off();
          resolve(frame);
        }
      });
    });
    const created = await createSession(home);
    const frame = await seen;
    expect(typeof frame.seq).toBe('number');
    expect(frame.session_id).toBe(created.id);
    expect(typeof frame.epoch).toBe('string');
    expect(typeof frame.timestamp).toBe('string');
    expect(frame.payload).toMatchObject({ type: 'event.session.created' });
    await ws.close();
  });

  it('rejects handshake with a bad token', async () => {
    const ws = new WsConnection({ url: wsUrl, token: 'wrong' });
    await expect(ws.connect()).rejects.toThrow();
  });
});

/** Minimal profile update over plain HTTP — emits `session.meta.updated`. */
async function updateSessionProfile(id: string, patch: { title: string }): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/sessions/${id}/profile`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(patch),
  });
  const env = (await res.json()) as { code: number };
  expect(env.code).toBe(0);
}

describe('CursorSupervisor', () => {
  it('delivers subscribed session events end to end', async () => {
    const created = await createSession(home);
    const supervisor = new CursorSupervisor({
      makeConnection: () => new WsConnection({ url: wsUrl, token }),
      onResync: () => {},
    });
    await supervisor.start();
    await supervisor.subscribe(created.id);

    const metaSeen = new Promise<WsIncomingFrame>((resolve) => {
      const off = supervisor.onEventFrame((frame) => {
        if (frame.type === 'session.meta.updated') {
          off();
          resolve(frame);
        }
      });
    });
    await updateSessionProfile(created.id, { title: 'cursor-test' });
    const frame = await metaSeen;
    expect(frame.session_id).toBe(created.id);
    await supervisor.close();
  });

  it('skips volatile and stale frames when advancing the cursor', () => {
    expect(advanceCursor({ seq: 5 }, { seq: 6 })).toEqual({ seq: 6 });
    expect(advanceCursor({ seq: 5 }, { seq: 6, volatile: true })).toEqual({ seq: 5 });
    expect(advanceCursor({ seq: 5, epoch: 'e1' }, { seq: 4 })).toEqual({ seq: 5, epoch: 'e1' });
    expect(advanceCursor({ seq: 5 }, { seq: 6, epoch: 'e2' })).toEqual({ seq: 6, epoch: 'e2' });
  });

  it('re-subscribes with recorded cursors after a reconnect', async () => {
    type SubscribeCall = {
      session_ids: string[];
      cursors?: Record<string, { seq: number; epoch?: string }>;
    };
    const subscribes: SubscribeCall[] = [];
    let frameHandler: ((frame: WsIncomingFrame) => void) | undefined;
    let closeHandler: ((info: { code: number; reason: string }) => void) | undefined;
    let connects = 0;

    class FakeWsConnection {
      async connect() {
        connects++;
        return { ws_connection_id: 'c', protocol_version: 2, max_event_buffer_size: 100 };
      }
      async sendControl<T>(type: string, payload: unknown): Promise<T> {
        if (type === 'subscribe') subscribes.push(payload as SubscribeCall);
        return { accepted: (payload as SubscribeCall).session_ids, not_found: [] } as T;
      }
      onFrame(handler: (frame: WsIncomingFrame) => void) {
        frameHandler = handler;
        return () => {
          frameHandler = undefined;
        };
      }
      onClose(handler: (info: { code: number; reason: string }) => void) {
        closeHandler = handler;
        return () => {
          closeHandler = undefined;
        };
      }
      async close() {}
    }

    const supervisor = new CursorSupervisor({
      makeConnection: () => new FakeWsConnection() as never,
      onResync: () => {},
    });
    await supervisor.start();
    await supervisor.subscribe('s1', { seq: 0 });
    // a durable frame advances the recorded cursor:
    frameHandler?.({
      type: 'turn.ended',
      seq: 7,
      session_id: 's1',
      timestamp: '2026-07-30T00:00:00.000Z',
      payload: { type: 'turn.ended' },
    });
    // simulate a server-side drop; the supervisor must reconnect on its own:
    closeHandler?.({ code: 1006, reason: 'abnormal' });
    await new Promise((resolve) => setTimeout(resolve, 1600)); // first backoff ≈1s
    expect(connects).toBe(2);
    expect(subscribes.at(-1)).toEqual({ session_ids: ['s1'], cursors: { s1: { seq: 7 } } });
    await supervisor.close();
  });

  it(
    'keeps reconnecting across consecutive failed connect attempts',
    async () => {
      type SubscribeCall = {
        session_ids: string[];
        cursors?: Record<string, { seq: number; epoch?: string }>;
      };
      const subscribes: SubscribeCall[] = [];
      let closeHandler: ((info: { code: number; reason: string }) => void) | undefined;
      let connects = 0;
      let failConnects = 0;

      class FlakyConnect {
        async connect() {
          connects++;
          if (failConnects > 0) {
            failConnects--;
            throw new Error('connection refused');
          }
          return { ws_connection_id: 'c', protocol_version: 2, max_event_buffer_size: 100 };
        }
        async sendControl<T>(type: string, payload: unknown): Promise<T> {
          if (type === 'subscribe') subscribes.push(payload as SubscribeCall);
          return { accepted: (payload as SubscribeCall).session_ids, not_found: [] } as T;
        }
        onFrame() {
          return () => {};
        }
        onClose(handler: (info: { code: number; reason: string }) => void) {
          closeHandler = handler;
          return () => {
            closeHandler = undefined;
          };
        }
        async close() {}
      }

      const supervisor = new CursorSupervisor({
        makeConnection: () => new FlakyConnect() as never,
        onResync: () => {},
      });
      await supervisor.start();
      await supervisor.subscribe('s1', { seq: 0 });
      failConnects = 2; // the next two reconnect attempts throw immediately
      closeHandler?.({ code: 1006, reason: 'abnormal' });
      // backoff 1s (fail) + 2s (fail) + 4s (success) ≈ 7s + jitter:
      await new Promise((resolve) => setTimeout(resolve, 8000));
      // 1 initial + 2 failed retries + 1 successful retry (3 post-drop attempts):
      expect(connects).toBe(4);
      // the loop survived and the successful attempt re-subscribed:
      expect(subscribes.at(-1)).toEqual({ session_ids: ['s1'], cursors: { s1: { seq: 0 } } });
      await supervisor.close();
    },
    15_000,
  );

  it('tears down the socket when resubscribe fails and recovers on the next attempt', async () => {
    type SubscribeCall = {
      session_ids: string[];
      cursors?: Record<string, { seq: number; epoch?: string }>;
    };
    const subscribes: SubscribeCall[] = [];
    let closeHandler: ((info: { code: number; reason: string }) => void) | undefined;
    let connects = 0;
    let closes = 0;
    let failSubscribes = 0;

    class FlakySubscribe {
      async connect() {
        connects++;
        return { ws_connection_id: 'c', protocol_version: 2, max_event_buffer_size: 100 };
      }
      async sendControl<T>(type: string, payload: unknown): Promise<T> {
        if (type === 'subscribe') {
          if (failSubscribes > 0) {
            failSubscribes--;
            throw new Error('subscribe rejected');
          }
          subscribes.push(payload as SubscribeCall);
        }
        return { accepted: (payload as SubscribeCall).session_ids, not_found: [] } as T;
      }
      onFrame() {
        return () => {};
      }
      onClose(handler: (info: { code: number; reason: string }) => void) {
        closeHandler = handler;
        return () => {
          closeHandler = undefined;
        };
      }
      async close() {
        closes++;
      }
    }

    const supervisor = new CursorSupervisor({
      makeConnection: () => new FlakySubscribe() as never,
      onResync: () => {},
    });
    await supervisor.start();
    await supervisor.subscribe('s1', { seq: 0 });
    failSubscribes = 1; // the first resubscribe after the drop rejects
    closeHandler?.({ code: 1006, reason: 'abnormal' });
    // backoff 1s (resubscribe fails) + 2s (full recovery) ≈ 3s + jitter:
    await new Promise((resolve) => setTimeout(resolve, 3800));
    expect(connects).toBe(3); // initial + failed attempt + recovery attempt
    // the half-installed socket from the failed attempt was closed/torn down:
    expect(closes).toBe(1);
    // the recovery attempt fully re-subscribed:
    expect(subscribes.at(-1)).toEqual({ session_ids: ['s1'], cursors: { s1: { seq: 0 } } });
    await supervisor.close();
  });

  it('closes the fresh socket when close() lands during the resubscribe round-trip', async () => {
    let resolveSubscribe: (() => void) | undefined;
    let connects = 0;
    let closes = 0;
    const states: boolean[] = [];

    class ControlledResubscribe {
      async connect() {
        connects++;
        return { ws_connection_id: 'c', protocol_version: 2, max_event_buffer_size: 100 };
      }
      sendControl<T>(type: string, payload: unknown): Promise<T> {
        if (type === 'subscribe') {
          // Held open so the test can close() while the resubscribe is in flight.
          return new Promise<T>((resolve) => {
            resolveSubscribe = () =>
              resolve({
                accepted: (payload as { session_ids: string[] }).session_ids,
                not_found: [],
              } as T);
          });
        }
        return Promise.resolve({ accepted: [], not_found: [] } as T);
      }
      onFrame() {
        return () => {};
      }
      onClose() {
        return () => {};
      }
      async close() {
        closes++;
      }
    }

    const supervisor = new CursorSupervisor({
      makeConnection: () => new ControlledResubscribe() as never,
      onResync: () => {},
    });
    supervisor.connectionState((connected) => states.push(connected));
    await supervisor.subscribe('s1', { seq: 0 }); // recorded; sent on connect
    const started = supervisor.start(); // resubscribe goes in flight
    await new Promise((resolve) => setTimeout(resolve, 0)); // let start() reach the ack await
    await supervisor.close(); // lands during the resubscribe round-trip
    resolveSubscribe?.(); // the ack arrives only after close()
    await started;
    expect(connects).toBe(1);
    // the fully-subscribed fresh socket was torn down, not installed:
    expect(closes).toBe(1);
    // ... and the supervisor never announced itself connected:
    expect(states).not.toContain(true);
  });
});
