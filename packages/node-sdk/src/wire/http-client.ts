import { z } from 'zod';

import {
  envelopeSchema,
  unwrapEnvelope,
  wireGoalSnapshotSchema,
  wireMessageSchema,
  wirePromptSubmitResultSchema,
  wireSessionPageSchema,
  wireSessionSchema,
  wireSessionStatusSchema,
  wireSessionWarningSchema,
  wireSnapshotSchema,
  wireWorkspaceSchema,
  type WireApprovalResponse,
  type WireGoalSnapshot,
  type WireMessage,
  type WirePromptSubmitResult,
  type WireQuestionResponse,
  type WireSession,
  type WireSessionPage,
  type WireSessionStatus,
  type WireSessionWarning,
  type WireSnapshot,
  type WireWorkspace,
} from './protocol';

export { EnvelopeError } from './protocol';

export interface WireHttpClientOptions {
  /** Loopback base URL, e.g. http://127.0.0.1:58627 */
  readonly baseUrl: string;
  readonly token: string;
}

export type WirePromptSubmission = {
  readonly content: readonly Record<string, unknown>[];
  readonly agent_id?: string;
  readonly profile?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly permission_mode?: 'manual' | 'yolo' | 'auto';
  readonly plan_mode?: boolean;
  readonly swarm_mode?: boolean;
  readonly disabled_tools?: readonly string[];
  readonly metadata?: Record<string, unknown>;
};

const API_PREFIX = '/api/v1';

