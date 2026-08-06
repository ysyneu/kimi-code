import type { Event, SessionSummary, WireSession } from '@moonshot-ai/kimi-code-sdk';

export interface AgentsRosterRow {
  readonly id: string;
  readonly title: string;
  readonly lastPrompt?: string;
  readonly lastAssistantText?: string;
  readonly workDir: string;
  readonly updatedAt: number;
  readonly busy: boolean;
  readonly pendingInteraction: 'none' | 'approval' | 'question';
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
  readonly pinned: boolean;
  readonly trusted?: boolean;
  /**
   * Has new output since the row was last opened/attached — orthogonal to
   * `busy`/`pendingInteraction`/group membership. Derived from comparing
   * `updatedAt` against the roster's `seenAt` map; cleared by `markSeen`.
   */
  readonly unseen: boolean;
}

export type AgentsGroupId = 'awaiting' | 'working' | 'pinned' | 'completed';

export interface AgentsGroup {
  readonly id: AgentsGroupId;
  readonly label: string;
  readonly rows: readonly AgentsRosterRow[];
}

export interface AgentsRosterCounts {
  readonly awaiting: number;
  readonly working: number;
  readonly completed: number;
}

type MutableRow = { -readonly [K in keyof AgentsRosterRow]: AgentsRosterRow[K] };

const GROUP_ORDER: readonly AgentsGroupId[] = ['pinned', 'awaiting', 'working', 'completed'];

const GROUP_LABELS: Record<AgentsGroupId, string> = {
  pinned: 'Pinned',
  awaiting: 'Needs input',
  working: 'Working',
  completed: 'Completed',
};

const DEFAULT_PAGE_SIZE = 10;

function groupOf(row: AgentsRosterRow): AgentsGroupId {
  if (row.pendingInteraction !== 'none') return 'awaiting';
  if (row.busy) return 'working';
  if (row.pinned) return 'pinned';
  return 'completed';
}

/**
 * Pure state container for the agents view: rows arrive via `setAll` plus the
 * three global SDK events (`session.meta.updated`, `event.session.work_changed`,
 * `event.session.created` — their payloads keep the wire field names, e.g.
 * `pending_interaction` / `last_turn_reason` / `last_prompt` / `last_assistant_text`),
 * and the view
 * derives groups/counts from `groups()` / `counts()`. Zero pi-tui dependencies.
 *
 * The roster mutates the pins set handed to the constructor (it is the same
 * `Set` `loadPins` returned), so the controller can persist that same set
 * after every `setPinned`. `seenAt` is mutated the same way for `markSeen`.
 */
export class AgentsRoster {
  private readonly rows = new Map<string, MutableRow>();
  private readonly pins: Set<string>;
  private readonly seenAt: Map<string, number>;

  constructor(pins: ReadonlySet<string>, seenAt: ReadonlyMap<string, number> = new Map()) {
    this.pins = pins as Set<string>;
    this.seenAt = seenAt as Map<string, number>;
  }

  /** unseen = the row's latest activity is newer than the last time it was opened. */
  private isUnseen(id: string, updatedAt: number): boolean {
    return updatedAt > (this.seenAt.get(id) ?? -Infinity);
  }

  /** Clears the unseen bit for `id` and records the moment it was viewed. */
  markSeen(id: string): void {
    const row = this.rows.get(id);
    if (row === undefined) return;
    this.seenAt.set(id, row.updatedAt);
    row.unseen = false;
  }

  setAll(summaries: readonly SessionSummary[]): void {
    this.rows.clear();
    for (const session of summaries) {
      if (session.archived === true) continue;
      this.rows.set(session.id, {
        id: session.id,
        title: session.title ?? '',
        lastPrompt: session.lastPrompt,
        lastAssistantText: session.lastAssistantText,
        workDir: session.workDir,
        updatedAt: session.updatedAt,
        busy: false,
        pendingInteraction: 'none',
        pinned: this.pins.has(session.id),
        unseen: this.isUnseen(session.id, session.updatedAt),
      });
    }
  }

  /**
   * Rich seed from the wire session rows (`SDKRpcClientWire.listSessionRows`):
   * `GET /sessions` carries `busy` / `pending_interaction` / `last_turn_reason`
   * that `SessionSummary` drops, and the global `work_changed` fan-out has no
   * connect-time snapshot — without this a cold-open (or post-reconnect)
   * roster shows live sessions as Completed. Existing `trusted` badges survive:
   * the wire rows carry no trust info, so a refresh must not erase them.
   */
  setAllRows(rows: readonly WireSession[]): void {
    const trusted = new Map<string, boolean>();
    for (const [id, row] of this.rows) {
      if (row.trusted !== undefined) trusted.set(id, row.trusted);
    }
    this.rows.clear();
    for (const session of rows) {
      if (session.archived === true) continue;
      const updatedAt = Date.parse(session.updated_at);
      this.rows.set(session.id, {
        id: session.id,
        title: session.title,
        lastPrompt: session.last_prompt,
        lastAssistantText: session.last_assistant_text,
        workDir: session.metadata.cwd,
        updatedAt,
        busy: session.busy,
        pendingInteraction: session.pending_interaction ?? 'none',
        lastTurnReason: session.last_turn_reason,
        pinned: this.pins.has(session.id),
        trusted: trusted.get(session.id),
        unseen: this.isUnseen(session.id, updatedAt),
      });
    }
  }

