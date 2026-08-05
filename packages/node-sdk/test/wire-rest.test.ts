import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  startServer,
  type RunningServer,
  type ServerHostIdentity,
} from '@moonshot-ai/kap-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isGlobalEventType, translateWireEvent } from '#/wire/event-translator';
import { WireHttpClient } from '#/wire/http-client';
import {
  EnvelopeError,
  envelopeSchema,
  unwrapEnvelope,
  wireSessionSchema,
  wsEventFrameSchema,
} from '#/wire/protocol';

// ---------------------------------------------------------------------------
// Shared live-server fixture (file scope — later wire-transport describes
// reuse `server` / `home` / `token` / `http`).
// ---------------------------------------------------------------------------

const TEST_HOST_IDENTITY: ServerHostIdentity = {
  productName: 'test-host',
  version: '0.0.0-test',
  platform: 'test_platform',
};

// Minimal provider config so prompt submission is accepted. The stub endpoint
// is unreachable — the turn fails asynchronously, which the REST contract
// assertions do not depend on. Mirrors packages/kap-server/test/prompts.test.ts.
const STUB_PROVIDER_TOML = [
  'default_model = "stub"',
  '',
  '[providers.stub]',
  'type = "openai"',
  'base_url = "http://127.0.0.1:9999"',
  'api_key = "stub"',
  '',
  '[models.stub]',
  'provider = "stub"',
  'model = "stub"',
  'max_context_size = 1000',
  '',
].join('\n');

let server: RunningServer;
let home: string;
let token: string;
let http: WireHttpClient;
// Real on-disk workspace root — session creation rejects a non-existent cwd
// (server code 40409).
let cwd: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'kimi-wire-test-'));
  await writeFile(join(home, 'config.toml'), STUB_PROVIDER_TOML, 'utf-8');
  cwd = join(home, 'workspace');
  await mkdir(cwd);
  server = await startServer({
    hostIdentity: TEST_HOST_IDENTITY,
    host: '127.0.0.1',
    port: 0,
    homeDir: home,
    logLevel: 'silent',
  });
  token = server.authTokenService.getToken();
  http = new WireHttpClient({
    baseUrl: `http://127.0.0.1:${server.port}`,
    token,
  });
});

