import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  startServer,
  type RunningServer,
  type ServerHostIdentity,
} from '@moonshot-ai/kap-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WireHttpClient } from '#/wire/http-client';
import type { WireApprovalRequest, WireQuestionRequest } from '#/wire/protocol';
import { InteractionBridge } from '#/wire/reverse-rpc';
import { SDKRpcClientWire } from '#/wire/sdk-rpc-client-wire';

// ---------------------------------------------------------------------------
// InteractionBridge — stub-based (no live server). The stub implements the
// WireHttpClient resolve/answer/dismiss subset and records every call.
// ---------------------------------------------------------------------------

interface StubCall {
  readonly method: 'resolveApproval' | 'answerQuestion' | 'dismissQuestion';
  readonly args: unknown[];
}

function createStubHttp() {
  const calls: StubCall[] = [];
  return {
    calls,
    resolveApproval: async (...args: unknown[]) => {
      calls.push({ method: 'resolveApproval', args });
    },
    answerQuestion: async (...args: unknown[]) => {
      calls.push({ method: 'answerQuestion', args });
    },
    dismissQuestion: async (...args: unknown[]) => {
      calls.push({ method: 'dismissQuestion', args });
    },
  };
}

/** The bridge resolves fire-and-forget; microtasks all settle before this. */
const flush = () => new Promise((r) => setImmediate(r));

const APPROVAL_WIRE = {
  approval_id: 'a1',
  session_id: 's1',
  turn_id: 3,
  tool_call_id: 'tc1',
  tool_name: 'Bash',
  action: 'run command',
  tool_input_display: { command: 'ls' },
  created_at: '2026-07-30T00:00:00.000Z',
  expires_at: '2026-07-30T01:00:00.000Z',
} satisfies WireApprovalRequest;

const QUESTION_WIRE = {
  question_id: 'q1',
  session_id: 's1',
  turn_id: 4,
  tool_call_id: 'tc2',
  questions: [
    {
      id: 'q_0',
      question: 'Pick one',
      options: [
        { id: 'opt_0_0', label: 'Yes' },
        { id: 'opt_0_1', label: 'No' },
      ],
      allow_other: true,
    },
    {
      id: 'q_1',
      question: 'Pick many',
      multi_select: true,
      options: [
        { id: 'opt_1_0', label: 'A' },
        { id: 'opt_1_1', label: 'B' },
        { id: 'opt_1_2', label: 'C' },
      ],
      allow_other: true,
    },
  ],
  created_at: '2026-07-30T00:00:00.000Z',
} satisfies WireQuestionRequest;