export class WireHttpClient {
  constructor(private readonly options: WireHttpClientOptions) {}

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    dataSchema: z.ZodType<T>,
    tolerateCodes: readonly number[] = [],
    // Most routes treat a success envelope carrying `data: null` as a server
    // bug (`unwrapEnvelope` throws 50001) — but a few, like the goal read,
    // legitimately report null on success (no active goal). Those pass true
    // to return the envelope's data as-is on code 0 instead of throwing.
    allowNullData = false,
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${this.options.token}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`${this.options.baseUrl}${API_PREFIX}${path}`, init);
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `kap-server returned non-JSON ${res.status} for ${method} ${path}: ${text.slice(0, 200)}`,
      );
    }
    const envelope = envelopeSchema(dataSchema).parse(parsed);
    if (tolerateCodes.includes(envelope.code)) {
      return envelope.data as T;
    }
    if (allowNullData && envelope.code === 0) {
      return envelope.data as T;
    }
    return unwrapEnvelope(envelope);
  }

  listSessions(query: { workspace_id?: string } = {}): Promise<WireSessionPage> {
    const params = new URLSearchParams();
    if (query.workspace_id !== undefined) params.set('workspace_id', query.workspace_id);
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return this.request('GET', `/sessions${suffix}`, undefined, wireSessionPageSchema);
  }

  getSession(id: string): Promise<WireSession> {
    return this.request('GET', `/sessions/${id}`, undefined, wireSessionSchema);
  }

  getSessionStatus(id: string): Promise<WireSessionStatus> {
    return this.request('GET', `/sessions/${id}/status`, undefined, wireSessionStatusSchema);
  }

  createSession(body: { title?: string; metadata: { cwd: string } }): Promise<WireSession> {
    return this.request('POST', '/sessions', body, wireSessionSchema);
  }

  /** @internal Test-only: bypass the client-side cwd requirement. */
  createSessionRaw(body: Record<string, unknown>): Promise<WireSession> {
    return this.request('POST', '/sessions', body, wireSessionSchema);
  }

  updateSessionProfile(
    id: string,
    body: { title?: string; metadata?: Record<string, unknown> },
  ): Promise<WireSession> {
    return this.request('POST', `/sessions/${id}/profile`, body, wireSessionSchema);
  }

  sessionAction(id: string, action: 'archive' | 'restore' | 'abort'): Promise<unknown> {
    return this.request('POST', `/sessions/${id}:${action}`, {}, z.unknown());
  }

  compactSession(id: string, body: { instruction?: string }): Promise<unknown> {
    return this.request('POST', `/sessions/${id}:compact`, body, z.unknown());
  }

  undoSession(id: string, body: { count: number }): Promise<unknown> {
    return this.request('POST', `/sessions/${id}:undo`, body, z.unknown());
  }

  /** Steer queued prompts into the active turn (the literal `prompts:steer` route). */
  steerPrompts(id: string, body: { prompt_ids: readonly string[] }): Promise<unknown> {
    return this.request('POST', `/sessions/${id}/prompts:steer`, body, z.unknown());
  }

  async getSessionWarnings(id: string): Promise<WireSessionWarning[]> {
    const data = await this.request(
      'GET',
      `/sessions/${id}/warnings`,
      undefined,
      z.object({ warnings: z.array(wireSessionWarningSchema) }),
    );
    return data.warnings;
  }

  /** Null when the session has no active goal (server contract, not an error). */
  getSessionGoal(id: string): Promise<WireGoalSnapshot | null> {
    return this.request(
      'GET',
      `/sessions/${id}/goal`,
      undefined,
      wireGoalSnapshotSchema.nullable(),
      [],
      true,
    );
  }

  forkSession(
    id: string,
    body: { title?: string; metadata?: Record<string, unknown> },
  ): Promise<WireSession> {
    return this.request('POST', `/sessions/${id}:fork`, body, wireSessionSchema);
  }

  submitPrompt(id: string, body: WirePromptSubmission): Promise<WirePromptSubmitResult> {
    return this.request('POST', `/sessions/${id}/prompts`, body, wirePromptSubmitResultSchema);
  }

  async abortPrompt(id: string, promptId: string): Promise<void> {
    await this.request('POST', `/sessions/${id}/prompts/${promptId}:abort`, {}, z.unknown(), [
      40903,
    ]);
  }

  getSnapshot(id: string): Promise<WireSnapshot> {
    return this.request('GET', `/sessions/${id}/snapshot`, undefined, wireSnapshotSchema);
  }

  /**
   * Paged message read. Items come back NEWEST-FIRST (the route slices a
   * reversed transcript); `before_id` pages further into the past. The
   * `limit` option maps to the route's `page_size` field.
   */
  getMessages(
    id: string,
    query: { before_id?: string; limit?: number } = {},
  ): Promise<{ items: WireMessage[]; has_more: boolean }> {
    const params = new URLSearchParams();
    if (query.before_id !== undefined) params.set('before_id', query.before_id);
    if (query.limit !== undefined) params.set('page_size', String(query.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return this.request(
      'GET',
      `/sessions/${id}/messages${suffix}`,
      undefined,
      z.object({ items: z.array(wireMessageSchema), has_more: z.boolean() }),
    );
  }

  async resolveApproval(
    id: string,
    approvalId: string,
    body: WireApprovalResponse,
  ): Promise<void> {
    await this.request('POST', `/sessions/${id}/approvals/${approvalId}`, body, z.unknown(), [
      40902,
    ]);
  }

  async answerQuestion(id: string, questionId: string, body: WireQuestionResponse): Promise<void> {
    await this.request('POST', `/sessions/${id}/questions/${questionId}`, body, z.unknown());
  }

  async dismissQuestion(id: string, questionId: string): Promise<void> {
    await this.request('POST', `/sessions/${id}/questions/${questionId}:dismiss`, {}, z.unknown(), [
      40909,
    ]);
  }

  async listWorkspaces(): Promise<WireWorkspace[]> {
    const data = await this.request(
      'GET',
      '/workspaces',
      undefined,
      z.object({ items: z.array(wireWorkspaceSchema) }),
    );
    return data.items;
  }

  async getWorkspaceTrust(workspaceId: string): Promise<boolean> {
    const data = await this.request(
      'GET',
      `/workspaces/${workspaceId}/trust`,
      undefined,
      z.object({ trusted: z.boolean() }),
    );
    return data.trusted;
  }
}
