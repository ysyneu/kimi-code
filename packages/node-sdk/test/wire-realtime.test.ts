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

import { WsConnection } from '#/wire/ws-connection';

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
