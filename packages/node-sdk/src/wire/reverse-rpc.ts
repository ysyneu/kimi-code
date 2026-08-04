/**
 * InteractionBridge — routes wire interaction events
 * (`event.approval.requested` / `event.question.requested`) to the SDK
 * handler callbacks and POSTs the resolution back over REST. Ported from
 * `packages/klient/test/e2e/harness/reverse-rpc.ts`, with the klient
 * harness's ws subscription replaced by `handleEvent` (fed by the translated
 * event stream) plus `replayPending` for snapshot-driven re-feeding after
 * attach/resync.
 *
 * Fail-safe contract (mirrors the base-class semantics in `src/rpc.ts`):
 * a throwing approval handler resolves `{ decision: 'cancelled' }`, a
 * throwing/null question handler dismisses, and POST failures are logged —
 * nothing ever throws into the event stream.
 *
 * Dedupe: every interaction id is fed to its handler at most once for the
 * lifetime of the bridge — the same pending item can arrive both via
 * snapshot replay and a live event (and again after a resync).
 */
import type {
  ApprovalRequest,
  ApprovalResponse,
  MaybePromise,
  QuestionAnswers,
  QuestionRequest,
  QuestionResponse,
  QuestionResult,
  ToolInputDisplay,
} from '../events';
import type { WireHttpClient } from './http-client';
import {
  wireApprovalRequestSchema,
  wireQuestionRequestSchema,
  type WireApprovalRequest,
  type WireApprovalResponse,
  type WireQuestionAnswer,
  type WireQuestionRequest,
  type WireQuestionResponse,
  type WireSnapshot,
} from './protocol';
import type { WsLogger } from './ws-connection';

export type BridgedApprovalRequest = ApprovalRequest & {
  readonly sessionId: string;
  readonly agentId: string;
};

export type BridgedQuestionRequest = QuestionRequest & {
  readonly sessionId: string;
  readonly agentId: string;
};

export interface InteractionBridgeOptions {
  readonly http: Pick<WireHttpClient, 'resolveApproval' | 'answerQuestion' | 'dismissQuestion'>;
  readonly requestApproval: (request: BridgedApprovalRequest) => MaybePromise<ApprovalResponse>;
  readonly requestQuestion: (request: BridgedQuestionRequest) => MaybePromise<QuestionResult>;
  readonly logger?: WsLogger;
}

const noopLogger: WsLogger = () => {};

export class InteractionBridge {
  private readonly http: InteractionBridgeOptions['http'];
  private readonly requestApproval: InteractionBridgeOptions['requestApproval'];
  private readonly requestQuestion: InteractionBridgeOptions['requestQuestion'];
  private readonly logger: WsLogger;
  /** Interaction ids already fed to a handler — `approval:<id>` / `question:<id>`. */
  private readonly seen = new Set<string>();

  constructor(options: InteractionBridgeOptions) {
    this.http = options.http;
    this.requestApproval = options.requestApproval;
    this.requestQuestion = options.requestQuestion;
    this.logger = options.logger ?? noopLogger;
  }

  /** Feed one translated wire event; unknown/malformed events are ignored. */
  handleEvent(event: { type: string; [key: string]: unknown }): void {
    if (event.type === 'event.approval.requested') {
      const parsed = wireApprovalRequestSchema.safeParse(event);
      if (!parsed.success) {
        this.logger('warn', 'interaction-bridge: malformed event.approval.requested', {
          err: parsed.error.message,
        });
        return;
      }
      const agentId = typeof event['agentId'] === 'string' ? event['agentId'] : 'main';
      this.dispatchApproval(parsed.data, agentId);
      return;
    }
    if (event.type === 'event.question.requested') {
      const parsed = wireQuestionRequestSchema.safeParse(event);
      if (!parsed.success) {
        this.logger('warn', 'interaction-bridge: malformed event.question.requested', {
          err: parsed.error.message,
        });
        return;
      }
      const agentId = typeof event['agentId'] === 'string' ? event['agentId'] : 'main';
      this.dispatchQuestion(parsed.data, agentId);
    }
  }

  /** Re-feed pending interactions from a snapshot after attach/resync. */
  replayPending(
    sessionId: string,
    snapshot: Pick<WireSnapshot, 'pending_approvals' | 'pending_questions'>,
  ): void {
    for (const approval of snapshot.pending_approvals) {
      // The snapshot is the session aggregate; the payload's session_id is
      // authoritative when present (it always is, per the schema).
      if (approval.session_id !== sessionId) continue;
      this.dispatchApproval(approval, 'main');
    }
    for (const question of snapshot.pending_questions) {
      if (question.session_id !== sessionId) continue;
      this.dispatchQuestion(question, 'main');
    }
  }

