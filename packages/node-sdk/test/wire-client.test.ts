import { describe, expect, it } from 'vitest';

import type { WireApprovalRequest, WireQuestionRequest } from '#/wire/protocol';
import { InteractionBridge } from '#/wire/reverse-rpc';

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
