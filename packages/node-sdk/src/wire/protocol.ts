import { z } from 'zod';

// ---------------------------------------------------------------------------
// REST envelope
// ---------------------------------------------------------------------------

export const envelopeSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    code: z.number().int(),
    msg: z.string(),
    data: data.nullable(),
    request_id: z.string(),
    details: z.unknown().optional(),
    stack: z.string().optional(),
  });

export type Envelope<T> = {
  readonly code: number;
  readonly msg: string;
  readonly data: T | null;
  readonly request_id: string;
  readonly details?: unknown;
  readonly stack?: string;
};

export class EnvelopeError<T = unknown> extends Error {
  readonly code: number;
  readonly requestId: string;
  readonly data: T | null;

  constructor(envelope: Envelope<T>) {
    super(`kap-server returned code=${envelope.code}: ${envelope.msg}`);
    this.name = 'EnvelopeError';
    this.code = envelope.code;
    this.requestId = envelope.request_id;
    this.data = envelope.data;
  }
}

/** Unwrap a success envelope; throws EnvelopeError on any non-zero code. */
export function unwrapEnvelope<T>(envelope: Envelope<T>): T {
  if (envelope.code !== 0) throw new EnvelopeError(envelope);
  if (envelope.data === null) {
    throw new EnvelopeError({ ...envelope, code: 50001, msg: 'success envelope had null data' });
  }
  return envelope.data;
}

// ---------------------------------------------------------------------------
// Session / workspace rows
// ---------------------------------------------------------------------------

export const isoDateTime = z.string().min(1);

export const wireSessionUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative(),
  cache_creation_tokens: z.number().int().nonnegative(),
  total_cost_usd: z.number().nonnegative(),
  context_tokens: z.number().int().nonnegative(),
  context_limit: z.number().int().nonnegative(),
  turn_count: z.number().int().nonnegative(),
});
export type WireSessionUsage = z.infer<typeof wireSessionUsageSchema>;

export const wirePendingInteractionSchema = z.enum(['none', 'approval', 'question']);

export const wireSessionMetadataSchema = z
  .object({ cwd: z.string().min(1) })
  .catchall(z.unknown());

export const wireSessionSchema = z.object({
  id: z.string().min(1),
  workspace_id: z.string().min(1),
  title: z.string(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
  busy: z.boolean(),
  main_turn_active: z.boolean().optional(),
  pending_interaction: wirePendingInteractionSchema.optional(),
  last_turn_reason: z.enum(['completed', 'cancelled', 'failed']).optional(),
  archived: z.boolean().optional(),
  current_prompt_id: z.string().min(1).optional(),
  last_prompt: z.string().optional(),
  metadata: wireSessionMetadataSchema,
  agent_config: z.object({ model: z.string() }).passthrough(),
  usage: wireSessionUsageSchema,
  permission_rules: z.array(z.unknown()),
  message_count: z.number().int().nonnegative(),
  last_seq: z.number().int().nonnegative(),
});
export type WireSession = z.infer<typeof wireSessionSchema>;

export const wireSessionPageSchema = z.object({
  items: z.array(wireSessionSchema),
  has_more: z.boolean(),
});
export type WireSessionPage = z.infer<typeof wireSessionPageSchema>;

export const wireWorkspaceSchema = z.object({
  id: z.string().min(1),
  root: z.string().min(1),
  name: z.string().min(1),
  created_at: isoDateTime,
  last_opened_at: isoDateTime,
  session_count: z.number().int().nonnegative(),
});
export type WireWorkspace = z.infer<typeof wireWorkspaceSchema>;

export const wireSessionStatusSchema = z.object({
  busy: z.boolean(),
  model: z.string().optional(),
  thinking_level: z.string(),
  permission: z.string(),
  plan_mode: z.boolean(),
  swarm_mode: z.boolean(),
  context_tokens: z.number().int().nonnegative(),
  max_context_tokens: z.number().int().nonnegative(),
  context_usage: z.number().min(0).max(1),
});
export type WireSessionStatus = z.infer<typeof wireSessionStatusSchema>;

export const wireSessionWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  severity: z.enum(['info', 'warning', 'error']),
});
export type WireSessionWarning = z.infer<typeof wireSessionWarningSchema>;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const wireMessageContentSchema = z
  .object({ type: z.string().min(1) })
  .passthrough();

export const wirePromptSubmitResultSchema = z.object({
  prompt_id: z.string().min(1),
  user_message_id: z.string().min(1),
  status: z.enum(['running', 'queued', 'blocked']),
  content: z.array(wireMessageContentSchema).min(1),
  created_at: isoDateTime,
});
export type WirePromptSubmitResult = z.infer<typeof wirePromptSubmitResultSchema>;