  private dispatchApproval(request: WireApprovalRequest, agentId: string): void {
    if (!this.markSeen(`approval:${request.approval_id}`)) return;
    void this.resolveApproval(request, agentId).catch((err) => {
      this.logger('warn', 'interaction-bridge: approval resolve failed', {
        err: String(err),
        sessionId: request.session_id,
        approvalId: request.approval_id,
      });
    });
  }

  private dispatchQuestion(request: WireQuestionRequest, agentId: string): void {
    if (!this.markSeen(`question:${request.question_id}`)) return;
    void this.resolveQuestion(request, agentId).catch((err) => {
      this.logger('warn', 'interaction-bridge: question resolve failed', {
        err: String(err),
        sessionId: request.session_id,
        questionId: request.question_id,
      });
    });
  }

  /** Returns false when the id was already fed to a handler. */
  private markSeen(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  private async resolveApproval(request: WireApprovalRequest, agentId: string): Promise<void> {
    let response: ApprovalResponse;
    try {
      response = await this.requestApproval({
        turnId: request.turn_id,
        toolCallId: request.tool_call_id,
        toolName: request.tool_name,
        action: request.action,
        display: request.tool_input_display as ToolInputDisplay,
        sessionId: request.session_id,
        agentId,
      });
    } catch (err) {
      this.logger('warn', 'interaction-bridge: approval handler threw, cancelling', {
        err: String(err),
        approvalId: request.approval_id,
      });
      response = { decision: 'cancelled', feedback: 'Approval handler failed.' };
    }
    const body: WireApprovalResponse = {
      decision: response.decision,
      scope: response.scope,
      feedback: response.feedback,
      selected_label: response.selectedLabel,
    };
    await this.http.resolveApproval(request.session_id, request.approval_id, body);
  }

  private async resolveQuestion(request: WireQuestionRequest, agentId: string): Promise<void> {
    let result: QuestionResult;
    try {
      result = await this.requestQuestion({
        turnId: request.turn_id,
        toolCallId: request.tool_call_id,
        questions: request.questions.map((q) => ({
          question: q.question,
          header: q.header,
          body: q.body,
          options: q.options.map((o) => ({ label: o.label, description: o.description })),
          multiSelect: q.multi_select,
          otherLabel: q.other_label,
          otherDescription: q.other_description,
        })),
        sessionId: request.session_id,
        agentId,
      });
    } catch (err) {
      this.logger('warn', 'interaction-bridge: question handler threw, dismissing', {
        err: String(err),
        questionId: request.question_id,
      });
      result = null;
    }
    if (result === null) {
      await this.http.dismissQuestion(request.session_id, request.question_id);
      return;
    }
    await this.http.answerQuestion(
      request.session_id,
      request.question_id,
      toWireQuestionResponse(result, request),
    );
  }
}

/**
 * SDK `QuestionResult` → protocol REST body. The SDK flattens answers to
 * `Record<question text, option label(s) | free text | true>` (multi-select
 * labels joined with ', '); the wire wants the inverse — ids keyed by
 * question id with a 5-kind answer union — so labels are resolved back to
 * option ids using the original wire `request`:
 *   - exact option label             → single
 *   - ', '-joined labels (multi only)→ multi   (every part must resolve)
 *   - anything else                  → other (free text)
 *   - `true` (answered, no value)    → entry omitted (no wire equivalent)
 * Unknown question texts keep the raw text as the key, mirroring the
 * server-side adapter's defensive fallback for unknown ids.
 */
function toWireQuestionResponse(
  result: QuestionAnswers | QuestionResponse,
  request: WireQuestionRequest,
): WireQuestionResponse {
  const normalized = normalizeResult(result);
  const answers: Record<string, WireQuestionAnswer> = {};
  for (const [text, value] of Object.entries(normalized.answers)) {
    if (value === true) continue;
    const item = request.questions.find((q) => q.question === text);
    const qid = item?.id ?? text;
    const single = item?.options.find((o) => o.label === value);
    if (single !== undefined) {
      answers[qid] = { kind: 'single', option_id: single.id };
      continue;
    }
    if (item?.multi_select === true) {
      const parts = value.split(', ');
      if (parts.length > 1) {
        const ids = parts.map((p) => item.options.find((o) => o.label === p)?.id);
        if (ids.every((id): id is string => id !== undefined)) {
          answers[qid] = { kind: 'multi', option_ids: ids };
          continue;
        }
      }
    }
    answers[qid] = { kind: 'other', text: value };
  }
  return { answers, method: normalized.method };
}

/**
 * `QuestionResult` (minus null) is either a bare flattened record or a
 * `{ answers, method? }` wrapper. The wrapper is the only shape whose
 * `answers` value is itself a record — a bare record's values are
 * `string | true`, so the discriminator is unambiguous.
 */
function normalizeResult(result: QuestionAnswers | QuestionResponse): QuestionResponse {
  const candidate = (result as QuestionResponse).answers;
  if (typeof candidate === 'object' && candidate !== null) {
    return result as QuestionResponse;
  }
  return { answers: result as QuestionAnswers };
}
