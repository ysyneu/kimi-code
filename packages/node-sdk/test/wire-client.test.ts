import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ErrorCodes } from '@moonshot-ai/agent-core';
import { ISessionMetadata, getLiveSessionById } from '@moonshot-ai/agent-core-v2';
import {
  startServer,
  type RunningServer,
  type ServerHostIdentity,
} from '@moonshot-ai/kap-server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createKimiHarnessWire } from '#/index';
import { WireHttpClient, type WirePromptSubmission } from '#/wire/http-client';
import type { WireApprovalRequest, WireMessage, WireQuestionRequest } from '#/wire/protocol';
import { collectReplayMessages } from '#/wire/resume-replay';
import { InteractionBridge } from '#/wire/reverse-rpc';
import { SDKRpcClientWire, toWireContent } from '#/wire/sdk-rpc-client-wire';

import { TEST_IDENTITY } from './test-identity';

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
      hasApprovalHandler: () => true,
      hasQuestionHandler: () => true,
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
      hasApprovalHandler: () => true,
      hasQuestionHandler: () => true,
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
      hasApprovalHandler: () => true,
      hasQuestionHandler: () => true,
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
      hasApprovalHandler: () => true,
      hasQuestionHandler: () => true,
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
      hasApprovalHandler: () => true,
      hasQuestionHandler: () => true,
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
      hasApprovalHandler: () => true,
      hasQuestionHandler: () => true,
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
      hasApprovalHandler: () => true,
      hasQuestionHandler: () => true,
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
      hasApprovalHandler: () => true,
      hasQuestionHandler: () => true,
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
      hasApprovalHandler: () => true,
      hasQuestionHandler: () => true,
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

  it('queues replayed pending items when no handler is registered yet', async () => {
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
      hasApprovalHandler: () => false,
      hasQuestionHandler: () => false,
    });
    bridge.replayPending('s1', {
      pending_approvals: [APPROVAL_WIRE],
      pending_questions: [QUESTION_WIRE],
    });
    await flush();
    // No handler ⇒ no handler call and, critically, no resolve/dismiss POST:
    // the interactions stay pending on the server.
    expect(approvalHandled).toEqual([]);
    expect(questionHandled).toEqual([]);
    expect(http.calls).toEqual([]);
  });

  it('queues a live interaction event that arrives before handler registration', async () => {
    const http = createStubHttp();
    const approvalHandled: unknown[] = [];
    let registered = false;
    const bridge = new InteractionBridge({
      http,
      requestApproval: async (req) => {
        approvalHandled.push(req);
        return { decision: 'approved' };
      },
      requestQuestion: async () => null,
      hasApprovalHandler: () => registered,
      hasQuestionHandler: () => true,
    });
    bridge.handleEvent({ type: 'event.approval.requested', ...APPROVAL_WIRE });
    await flush();
    expect(approvalHandled).toEqual([]);
    expect(http.calls).toEqual([]);
    registered = true;
    bridge.flush('s1', 'approval');
    await flush();
    expect(approvalHandled.length).toBe(1);
    expect(http.calls.map((c) => c.method)).toEqual(['resolveApproval']);
  });

  it('flush fires each queued pending id exactly once with the mapped request', async () => {
    const http = createStubHttp();
    const approvalHandled: unknown[] = [];
    let registered = false;
    const bridge = new InteractionBridge({
      http,
      requestApproval: async (req) => {
        approvalHandled.push(req);
        return { decision: 'approved' };
      },
      requestQuestion: async () => null,
      hasApprovalHandler: () => registered,
      hasQuestionHandler: () => true,
    });
    const snapshot = { pending_approvals: [APPROVAL_WIRE], pending_questions: [] };
    bridge.replayPending('s1', snapshot);
    // A duplicate replay within the same attach stays deduped in the queue.
    bridge.replayPending('s1', snapshot);
    registered = true;
    bridge.flush('s1', 'approval');
    // A second flush is a no-op — the queue drained with the first.
    bridge.flush('s1', 'approval');
    await flush();
    expect(approvalHandled).toEqual([
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
      { method: 'resolveApproval', args: ['s1', 'a1', { decision: 'approved' }] },
    ]);
  });

  it('forgetSession clears dedupe so a reattach re-presents a still-pending item', async () => {
    const http = createStubHttp();
    const approvalHandled: unknown[] = [];
    const bridge = new InteractionBridge({
      http,
      requestApproval: async (req) => {
        approvalHandled.push(req);
        return { decision: 'approved' };
      },
      requestQuestion: async () => null,
      hasApprovalHandler: () => true,
      hasQuestionHandler: () => true,
    });
    // The snapshot still lists the item because it stayed pending on the
    // server (the consumer detached without answering).
    const snapshot = { pending_approvals: [APPROVAL_WIRE], pending_questions: [] };
    bridge.replayPending('s1', snapshot);
    await flush();
    expect(approvalHandled.length).toBe(1);
    // Detach → reattach: the replay of the same snapshot must fire again.
    bridge.forgetSession('s1');
    bridge.replayPending('s1', snapshot);
    await flush();
    expect(approvalHandled.length).toBe(2);
    expect(http.calls.map((c) => c.method)).toEqual(['resolveApproval', 'resolveApproval']);
  });

  it('forgetSession also drops queued entries that never fired', async () => {
    const http = createStubHttp();
    const approvalHandled: unknown[] = [];
    const bridge = new InteractionBridge({
      http,
      requestApproval: async (req) => {
        approvalHandled.push(req);
        return { decision: 'approved' };
      },
      requestQuestion: async () => null,
      hasApprovalHandler: () => false,
      hasQuestionHandler: () => true,
    });
    bridge.replayPending('s1', { pending_approvals: [APPROVAL_WIRE], pending_questions: [] });
    bridge.forgetSession('s1');
    // The next attach's flush has nothing left from the previous attach.
    bridge.flush('s1', 'approval');
    await flush();
    expect(approvalHandled).toEqual([]);
    expect(http.calls).toEqual([]);
  });

  it('forgetSession only touches the named session — a second session keeps its dedupe and queue', async () => {
    const http = createStubHttp();
    const approvalHandled: unknown[] = [];
    const bridge = new InteractionBridge({
      http,
      requestApproval: async (req) => {
        approvalHandled.push(req);
        return { decision: 'approved' };
      },
      requestQuestion: async () => null,
      hasApprovalHandler: (sessionId) => sessionId === 's1',
      hasQuestionHandler: () => true,
    });
    const approvalS1 = APPROVAL_WIRE;
    const approvalS2 = { ...APPROVAL_WIRE, approval_id: 'a2', session_id: 's2' };

    // s1 has a handler and fires immediately; s2 has none and queues.
    bridge.replayPending('s1', { pending_approvals: [approvalS1], pending_questions: [] });
    bridge.replayPending('s2', { pending_approvals: [approvalS2], pending_questions: [] });
    await flush();
    expect(approvalHandled.length).toBe(1);

    bridge.forgetSession('s1');

    // s2's dedupe survives: replaying the same item again must NOT re-fire it
    // (it is still only queued, never delivered).
    bridge.replayPending('s2', { pending_approvals: [approvalS2], pending_questions: [] });
    await flush();
    expect(approvalHandled.length).toBe(1);

    // s2's queue survives too: flushing it delivers the original entry once.
    bridge.flush('s2', 'approval');
    await flush();
    expect(approvalHandled.length).toBe(2);
    expect(approvalHandled[1]).toMatchObject({ sessionId: 's2' });
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
// (server code 40409).
let cwd: string;

// Minimal provider config so prompt submission is accepted (the turn tests
// below submit prompts). The stub endpoint is unreachable — the turn fails
// asynchronously, which the REST assertions do not depend on. Mirrors the
// fixture in wire-rest.test.ts.
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

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'kimi-wire-client-'));
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

  it('maps lastAssistantText onto SessionSummary through listSessions (wireSessionToSummary)', async () => {
    const rpc = new SDKRpcClientWire({ serverUrl: base, token, homeDir: home });
    await rpc.start();
    const created = await rpc.createSession({ workDir: cwd });

    // lastAssistantText is engine-derived (written reactively off turn.ended
    // by AgentConversationUndoService) — there is no public RPC to set it
    // directly, so seed it through the running server's own session scope
    // and assert the public listSessions() surface, which is what exercises
    // the private wireSessionToSummary mapping.
    const live = getLiveSessionById(server.core.accessor, created.id);
    expect(live).toBeDefined();
    await live!.accessor.get(ISessionMetadata).update({ lastAssistantText: 'the answer is 42' });

    const list = await rpc.listSessions({});
    expect(list.find((s) => s.id === created.id)?.lastAssistantText).toBe('the answer is 42');

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

  it('resolves workspace trust for a session; a missing session reads back undefined', async () => {
    const rpc = new SDKRpcClientWire({ serverUrl: base, token, homeDir: home });
    const created = await rpc.createSession({ workDir: cwd });
    // The workspace auto-registered on session creation, so the trust read is a boolean.
    await expect(rpc.getWorkspaceTrustForSession(created.id)).resolves.toEqual(
      expect.any(Boolean),
    );
    await expect(rpc.getWorkspaceTrustForSession('no-such-session')).resolves.toBeUndefined();
    await rpc.close();
  });

  it('listSessionRows returns the full wire rows that SessionSummary drops', async () => {
    const rpc = new SDKRpcClientWire({ serverUrl: base, token, homeDir: home });
    await rpc.start();
    const created = await rpc.createSession({ workDir: cwd });
    const rows = await rpc.listSessionRows();
    const row = rows.find((r) => r.id === created.id);
    expect(row).toBeDefined();
    expect(row?.busy).toBe(false);
    expect(row?.workspace_id).toBeTruthy();
    expect(row?.metadata.cwd).toBe(cwd);
    await rpc.close();
  });

  it('onConnectionState forwards supervisor connection transitions', async () => {
    const rpc = new SDKRpcClientWire({ serverUrl: base, token, homeDir: home });
    const states: boolean[] = [];
    const off = rpc.onConnectionState((connected) => states.push(connected));
    await rpc.start();
    // Registered before start(): the initial connect's transition reaches it.
    expect(states).toEqual([true]);
    off();
    await rpc.close();
  });

  it('rejects a non-loopback serverUrl', () => {
    expect(() => new SDKRpcClientWire({ serverUrl: 'http://192.168.1.10:58627', token: 't' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// SDKRpcClientWire turns and state — prompt/steer/cancel + status/history
// reads against the live server (the stub provider makes every turn fail
// asynchronously; the REST assertions below do not depend on turn output).
// ---------------------------------------------------------------------------

/** Async variant of `waitFor` — the condition itself performs HTTP reads. */
async function waitForAsync(cond: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('waitForAsync timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('SDKRpcClientWire turns and state', () => {
  it('prompts, steers, cancels, and reads status/context/usage/warnings', async () => {
    const rpc = new SDKRpcClientWire({ serverUrl: base, token, homeDir: home });
    await rpc.start();
    const created = await rpc.createSession({ workDir: cwd });
    await rpc.resumeSession({ id: created.id });

    await rpc.prompt({ sessionId: created.id, input: [{ type: 'text', text: 'hi' }] });

    const status = await rpc.getStatus({ sessionId: created.id });
    expect(status).toMatchObject({
      thinkingEffort: expect.any(String),
      permission: expect.any(String),
      planMode: expect.any(Boolean),
      swarmMode: expect.any(Boolean),
      contextTokens: expect.any(Number),
      maxContextTokens: expect.any(Number),
      contextUsage: expect.any(Number),
    });

    const context = await rpc.getContext({ sessionId: created.id });
    expect(context.tokenCount).toEqual(expect.any(Number));
    expect(
      context.history.some(
        (m) => m.role === 'user' && m.content.some((p) => p.type === 'text' && p.text === 'hi'),
      ),
    ).toBe(true);

    const usage = await rpc.getUsage({ sessionId: created.id });
    expect(usage.total).toMatchObject({
      inputOther: expect.any(Number),
      output: expect.any(Number),
      inputCacheRead: expect.any(Number),
      inputCacheCreation: expect.any(Number),
    });

    // The stub endpoint refuses connections but the first turn is still in its
    // retry backoff by now, so the steer submission queues and is steered into
    // the active turn through the `prompts:steer` route.
    await rpc.steer({ sessionId: created.id, input: [{ type: 'text', text: 'focus' }] });
    await rpc.cancel({ sessionId: created.id });

    const warnings = await rpc.getSessionWarnings({ sessionId: created.id });
    expect(Array.isArray(warnings)).toBe(true);
    await rpc.close();
  });

  it('undoes the last prompt over :undo', async () => {
    const rpc = new SDKRpcClientWire({ serverUrl: base, token, homeDir: home });
    await rpc.start();
    const http = new WireHttpClient({ baseUrl: base, token });
    const created = await rpc.createSession({ workDir: cwd });
    await rpc.prompt({ sessionId: created.id, input: [{ type: 'text', text: 'undo me' }] });
    // The stub provider's turn now retries instead of dying instantly — abort
    // it (the retry sleep is abortable) and wait for the settle so the undo is
    // deterministic.
    await rpc.cancel({ sessionId: created.id });
    await waitForAsync(async () => !(await http.getSession(created.id)).busy);
    await rpc.undoHistory({ sessionId: created.id, count: 1 });
    const context = await rpc.getContext({ sessionId: created.id });
    expect(context.history.some((m) => m.role === 'user')).toBe(false);
    await rpc.close();
  });

  it('routes compact to :compact and surfaces compaction.unable on an empty history', async () => {
    const rpc = new SDKRpcClientWire({ serverUrl: base, token, homeDir: home });
    await rpc.start();
    const created = await rpc.createSession({ workDir: cwd });
    // A fresh session has no compactable prefix: the server maps
    // `compaction.unable` onto envelope code 40910.
    await expect(
      rpc.compact({ sessionId: created.id, instruction: 'keep it short' }),
    ).rejects.toMatchObject({ code: 40910 });
    await rpc.close();
  });

  it('unimplemented methods fail loudly with not_implemented', async () => {
    const rpc = new SDKRpcClientWire({ serverUrl: base, token, homeDir: home });
    await expect(rpc.getCronTasks({ sessionId: 's' })).rejects.toMatchObject({
      code: ErrorCodes.NOT_IMPLEMENTED,
    });
    await rpc.close();
  });
});

// ---------------------------------------------------------------------------
// SDKRpcClientWire getGoal — the root fix for the attach crash: the wire
// transport previously had no override, so every attach's
// `Promise.all([getStatus(), getGoal()])` rejected with not_implemented.
// ---------------------------------------------------------------------------

describe('SDKRpcClientWire getGoal', () => {
  it('wraps the http read in the GoalToolResult { goal } shape', async () => {
    const rpc = new SDKRpcClientWire({ serverUrl: base, token, homeDir: home });
    const snapshot = {
      goalId: 'g1',
      objective: 'ship the fix',
      status: 'active' as const,
      turnsUsed: 2,
      tokensUsed: 500,
      wallClockMs: 1000,
      budget: {
        tokenBudget: null,
        turnBudget: null,
        wallClockBudgetMs: null,
        remainingTokens: null,
        remainingTurns: null,
        remainingWallClockMs: null,
        tokenBudgetReached: false,
        turnBudgetReached: false,
        wallClockBudgetReached: false,
        overBudget: false,
      },
    };
    const spy = vi.spyOn(WireHttpClient.prototype, 'getSessionGoal').mockResolvedValue(snapshot);
    await expect(rpc.getGoal({ sessionId: 's1' })).resolves.toEqual({ goal: snapshot });
    expect(spy).toHaveBeenCalledWith('s1');
    spy.mockRestore();
    await rpc.close();
  });

  it('resolves { goal: null } against the live server when no goal is active', async () => {
    const rpc = new SDKRpcClientWire({ serverUrl: base, token, homeDir: home });
    await rpc.start();
    const created = await rpc.createSession({ workDir: cwd });
    await expect(rpc.getGoal({ sessionId: created.id })).resolves.toEqual({ goal: null });
    await rpc.close();
  });
});

// ---------------------------------------------------------------------------
// SDKRpcClientWire degrade surface: empty collections for surfaces kap-server
// has no routes for, deferred
// setPermission riding the next prompt/steer, and model/profile passthrough.
// Body assertions stub at the WireHttpClient.submitPrompt boundary — the body
// object it receives is stringified verbatim into the HTTP request
// (WireHttpClient.request), so recording it IS inspecting the HTTP body.
// ---------------------------------------------------------------------------

function stubSubmitPrompt(status: 'running' | 'queued' = 'running') {
  const bodies: WirePromptSubmission[] = [];
  const spy = vi
    .spyOn(WireHttpClient.prototype, 'submitPrompt')
    .mockImplementation(async (_id, body) => {
      bodies.push(body);
      return {
        prompt_id: 'p_stub',
        user_message_id: 'm_stub',
        status,
        content: [{ type: 'text', text: 'stub' }],
        created_at: '2026-07-30T00:00:00.000Z',
      };
    });
  return { bodies, spy };
}

describe('SDKRpcClientWire degrade surface', () => {
  it('degrades plugin/skill/MCP surfaces to empty collections', async () => {
    const rpc = new SDKRpcClientWire({ serverUrl: base, token, homeDir: home });
    await expect(rpc.listPlugins()).resolves.toEqual([]);
    await expect(rpc.listPluginCommands({ sessionId: 's' })).resolves.toEqual([]);
    await expect(rpc.listSkills({ sessionId: 's' })).resolves.toEqual([]);
    await expect(rpc.listMcpServers()).resolves.toEqual([]);
    await expect(rpc.getMcpStartupMetrics({ sessionId: 's' })).resolves.toEqual({
      durationMs: 0,
    });
    await rpc.close();
  });

  it('defers setPermission onto the next prompt body, then clears it', async () => {
    const rpc = new SDKRpcClientWire({ serverUrl: base, token, homeDir: home });
    const { bodies, spy } = stubSubmitPrompt();
    await rpc.setPermission({ sessionId: 's1', mode: 'yolo' });
    await rpc.prompt({ sessionId: 's1', input: [{ type: 'text', text: 'first' }] });
    expect(bodies[0]?.permission_mode).toBe('yolo');
    await rpc.prompt({ sessionId: 's1', input: [{ type: 'text', text: 'second' }] });
    expect(bodies[1]?.permission_mode).toBeUndefined();
    spy.mockRestore();
    await rpc.close();
  });

  it('scopes the deferred permission per session', async () => {
    const rpc = new SDKRpcClientWire({ serverUrl: base, token, homeDir: home });
    const { bodies, spy } = stubSubmitPrompt();
    await rpc.setPermission({ sessionId: 's1', mode: 'yolo' });
    await rpc.prompt({ sessionId: 's2', input: [{ type: 'text', text: 'other' }] });
    expect(bodies[0]?.permission_mode).toBeUndefined();
    await rpc.prompt({ sessionId: 's1', input: [{ type: 'text', text: 'mine' }] });
    expect(bodies[1]?.permission_mode).toBe('yolo');
    spy.mockRestore();
    await rpc.close();
  });

  it('defers setPermission onto steer submissions too', async () => {
    const rpc = new SDKRpcClientWire({ serverUrl: base, token, homeDir: home });
    const { bodies, spy } = stubSubmitPrompt();
    await rpc.setPermission({ sessionId: 's1', mode: 'manual' });
    await rpc.steer({ sessionId: 's1', input: [{ type: 'text', text: 'steered' }] });
    expect(bodies[0]?.permission_mode).toBe('manual');
    await rpc.steer({ sessionId: 's1', input: [{ type: 'text', text: 'again' }] });
    expect(bodies[1]?.permission_mode).toBeUndefined();
    spy.mockRestore();
    await rpc.close();
  });

  it('keeps the deferred permission when the submission fails', async () => {
    const rpc = new SDKRpcClientWire({ serverUrl: base, token, homeDir: home });
    const { bodies, spy } = stubSubmitPrompt();
    spy.mockRejectedValueOnce(new Error('boom'));
    await rpc.setPermission({ sessionId: 's1', mode: 'yolo' });
    await expect(
      rpc.prompt({ sessionId: 's1', input: [{ type: 'text', text: 'fails' }] }),
    ).rejects.toThrow('boom');
    await rpc.prompt({ sessionId: 's1', input: [{ type: 'text', text: 'retry' }] });
    expect(bodies[0]?.permission_mode).toBe('yolo');
    spy.mockRestore();
    await rpc.close();
  });

  it('passes model/profile through on prompt and steer bodies', async () => {
    const rpc = new SDKRpcClientWire({ serverUrl: base, token, homeDir: home });
    const { bodies, spy } = stubSubmitPrompt();
    await rpc.prompt({
      sessionId: 's1',
      input: [{ type: 'text', text: 'hi' }],
      model: 'k2',
      profile: 'coder',
    });
    expect(bodies[0]).toMatchObject({ model: 'k2', profile: 'coder' });
    await rpc.steer({
      sessionId: 's1',
      input: [{ type: 'text', text: 'hi' }],
      model: 'k2',
      profile: 'coder',
    });
    expect(bodies[1]).toMatchObject({ model: 'k2', profile: 'coder' });
    spy.mockRestore();
    await rpc.close();
  });

  it('omits model/profile from the body when not provided', async () => {
    const rpc = new SDKRpcClientWire({ serverUrl: base, token, homeDir: home });
    const { bodies, spy } = stubSubmitPrompt();
    await rpc.prompt({ sessionId: 's1', input: [{ type: 'text', text: 'hi' }] });
    expect(bodies[0]?.model).toBeUndefined();
    expect(bodies[0]?.profile).toBeUndefined();
    spy.mockRestore();
    await rpc.close();
  });

  it('the live prompt route accepts a deferred permission_mode body', async () => {
    const rpc = new SDKRpcClientWire({ serverUrl: base, token, homeDir: home });
    await rpc.start();
    const created = await rpc.createSession({ workDir: cwd });
    // Call-through spy: asserts the exact body the live server accepted.
    const live = vi.spyOn(WireHttpClient.prototype, 'submitPrompt');
    await rpc.setPermission({ sessionId: created.id, mode: 'manual' });
    // A schema rejection would surface here as an envelope error.
    await rpc.prompt({ sessionId: created.id, input: [{ type: 'text', text: 'perm live' }] });
    expect(live.mock.calls[0]?.[1].permission_mode).toBe('manual');
    live.mockRestore();
    await rpc.close();
  });
});

// ---------------------------------------------------------------------------
// toWireContent — the kosong PromptPart → protocol message content mapping
// the prompt/steer submissions depend on. Pure unit tests (no live server).
// ---------------------------------------------------------------------------

describe('toWireContent', () => {
  it('maps text parts verbatim', () => {
    expect(toWireContent({ type: 'text', text: 'hi' })).toEqual({ type: 'text', text: 'hi' });
  });

  it('maps image/video URL parts to url-kind media sources, forwarding the file id', () => {
    expect(
      toWireContent({
        type: 'image_url',
        imageUrl: { url: 'https://example.com/a.png', id: 'file_1' },
      }),
    ).toEqual({
      type: 'image',
      source: { kind: 'url', url: 'https://example.com/a.png', id: 'file_1' },
    });
    expect(
      toWireContent({ type: 'video_url', videoUrl: { url: 'https://example.com/v.mp4' } }),
    ).toEqual({
      type: 'video',
      source: { kind: 'url', url: 'https://example.com/v.mp4', id: undefined },
    });
  });
});

// ---------------------------------------------------------------------------
// SDKRpcClientWire resume replay — the replay-fidelity contract: the wire
// resume state must carry what the TUI's hydrateFromReplay consumes
// (apps/kimi-code session-replay.ts): agents.main.{replay, context, config,
// permission, plan, swarmMode, background, tools}. The stub provider makes
// every turn fail fast, but the user message persists before the turn runs —
// that is the history replay must render.
// ---------------------------------------------------------------------------

function replayUserTexts(main: { readonly replay: readonly unknown[] }): string[] {
  return (main.replay as Array<{ type: string; message?: { role: string; content: Array<{ type: string; text?: string }> } }>)
    .filter((record) => record.type === 'message' && record.message?.role === 'user')
    .map((record) =>
      (record.message?.content ?? [])
        .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
        .join(''),
    );
}

describe('SDKRpcClientWire resume replay', () => {
  it('populates agents.main replay state from the snapshot and messages', async () => {
    const rpc = new SDKRpcClientWire({ serverUrl: base, token, homeDir: home });
    await rpc.start();
    const http = new WireHttpClient({ baseUrl: base, token });
    const created = await rpc.createSession({ workDir: cwd });
    // The stub provider's turn now retries instead of dying instantly, so
    // abort each turn to settle the session quickly; the user message is
    // persisted on submit, before the turn runs — that is the history replay
    // must render.
    await rpc.prompt({ sessionId: created.id, input: [{ type: 'text', text: 'replay-one' }] });
    await rpc.cancel({ sessionId: created.id });
    await waitForAsync(async () => !(await http.getSession(created.id)).busy);
    await rpc.prompt({ sessionId: created.id, input: [{ type: 'text', text: 'replay-two' }] });
    await rpc.cancel({ sessionId: created.id });
    await waitForAsync(async () => !(await http.getSession(created.id)).busy);

    const resumed = await rpc.resumeSession({ id: created.id, replayTurnLimit: 10 });
    const main = resumed.agents['main'];
    expect(main).toBeDefined();
    expect(main?.type).toBe('main');

    // The replay records hydrateFromReplay renders: user/assistant/tool
    // messages with a numeric time each.
    for (const record of main?.replay ?? []) {
      expect(record.time).toEqual(expect.any(Number));
    }
    const userTexts = replayUserTexts(main ?? { replay: [] });
    expect(userTexts).toContain('replay-one');
    expect(userTexts).toContain('replay-two');

    // The snapshot fields appStateFromResumeAgent / hydrateSnapshot read.
    expect(main?.config.cwd).toBe(cwd);
    expect(main?.config.modelCapabilities.max_context_tokens).toBeGreaterThan(0);
    expect(main?.context.tokenCount).toEqual(expect.any(Number));
    expect(main?.context.history.some((m) => m.role === 'user')).toBe(true);
    expect(['manual', 'yolo', 'auto']).toContain(main?.permission.mode);
    expect(main?.plan).toBeNull();
    expect(main?.swarmMode).toEqual(expect.any(Boolean));
    expect(Array.isArray(main?.background)).toBe(true);
    expect(Array.isArray(main?.tools)).toBe(true);
    await rpc.close();
  });

  it('trims the replay to replayTurnLimit user turns', async () => {
    const rpc = new SDKRpcClientWire({ serverUrl: base, token, homeDir: home });
    await rpc.start();
    const http = new WireHttpClient({ baseUrl: base, token });
    const created = await rpc.createSession({ workDir: cwd });
    await rpc.prompt({ sessionId: created.id, input: [{ type: 'text', text: 'trim-one' }] });
    await rpc.cancel({ sessionId: created.id });
    await waitForAsync(async () => !(await http.getSession(created.id)).busy);
    await rpc.prompt({ sessionId: created.id, input: [{ type: 'text', text: 'trim-two' }] });
    await rpc.cancel({ sessionId: created.id });
    await waitForAsync(async () => !(await http.getSession(created.id)).busy);

    const resumed = await rpc.resumeSession({ id: created.id, replayTurnLimit: 1 });
    const userTexts = replayUserTexts(resumed.agents['main'] ?? { replay: [] });
    expect(userTexts).toContain('trim-two');
    expect(userTexts).not.toContain('trim-one');
    await rpc.close();
  });
});

// ---------------------------------------------------------------------------
// collectReplayMessages — the older-history paging behind the resume replay.
// Stubbed page source: the messages route serves newest-first pages, the
// helper must prepend them oldest-first and stop at the turn limit or at the
// end of history.
// ---------------------------------------------------------------------------

describe('collectReplayMessages', () => {
  function stubPageSource(pages: Array<{ items: WireMessage[]; has_more: boolean }>) {
    const calls: Array<string | undefined> = [];
    const fetchPage = async (beforeId?: string) => {
      calls.push(beforeId);
      const page = pages[calls.length - 1];
      if (page === undefined) throw new Error('unexpected extra page fetch');
      return page;
    };
    return { calls, fetchPage };
  }

  function stubMessage(id: string, text: string, role: 'user' | 'assistant' = 'user'): WireMessage {
    return {
      id,
      session_id: 's1',
      role,
      content: [{ type: 'text', text }],
      created_at: '2026-07-30T00:00:00.000Z',
    };
  }

  it('pages older history until the turn limit is covered, oldest-first', async () => {
    // Snapshot page (ascending): the newest three messages, one user turn.
    const firstPage = {
      items: [stubMessage('m3', 'newest'), stubMessage('m4', 'reply', 'assistant'), stubMessage('m5', 'latest')],
      has_more: true,
    };
    // Messages route page (newest-first): two older user turns.
    const olderPage = {
      items: [stubMessage('m2', 'second'), stubMessage('m1', 'first')],
      has_more: false,
    };
    const { calls, fetchPage } = stubPageSource([olderPage]);
    const messages = await collectReplayMessages(fetchPage, firstPage, 3);
    expect(calls).toEqual(['m3']);
    expect(messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
  });

  it('does not page when the snapshot already covers the turn limit', async () => {
    const firstPage = {
      items: [stubMessage('m1', 'only turn')],
      has_more: true,
    };
    const { calls, fetchPage } = stubPageSource([]);
    const messages = await collectReplayMessages(fetchPage, firstPage, 1);
    expect(calls).toEqual([]);
    expect(messages.map((m) => m.id)).toEqual(['m1']);
  });

  it('pages to the end of history when no turn limit is given', async () => {
    const firstPage = { items: [stubMessage('m3', 'c')], has_more: true };
    const pageTwo = { items: [stubMessage('m2', 'b')], has_more: true };
    const pageThree = { items: [stubMessage('m1', 'a')], has_more: false };
    const { calls, fetchPage } = stubPageSource([pageTwo, pageThree]);
    const messages = await collectReplayMessages(fetchPage, firstPage, undefined);
    expect(calls).toEqual(['m3', 'm2']);
    expect(messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('stops paging when a page makes no progress (pivot not found)', async () => {
    const firstPage = { items: [stubMessage('m3', 'c')], has_more: true };
    // The server answers with a page whose oldest id is the pivot itself —
    // continuing would loop forever on the same page.
    const stuckPage = { items: [stubMessage('m3', 'c')], has_more: true };
    const { calls, fetchPage } = stubPageSource([stuckPage, stuckPage]);
    const messages = await collectReplayMessages(fetchPage, firstPage, 5);
    expect(calls).toEqual(['m3']);
    expect(messages.map((m) => m.id)).toEqual(['m3']);
  });
});

// ---------------------------------------------------------------------------
// createKimiHarnessWire — the factory wires SDKRpcClientWire into a
// KimiHarness (awaiting the supervisor start before returning). Live server
// fixture from the lifecycle describes above.
// ---------------------------------------------------------------------------

describe('createKimiHarnessWire', () => {
  it('creates a harness that drives a full session lifecycle over the wire', async () => {
    const harness = await createKimiHarnessWire({
      serverUrl: base,
      token,
      homeDir: home,
      identity: TEST_IDENTITY,
    });
    const session = await harness.createSession({ workDir: cwd });
    expect(session.id).toBeTruthy();
    const summaries = await harness.listSessions({});
    expect(summaries.some((s) => s.id === session.id)).toBe(true);

    const resumed = await harness.resumeSession({ id: session.id });
    expect(resumed.id).toBe(session.id);

    await harness.deleteSession(session.id);
    // The default list excludes archived sessions (server contract)…
    const after = await harness.listSessions({});
    expect(after.some((s) => s.id === session.id)).toBe(false);
    // …and the session itself reads back archived:
    const http = new WireHttpClient({ baseUrl: base, token });
    expect((await http.getSession(session.id)).archived).toBe(true);
    await harness.close();
  });

  /**
   * Regression for the agents-view "dispatch then immediately attach" bug:
   * `createSession()` registers the session in `activeSessions` with
   * `resumeState` undefined (a create-time summary has no
   * `sessionMetadata`/`agents`). Attaching right after dispatch calls
   * `resumeSession` on that same, still-cached id with no `kaos`/
   * `agentProfile` — the exact shape agents-view's attach uses. The cache
   * hit must not hand back the untouched, unhydrated Session: it needs a
   * real resume (snapshot + subscribe) merged in, so the attached view can
   * render history and receive live events instead of "Session history is
   * unavailable for this session."
   */
  it('hydrates resume state on an immediate resume after createSession', async () => {
    const harness = await createKimiHarnessWire({
      serverUrl: base,
      token,
      homeDir: home,
      identity: TEST_IDENTITY,
    });
    try {
      const session = await harness.createSession({ workDir: cwd });
      expect(session.getResumeState()).toBeUndefined();
      await session.prompt('hi');

      const resumed = await harness.resumeSession({ id: session.id });

      // Identity is preserved (kaos-rebind / matching-profile callers rely
      // on getting the SAME Session object back on a cache hit) …
      expect(resumed).toBe(session);
      // … but it must now carry real resume state instead of the stale
      // create-time summary.
      expect(resumed.getResumeState()?.agents['main']).toBeDefined();

      await harness.deleteSession(session.id);
    } finally {
      await harness.close();
    }
  });
});