describe('InteractionBridge', () => {
  it('routes approval.requested to the handler and POSTs the decision', async () => {
    const http = createStubHttp();
    const handled: unknown[] = [];
    const bridge = new InteractionBridge({
      http,
      requestApproval: async (req) => {
        handled.push(req);
        return { decision: 'approved', scope: 'session' };
      },
      requestQuestion: async () => null,
    });
    bridge.handleEvent({
      type: 'event.approval.requested',
      ...APPROVAL_WIRE,
      agentId: 'main',
      sessionId: 's1',
    });
    await flush();
    expect(handled).toEqual([
      {
        turnId: 3,
        toolCallId: 'tc1',
        toolName: 'Bash',
        action: 'run command',
        display: { command: 'ls' },
        sessionId: 's1',
        agentId: 'main',
      },
    ]);
    expect(http.calls).toEqual([
      {
        method: 'resolveApproval',
        args: ['s1', 'a1', { decision: 'approved', scope: 'session' }],
      },
    ]);
  });

  it('maps the approval response back to the wire shape', async () => {
    const http = createStubHttp();
    const bridge = new InteractionBridge({
      http,
      requestApproval: async () => ({
        decision: 'rejected',
        feedback: 'too dangerous',
        selectedLabel: 'No, and explain',
      }),
      requestQuestion: async () => null,
    });
    bridge.handleEvent({ type: 'event.approval.requested', ...APPROVAL_WIRE });
    await flush();
    expect(http.calls[0]?.args[2]).toEqual({
      decision: 'rejected',
      scope: undefined,
      feedback: 'too dangerous',
      selected_label: 'No, and explain',
    });
  });

  it('routes question.requested and converts option labels back to wire ids', async () => {
    const http = createStubHttp();
    const handled: unknown[] = [];
    const bridge = new InteractionBridge({
      http,
      requestApproval: async () => ({ decision: 'cancelled' }),
      requestQuestion: async (req) => {
        handled.push(req);
        return { 'Pick one': 'Yes', 'Pick many': 'A, B' };
      },
    });
    bridge.handleEvent({ type: 'event.question.requested', ...QUESTION_WIRE, sessionId: 's1' });
    await flush();
    expect(handled).toEqual([
      {
        turnId: 4,
        toolCallId: 'tc2',
        questions: [
          {
            question: 'Pick one',
            header: undefined,
            body: undefined,
            options: [
              { label: 'Yes', description: undefined },
              { label: 'No', description: undefined },
            ],
            multiSelect: undefined,
            otherLabel: undefined,
            otherDescription: undefined,
          },
          {
            question: 'Pick many',
            header: undefined,
            body: undefined,
            options: [
              { label: 'A', description: undefined },
              { label: 'B', description: undefined },
              { label: 'C', description: undefined },
            ],
            multiSelect: true,
            otherLabel: undefined,
            otherDescription: undefined,
          },
        ],
        sessionId: 's1',
        agentId: 'main',
      },
    ]);
    expect(http.calls).toEqual([
      {
        method: 'answerQuestion',
        args: [
          's1',
          'q1',
          {
            answers: {
              q_0: { kind: 'single', option_id: 'opt_0_0' },
              q_1: { kind: 'multi', option_ids: ['opt_1_0', 'opt_1_1'] },
            },
            method: undefined,
          },
        ],
      },
    ]);
  });

  it('sends free-form answers as kind other and forwards the response method', async () => {
    const http = createStubHttp();
    const bridge = new InteractionBridge({
      http,
      requestApproval: async () => ({ decision: 'cancelled' }),
      requestQuestion: async () => ({
        answers: { 'Pick one': 'something else' },
        method: 'enter',
      }),
    });
    bridge.handleEvent({ type: 'event.question.requested', ...QUESTION_WIRE });
    await flush();
    expect(http.calls).toEqual([
      {
        method: 'answerQuestion',
        args: [
          's1',
          'q1',
          {
            answers: { q_0: { kind: 'other', text: 'something else' } },
            method: 'enter',
          },
        ],
      },
    ]);
  });

  it('dismisses the question when the handler result is null', async () => {
    const http = createStubHttp();
    const bridge = new InteractionBridge({
      http,
      requestApproval: async () => ({ decision: 'cancelled' }),
      requestQuestion: async () => null,
    });
    bridge.handleEvent({ type: 'event.question.requested', ...QUESTION_WIRE });
    await flush();
    expect(http.calls).toEqual([{ method: 'dismissQuestion', args: ['s1', 'q1'] }]);
  });

  it('fails safe with a cancelled approval when the handler throws', async () => {
    const http = createStubHttp();
    const bridge = new InteractionBridge({
      http,
      requestApproval: async () => {
        throw new Error('handler exploded');
      },
      requestQuestion: async () => null,
    });
    expect(() =>
      bridge.handleEvent({ type: 'event.approval.requested', ...APPROVAL_WIRE }),
    ).not.toThrow();
    await flush();
    expect(http.calls).toEqual([
      {
        method: 'resolveApproval',
        args: ['s1', 'a1', expect.objectContaining({ decision: 'cancelled' })],
      },
    ]);
  });

  it('fails safe with a dismiss when the question handler throws', async () => {
    const http = createStubHttp();
    const bridge = new InteractionBridge({
      http,
      requestApproval: async () => ({ decision: 'cancelled' }),
      requestQuestion: async () => {
        throw new Error('handler exploded');
      },
    });
    bridge.handleEvent({ type: 'event.question.requested', ...QUESTION_WIRE });
    await flush();
    expect(http.calls).toEqual([{ method: 'dismissQuestion', args: ['s1', 'q1'] }]);
  });

  it('ignores malformed interaction events without touching the handler', async () => {
    const http = createStubHttp();
    const warnings: unknown[] = [];
    const bridge = new InteractionBridge({
      http,
      requestApproval: async () => ({ decision: 'approved' }),
      requestQuestion: async () => null,
      logger: (level, msg) => warnings.push([level, msg]),
    });
    expect(() =>
      bridge.handleEvent({ type: 'event.approval.requested', approval_id: 'a1' }),
    ).not.toThrow();
    bridge.handleEvent({ type: 'assistant.delta', text: 'hi' });
    await flush();
    expect(http.calls).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('replayPending re-feeds snapshot items and dedupes against live events', async () => {
    const http = createStubHttp();
    const approvalHandled: unknown[] = [];
    const questionHandled: unknown[] = [];
    const bridge = new InteractionBridge({
      http,
      requestApproval: async (req) => {
        approvalHandled.push(req);
        return { decision: 'approved' };
      },
      requestQuestion: async (req) => {
        questionHandled.push(req);
        return null;
      },
    });
    const snapshot = {
      pending_approvals: [APPROVAL_WIRE],
      pending_questions: [QUESTION_WIRE],
    };
    // Live event first, then a snapshot replay carrying the same items.
    bridge.handleEvent({ type: 'event.approval.requested', ...APPROVAL_WIRE });
    bridge.replayPending('s1', snapshot);
    // A second replay (e.g. after a resync) must not re-invoke either.
    bridge.replayPending('s1', snapshot);
    await flush();
    expect(approvalHandled.length).toBe(1);
    expect(questionHandled.length).toBe(1);
    expect(http.calls.map((c) => c.method)).toEqual(['resolveApproval', 'dismissQuestion']);
  });
});

// ---------------------------------------------------------------------------
// SDKRpcClientWire — live kap-server fixture (file scope; the stub-based
// InteractionBridge describes above never touch these).
// ---------------------------------------------------------------------------

const TEST_HOST_IDENTITY: ServerHostIdentity = {
  productName: 'test-host',
  version: '0.0.0-test',
  platform: 'test_platform',
};

let server: RunningServer;
let home: string;
let token: string;
let base: string;
// Real on-disk workspace root — session creation rejects a non-existent cwd
// (server code 40409). The lifecycle tests below never start a turn, so no
// stub-provider config.toml is needed.
let cwd: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'kimi-wire-client-'));
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
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Poll until `cond` holds (WS delivery is async; HTTP responses don't await it). */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('SDKRpcClientWire lifecycle', () => {
  it('lists/creates/renames/archives sessions and streams events', async () => {
    const rpc = new SDKRpcClientWire({ serverUrl: base, token, homeDir: home });
    await rpc.start();
    const events: string[] = [];
    rpc.onEvent((e) => events.push(`${e.sessionId}:${e.type}`));

    const created = await rpc.createSession({ workDir: cwd });
    expect(created.workDir).toBe(cwd);

    const list = await rpc.listSessions({});
    expect(list.some((s) => s.id === created.id)).toBe(true);

    await rpc.renameSession({ id: created.id, title: 'wired' });
    expect((await rpc.listSessions({})).find((s) => s.id === created.id)?.title).toBe('wired');

    await rpc.deleteSession({ sessionId: created.id });
    // The default list excludes archived sessions (server contract)…
    const listed = await rpc.listSessions({});
    expect(listed.some((s) => s.id === created.id)).toBe(false);
    // …and the session itself reads back archived:
    const http = new WireHttpClient({ baseUrl: base, token });
    expect((await http.getSession(created.id)).archived).toBe(true);

    // session.meta.updated (from the rename) flowed through supervisor + translator:
    await waitFor(() => events.some((t) => t.endsWith(':session.meta.updated')));
    await rpc.close();
  });

  it('resumeSession subscribes with the snapshot cursor and closeSession only detaches', async () => {
    const rpc = new SDKRpcClientWire({ serverUrl: base, token, homeDir: home });
    await rpc.start();
    const created = await rpc.createSession({ workDir: cwd });
    const resumed = await rpc.resumeSession({ id: created.id });
    expect(resumed.id).toBe(created.id);
    expect(resumed.sessionMetadata.workDir).toBe(cwd);
    await rpc.closeSession({ sessionId: created.id });
    // the session must still exist and be resumable (detach, not close):
    const again = await rpc.resumeSession({ id: created.id });
    expect(again.id).toBe(created.id);
    await rpc.close();
  });

  it('forks a session over :fork', async () => {
    const rpc = new SDKRpcClientWire({ serverUrl: base, token, homeDir: home });
    await rpc.start();
    const created = await rpc.createSession({ workDir: cwd });
    const forked = await rpc.forkSession({ id: created.id, title: 'forked' });
    expect(forked.id).not.toBe(created.id);
    expect(forked.workDir).toBe(cwd);
    expect(forked.title).toBe('forked');
    await rpc.close();
  });

  it('forwards caller metadata on create and round-trips it on read', async () => {
    const rpc = new SDKRpcClientWire({ serverUrl: base, token, homeDir: home });
    await rpc.start();
    const created = await rpc.createSession({
      workDir: cwd,
      metadata: { origin: 'wire-sdk-test', attempt: 2 },
    });
    // v1/v2 return the caller's metadata verbatim on create:
    expect(created.metadata).toEqual({ origin: 'wire-sdk-test', attempt: 2 });

    // …and the custom keys survived server-side, readable on the wire row
    // (merged next to the authoritative cwd):
    const http = new WireHttpClient({ baseUrl: base, token });
    const row = await http.getSession(created.id);
    expect(row.metadata).toMatchObject({ origin: 'wire-sdk-test', attempt: 2, cwd });
    const listed = await rpc.listSessions({});
    expect(listed.find((s) => s.id === created.id)?.metadata).toMatchObject({
      origin: 'wire-sdk-test',
      attempt: 2,
    });
    await rpc.close();
  });

  it('rejects a non-loopback serverUrl', () => {
    expect(() => new SDKRpcClientWire({ serverUrl: 'http://192.168.1.10:58627', token: 't' })).toThrow();
  });
});
