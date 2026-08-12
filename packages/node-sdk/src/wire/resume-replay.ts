/**
 * Wire resume replay — the wire transport's counterpart of
 * `v2/resume-replay.ts`. The v2 in-process client folds each agent's
 * `wire.jsonl` through a throwaway v1 `Agent` to rebuild the
 * `ResumedAgentState.replay` / `toolStore` pair; over the wire the journal is
 * not reachable, so the same state is rebuilt from the two REST surfaces the
 * server does expose:
 *
 *   - `GET /sessions/{id}/snapshot` — the newest ≤100 messages (chronological
 *     ascending), the session row (usage totals, agent_config), and the live
 *     subagent roster;
 *   - `GET /sessions/{id}/messages` — older history, paged backwards with
 *     `before_id` (newest-first pages) until the caller's `replayTurnLimit`
 *     in user turns is covered or the history runs out.
 *
 * Only `message` replay records exist here: compaction / goal / plan /
 * permission-change / approval records are journal ops the messages surface
 * does not carry, so a wire replay renders the conversation itself and skips
 * those status entries (v1 restores them from records; there is nothing to
 * map from). `origin` survives on `metadata.origin` (the server's
 * `toProtocolMessage` attaches the v1 `PromptOrigin` verbatim), so hook
 * results, `!` shell commands, skill/plugin activations, cron fires, and
 * background-task notifications still render through their replay branches.
 *
 * Deliberate degrades (nothing on the wire to map from; never fabricated):
 *   - `toolStore` is undefined — the todo panel resets to empty on attach;
 *   - `plan` is null — plan-mode content has no route, so the plan-mode badge
 *     reads OFF after attach even when the session is in plan mode;
 *   - `permission.rules` is empty — the wire `permission_rules` vocabulary
 *     (sessionLegacy's `permissionRuleSchema`) is not v1's `PermissionRule`
 *     shape; the mode is the field the TUI reads;
 *   - `background` covers `subagent`-kind tasks only: `bash` tasks map to v1's
 *     `process` kind, whose required `pid` the wire never exposes, and `tool`
 *     tasks have no v1 kind at all. Wire `cancelled` reads as `killed`, the
 *     nearest terminal status in v1's vocabulary;
 *   - `tools` is empty — the tool list is not part of the snapshot surface.
 */

import { isAgentReplayUserTurnRecord, limitAgentReplayByTurns } from '@moonshot-ai/agent-core';
import { UNKNOWN_CAPABILITY } from '@moonshot-ai/kosong';

import type {
  AgentBackgroundTaskInfo,
  AgentReplayRecord,
  ContentPart,
  ContextMessage,
  PermissionMode,
  PromptOrigin,
  ResumedAgentState,
  ToolCall,
} from '#/types';

import type {
  WireMessage,
  WireSessionStatus,
  WireSnapshot,
  WireSnapshotSubagent,
} from './protocol';

/**
 * Best-effort `WireMessage` → `ContextMessage` projection. Text, thinking,
 * URL media, tool_use (→ `toolCalls`), and tool_result (→ a `tool` message's
 * `toolCallId` + content, with `is_error` → `isError`) survive; a tool result
 * carrying media passes the raw kosong content-part array through (the shape
 * the server projects and the live event stream carries). Base64/file media
 * sources and `file` parts have no kosong equivalent and drop out. The v1
 * `PromptOrigin` rides `metadata.origin` verbatim.
 */
export function wireMessageToContextMessage(message: WireMessage): ContextMessage {
  const content: ContentPart[] = [];
  const toolCalls: ToolCall[] = [];
  let toolCallId: string | undefined;
  let isError: boolean | undefined;
  for (const raw of message.content) {
    const part: Record<string, unknown> = raw;
    switch (part['type']) {
      case 'text':
        content.push({ type: 'text', text: part['text'] as string });
        break;
      case 'thinking':
        content.push({
          type: 'think',
          think: part['thinking'] as string,
          encrypted: part['signature'] as string | undefined,
        });
        break;
      case 'image':
      case 'video': {
        const source = part['source'] as { kind?: string; url?: string; id?: string } | undefined;
        if (source?.kind === 'url' && source.url !== undefined) {
          content.push(
            part['type'] === 'image'
              ? { type: 'image_url', imageUrl: { url: source.url, id: source.id } }
              : { type: 'video_url', videoUrl: { url: source.url, id: source.id } },
          );
        }
        break;
      }
      case 'tool_use':
        toolCalls.push({
          type: 'function',
          id: part['tool_call_id'] as string,
          name: part['tool_name'] as string,
          arguments: JSON.stringify(part['input'] ?? null),
        });
        break;
      case 'tool_result': {
        toolCallId = part['tool_call_id'] as string;
        isError = part['is_error'] === true ? true : undefined;
        const output = part['output'];
        if (typeof output === 'string') {
          content.push({ type: 'text', text: output });
        } else if (Array.isArray(output)) {
          content.push(...(output as ContentPart[]));
        } else {
          content.push({ type: 'text', text: JSON.stringify(output ?? null) });
        }
        break;
      }
    }
  }
  return {
    role: message.role,
    content,
    toolCalls,
    toolCallId,
    origin: message.metadata?.['origin'] as PromptOrigin | undefined,
    isError,
  };
}

