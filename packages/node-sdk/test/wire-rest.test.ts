import { describe, expect, it } from 'vitest';

import {
  EnvelopeError,
  envelopeSchema,
  unwrapEnvelope,
  wireSessionSchema,
  wsEventFrameSchema,
} from '#/wire/protocol';
import { z } from 'zod';

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
      last_turn_reason: 'completed', last_prompt: 'hello',
      metadata: { cwd: '/tmp/demo' },
      agent_config: { model: '' },
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_cost_usd: 0, context_tokens: 0, context_limit: 0, turn_count: 0 },
      permission_rules: [], message_count: 2, last_seq: 41,
    };
    const s = wireSessionSchema.parse(row);
    expect(s.pending_interaction).toBe('approval');
    expect(s.metadata.cwd).toBe('/tmp/demo');
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