// ---------------------------------------------------------------------------
// Approvals / questions
// ---------------------------------------------------------------------------

export const wireApprovalRequestSchema = z.object({
  approval_id: z.string().min(1),
  session_id: z.string().min(1),
  turn_id: z.number().int().nonnegative().optional(),
  tool_call_id: z.string().min(1),
  tool_name: z.string().min(1),
  action: z.string(),
  tool_input_display: z.unknown(),
  created_at: isoDateTime,
  expires_at: isoDateTime,
});
export type WireApprovalRequest = z.infer<typeof wireApprovalRequestSchema>;

export interface WireApprovalResponse {
  readonly decision: 'approved' | 'rejected' | 'cancelled';
  readonly scope?: 'session';
  readonly feedback?: string;
  readonly selected_label?: string;
}

export const wireQuestionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});

export const wireQuestionItemSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  header: z.string().optional(),
  body: z.string().optional(),
  options: z.array(wireQuestionOptionSchema).min(2).max(4),
  multi_select: z.boolean().optional(),
  allow_other: z.boolean().optional(),
  other_label: z.string().optional(),
  other_description: z.string().optional(),
});

export const wireQuestionRequestSchema = z.object({
  question_id: z.string().min(1),
  session_id: z.string().min(1),
  turn_id: z.number().int().nonnegative().optional(),
  tool_call_id: z.string().min(1).optional(),
  questions: z.array(wireQuestionItemSchema).min(1).max(4),
  created_at: isoDateTime,
});
export type WireQuestionRequest = z.infer<typeof wireQuestionRequestSchema>;

export interface WireQuestionAnswer {
  readonly kind: 'single' | 'multi' | 'other' | 'multi_with_other' | 'skipped';
  readonly option_id?: string;
  readonly option_ids?: readonly string[];
  readonly text?: string;
  readonly other_text?: string;
}

export interface WireQuestionResponse {
  readonly answers: Record<string, WireQuestionAnswer>;
  readonly method?: 'enter' | 'space' | 'number_key' | 'click';
  readonly note?: string;
}

// ---------------------------------------------------------------------------
// Messages / snapshot
// ---------------------------------------------------------------------------

export const wireMessageSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  role: z.enum(['user', 'assistant', 'tool', 'system']),
  content: z.array(wireMessageContentSchema),
  created_at: isoDateTime,
  prompt_id: z.string().min(1).optional(),
  parent_message_id: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type WireMessage = z.infer<typeof wireMessageSchema>;

export const wireSnapshotSchema = z.object({
  as_of_seq: z.number().int().nonnegative(),
  epoch: z.string().min(1),
  session: wireSessionSchema,
  messages: z.object({ items: z.array(wireMessageSchema), has_more: z.boolean() }),
  in_flight_turn: z.unknown().nullable(),
  subagents: z.array(z.unknown()).optional(),
  pending_approvals: z.array(wireApprovalRequestSchema),
  pending_questions: z.array(wireQuestionRequestSchema),
});
export type WireSnapshot = z.infer<typeof wireSnapshotSchema>;

// ---------------------------------------------------------------------------
// WS control + event frames
// ---------------------------------------------------------------------------

export interface SessionCursor {
  readonly seq: number;
  readonly epoch?: string;
}

export const wsEventFrameSchema = z.object({
  type: z.string().min(1),
  seq: z.number().int().nonnegative(),
  epoch: z.string().optional(),
  volatile: z.boolean().optional(),
  offset: z.number().int().nonnegative().optional(),
  session_id: z.string().optional(),
  timestamp: isoDateTime,
  payload: z.object({ type: z.string().min(1) }).passthrough(),
});
export type WsEventFrame = z.infer<typeof wsEventFrameSchema>;

/** Control/ack frames are validated loosely; we only need type/id/code. */
export const wsFrameSchema = z.object({
  type: z.string().min(1),
  id: z.string().optional(),
  code: z.number().int().optional(),
  msg: z.string().optional(),
  timestamp: isoDateTime.optional(),
  payload: z.unknown().optional(),
});
export type WsFrame = z.infer<typeof wsFrameSchema>;

export const resyncRequiredPayloadSchema = z.object({
  session_id: z.string().min(1),
  reason: z.enum(['buffer_overflow', 'session_recreated', 'epoch_changed']),
  current_seq: z.number().int().nonnegative(),
  epoch: z.string().min(1).optional(),
});
export type ResyncRequiredPayload = z.infer<typeof resyncRequiredPayloadSchema>;

/** Event types that never advance a session cursor (server contract). */
export const VOLATILE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'assistant.delta',
  'thinking.delta',
  'tool.call.delta',
  'tool.progress',
  'shell.output',
  'shell.started',
  'shell.completed',
  'agent.status.updated',
]);