  applyEvent(event: Event): void {
    switch (event.type) {
      case 'session.meta.updated': {
        const row = this.rows.get(event.sessionId);
        if (row === undefined) return;
        if (typeof event.title === 'string') row.title = event.title;
        const patch = event.patch;
        if (patch !== undefined && typeof patch['lastPrompt'] === 'string') {
          row.lastPrompt = patch['lastPrompt'];
        }
        if (patch !== undefined && typeof patch['lastAssistantText'] === 'string') {
          row.lastAssistantText = patch['lastAssistantText'];
        }
        row.updatedAt = Date.now();
        row.unseen = this.isUnseen(row.id, row.updatedAt);
        return;
      }
      case 'event.session.work_changed': {
        const row = this.rows.get(event.sessionId);
        if (row === undefined) return;
        row.busy = event.busy;
        row.pendingInteraction = event.pending_interaction ?? 'none';
        if (event.last_turn_reason !== undefined) row.lastTurnReason = event.last_turn_reason;
        row.updatedAt = Date.now();
        row.unseen = this.isUnseen(row.id, row.updatedAt);
        return;
      }
      case 'event.session.created': {
        const session = event.session;
        const updatedAt = Date.parse(session.updated_at);
        this.rows.set(session.id, {
          id: session.id,
          title: session.title,
          lastPrompt: session.last_prompt,
          lastAssistantText: session.last_assistant_text,
          workDir: session.metadata.cwd,
          updatedAt,
          busy: session.busy,
          pendingInteraction: session.pending_interaction ?? 'none',
          lastTurnReason: session.last_turn_reason,
          pinned: this.pins.has(session.id),
          unseen: this.isUnseen(session.id, updatedAt),
        });
        return;
      }
      default:
        return;
    }
  }

  setPinned(id: string, pinned: boolean): void {
    if (pinned) this.pins.add(id);
    else this.pins.delete(id);
    const row = this.rows.get(id);
    if (row !== undefined) row.pinned = pinned;
  }

  /** Drops a row (e.g. after the controller archived the session). */
  remove(id: string): void {
    this.rows.delete(id);
  }

  /** Local title rewrite for the optimistic rename path; the server's
   *  `session.meta.updated` echo confirms or the controller rolls back. */
  setTitle(id: string, title: string): void {
    const row = this.rows.get(id);
    if (row !== undefined) row.title = title;
  }

  setTrusted(id: string, trusted: boolean | undefined): void {
    const row = this.rows.get(id);
    if (row !== undefined) row.trusted = trusted;
  }

  groups(pageSize = DEFAULT_PAGE_SIZE): readonly AgentsGroup[] {
    const buckets: Record<AgentsGroupId, MutableRow[]> = {
      awaiting: [],
      working: [],
      pinned: [],
      completed: [],
    };
    for (const row of this.rows.values()) buckets[groupOf(row)].push(row);
    const groups: AgentsGroup[] = [];
    for (const id of GROUP_ORDER) {
      const rows = buckets[id];
      if (rows.length === 0) continue;
      if (id === 'pinned') {
        // Manually reorderable (shift+↑↓ — see `reorderPinned`): display
        // order follows the pins Set's insertion order, not recency.
        const order = new Map<string, number>();
        let i = 0;
        for (const pinnedId of this.pins) order.set(pinnedId, i++);
        rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      } else {
        rows.sort((a, b) => b.updatedAt - a.updatedAt);
      }
      groups.push({
        id,
        label: GROUP_LABELS[id],
        rows: id === 'completed' ? rows.slice(0, pageSize) : rows,
      });
    }
    return groups;
  }

  /**
   * Moves a pinned row by `delta` (-1 up / +1 down) within the pins Set's
   * insertion order — the pinned group's display order (see `groups`
   * above). No-op for a row that is not pinned/known, or a move that would
   * run off either end. Rebuilds `pins` in place (same object reference the
   * constructor received — Sets have no splice), so the controller's
   * existing "persist the pins set after every mutation" flow picks up the
   * new order unchanged.
   */
  reorderPinned(id: string, delta: -1 | 1): void {
    const row = this.rows.get(id);
    if (row === undefined || !row.pinned) return;
    const order = [...this.pins];
    const from = order.indexOf(id);
    if (from === -1) return;
    const to = from + delta;
    if (to < 0 || to >= order.length) return;
    const swap = order[to]!;
    order[to] = order[from]!;
    order[from] = swap;
    this.pins.clear();
    for (const pinnedId of order) this.pins.add(pinnedId);
  }

  /**
   * Aggregate counts per group. `excludeId` drops one row from the tally —
   * the attach-mode footer badge counts only OTHER sessions (the attached
   * one is on screen, not badge-worthy).
   */
  counts(excludeId?: string): AgentsRosterCounts {
    let awaiting = 0;
    let working = 0;
    let completed = 0;
    for (const row of this.rows.values()) {
      if (row.id === excludeId) continue;
      const group = groupOf(row);
      if (group === 'awaiting') awaiting += 1;
      else if (group === 'working') working += 1;
      else completed += 1;
    }
    return { awaiting, working, completed };
  }

  get(id: string): AgentsRosterRow | undefined {
    return this.rows.get(id);
  }
}