/** One wire message → one `message` replay record (the only kind the wire carries). */
export function wireMessageToReplayRecord(message: WireMessage): AgentReplayRecord {
  return {
    time: Date.parse(message.created_at),
    type: 'message',
    message: wireMessageToContextMessage(message),
  };
}

export interface ReplayMessagePage {
  /** Newest-first for paged reads; the snapshot's first page is ascending. */
  readonly items: readonly WireMessage[];
  readonly has_more: boolean;
}

function countReplayUserTurns(messages: readonly WireMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (isAgentReplayUserTurnRecord(wireMessageToReplayRecord(message))) count += 1;
  }
  return count;
}

/**
 * Assemble the full ascending message window behind a resume. The snapshot's
 * first page is already ascending; older pages come back newest-first and are
 * reversed before prepending. Paging stops once the window covers
 * `replayTurnLimit` user turns (agent-core's `limitAgentReplayByTurns` trims
 * the exact boundary afterwards), at the end of history, or when a page makes
 * no progress (the pivot id is still the page's newest item — a defensive
 * break against a misbehaving peer looping the same page forever).
 */
export async function collectReplayMessages(
  fetchPage: (beforeId: string) => Promise<ReplayMessagePage>,
  firstPage: ReplayMessagePage,
  replayTurnLimit?: number,
): Promise<WireMessage[]> {
  const messages = [...firstPage.items];
  let hasMore = firstPage.has_more;
  let needsMore =
    replayTurnLimit === undefined || countReplayUserTurns(messages) < replayTurnLimit;
  while (hasMore && needsMore) {
    const oldest = messages[0];
    if (oldest === undefined) break;
    const page = await fetchPage(oldest.id);
    if (page.items.length === 0) break;
    const ascending = page.items.toReversed();
    if (ascending.at(-1)?.id === oldest.id) break;
    messages.unshift(...ascending);
    hasMore = page.has_more;
    needsMore =
      replayTurnLimit === undefined || countReplayUserTurns(messages) < replayTurnLimit;
  }
  return messages;
}

/**
 * The snapshot's live subagent roster entry → v1 `AgentBackgroundTaskInfo`.
 * Only `subagent`-kind tasks map (see the module header for the drops).
 */
function wireSubagentToBackgroundTaskInfo(
  subagent: WireSnapshotSubagent,
): AgentBackgroundTaskInfo | undefined {
  if (subagent.kind !== 'subagent') return undefined;
  return {
    kind: 'agent',
    taskId: subagent.id,
    description: subagent.description,
    status: subagent.status === 'cancelled' ? 'killed' : subagent.status,
    startedAt: Date.parse(subagent.started_at ?? subagent.created_at),
    endedAt: subagent.completed_at !== undefined ? Date.parse(subagent.completed_at) : null,
    agentId: subagent.id,
    subagentType: subagent.subagent_type,
    detached: subagent.run_in_background,
  };
}

/**
 * Build the `main` agent's `ResumedAgentState` from wire data. Field sources
 * mirror v2's `resumedAgentState` scope reads: the status surface supplies
 * the live model / thinking / permission / plan / swarm switches and context
 * limits, the session row supplies the usage totals, and the paged message
 * window supplies `context.history` and the `replay` records (trimmed to
 * `replayTurnLimit` user turns via the shared `limitAgentReplayByTurns`).
 * `modelCapabilities` is kosong's unknown-capability default with the real
 * context limit overlaid — the only capability the wire reports.
 */
export function buildResumedMainAgentState(
  snapshot: WireSnapshot,
  status: WireSessionStatus,
  messages: readonly WireMessage[],
  replayTurnLimit?: number,
): ResumedAgentState {
  const usage = snapshot.session.usage;
  return {
    type: 'main',
    config: {
      cwd: snapshot.session.metadata.cwd,
      provider: undefined,
      modelAlias: status.model ?? snapshot.session.agent_config.model,
      modelCapabilities: {
        ...UNKNOWN_CAPABILITY,
        max_context_tokens: status.max_context_tokens,
      },
      thinkingEffort: status.thinking_level,
      systemPrompt: snapshot.session.agent_config.system_prompt ?? '',
    },
    context: {
      history: messages.map(wireMessageToContextMessage),
      tokenCount: usage.context_tokens,
    },
    replay: limitAgentReplayByTurns(messages.map(wireMessageToReplayRecord), replayTurnLimit),
    permission: { mode: status.permission as PermissionMode, rules: [] },
    plan: null,
    swarmMode: status.swarm_mode,
    usage: {
      total: {
        inputOther: usage.input_tokens,
        output: usage.output_tokens,
        inputCacheRead: usage.cache_read_tokens,
        inputCacheCreation: usage.cache_creation_tokens,
      },
      byModel: undefined,
      currentTurn: undefined,
    },
    tools: [],
    toolStore: undefined,
    background: (snapshot.subagents ?? [])
      .map(wireSubagentToBackgroundTaskInfo)
      .filter((info) => info !== undefined),
  };
}