afterAll(async () => {
  await server.close();
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('wire protocol schemas', () => {
  it('unwraps a success envelope and preserves typed data', () => {
    const env = { code: 0, msg: 'success', data: { id: 's1' }, request_id: 'r1' };
    const parsed = envelopeSchema(z.object({ id: z.string() })).parse(env);
    expect(unwrapEnvelope(parsed)).toEqual({ id: 's1' });
  });

  it('throws EnvelopeError with code and requestId on error envelopes', () => {
    const env = { code: 40401, msg: 'session not found', data: null, request_id: 'r2' };
    const parsed = envelopeSchema(z.unknown()).parse(env);
    expect(() => unwrapEnvelope(parsed)).toThrowError(EnvelopeError);
    try {
      unwrapEnvelope(parsed);
    } catch (e) {
      expect(e).toBeInstanceOf(EnvelopeError);
      expect((e as EnvelopeError).code).toBe(40401);
      expect((e as EnvelopeError).requestId).toBe('r2');
    }
  });

  it('parses a real session list row (shape captured from kap-server)', () => {
    const row = {
      id: 'sess_1', workspace_id: 'wd_x_0123456789ab', title: 'demo',
      created_at: '2026-07-30T00:00:00.000Z', updated_at: '2026-07-30T01:00:00.000Z',
      busy: true, main_turn_active: true, pending_interaction: 'approval',
      last_turn_reason: 'completed', last_prompt: 'hello', last_assistant_text: 'hi there',
      metadata: { cwd: '/tmp/demo' },
      agent_config: { model: '' },
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_cost_usd: 0, context_tokens: 0, context_limit: 0, turn_count: 0 },
      permission_rules: [], message_count: 2, last_seq: 41,
    };
    const s = wireSessionSchema.parse(row);
    expect(s.pending_interaction).toBe('approval');
    expect(s.metadata.cwd).toBe('/tmp/demo');
    expect(s.last_assistant_text).toBe('hi there');
  });

  it('parses an event frame and rejects frames without a numeric seq', () => {
    const frame = {
      type: 'turn.started', seq: 42, epoch: 'e1', session_id: 'sess_1',
      timestamp: '2026-07-30T01:00:00.000Z',
      payload: { type: 'turn.started', turnId: 3, origin: { kind: 'user' }, agentId: 'main', sessionId: 'sess_1' },
    };
    expect(wsEventFrameSchema.parse(frame).payload.type).toBe('turn.started');
    expect(wsEventFrameSchema.safeParse({ ...frame, seq: '42' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pure unit tests — no live-server fixture required.
// ---------------------------------------------------------------------------

describe('translateWireEvent', () => {
  it('passes through a well-formed durable event with payload intact', () => {
    const event = translateWireEvent({
      type: 'turn.ended', seq: 9, session_id: 's1', timestamp: '2026-07-30T00:00:00.000Z',
      payload: { type: 'turn.ended', turnId: 2, reason: 'completed', agentId: 'main', sessionId: 's1' },
    });
    expect(event).toMatchObject({ type: 'turn.ended', turnId: 2, sessionId: 's1', agentId: 'main' });
  });

  it('falls back to the envelope session_id when the payload omits it', () => {
    const event = translateWireEvent({
      type: 'event.session.work_changed', seq: 1, session_id: 's1', timestamp: 't',
      payload: { type: 'event.session.work_changed', busy: false, agentId: 'main' },
    });
    expect(event).toMatchObject({ sessionId: 's1', busy: false });
  });

  it('returns null for structurally invalid frames instead of throwing', () => {
    expect(translateWireEvent({ type: 'turn.ended', payload: null } as never)).toBeNull();
    expect(translateWireEvent({ type: 'turn.ended', payload: { turnId: 1 } } as never)).toBeNull();
  });

  it('classifies global event types exactly like the server', () => {
    expect(isGlobalEventType('session.meta.updated')).toBe(true);
    expect(isGlobalEventType('event.session.work_changed')).toBe(true);
    expect(isGlobalEventType('event.workspace.created')).toBe(true);
    expect(isGlobalEventType('turn.started')).toBe(false);
    expect(isGlobalEventType('assistant.delta')).toBe(false);
  });
});

describe('WireHttpClient against a real kap-server', () => {
  it('creates, lists, renames, and archives a session', async () => {
    const created = await http.createSession({ metadata: { cwd } });
    expect(created.id).toBeTruthy();
    expect(created.metadata.cwd).toBe(cwd);

    const page = await http.listSessions();
    expect(page.items.some((s) => s.id === created.id)).toBe(true);

    const renamed = await http.updateSessionProfile(created.id, { title: 'renamed' });
    expect(renamed.title).toBe('renamed');

    await http.sessionAction(created.id, 'archive');
    const after = await http.getSession(created.id);
    expect(after.archived).toBe(true);
  });

  it('rejects session creation without metadata.cwd (server contract)', async () => {
    await expect(
      http.createSessionRaw({ title: 'no-cwd' }),
    ).rejects.toMatchObject({ code: 40001 });
  });

  it('submits a prompt and reads status + messages', async () => {
    const created = await http.createSession({ metadata: { cwd } });
    const submitted = await http.submitPrompt(created.id, {
      content: [{ type: 'text', text: 'hello' }],
    });
    expect(submitted.prompt_id).toBeTruthy();

    const status = await http.getSessionStatus(created.id);
    expect(typeof status.busy).toBe('boolean');

    const messages = await http.getMessages(created.id);
    expect(messages.items.some((m) => m.role === 'user')).toBe(true);
  });

  // A fresh session has no active goal — the route's success envelope carries
  // `data: null` (not an error). This is the exact shape `unwrapEnvelope`
  // otherwise rejects, so this exercises the `allowNullData` escape hatch.
  it('reads the session goal, resolving null when none is active', async () => {
    const created = await http.createSession({ metadata: { cwd } });
    await expect(http.getSessionGoal(created.id)).resolves.toBeNull();
  });
});
