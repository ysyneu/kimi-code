import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Event, SessionSummary, WireSession } from '@moonshot-ai/kimi-code-sdk';

import { AgentsRoster } from '#/tui/agents/roster';
import { loadAgentsViewState, saveAgentsViewState } from '#/tui/agents/roster-persistence';

/** A full wire session row (what `SDKRpcClientWire.listSessionRows` serves). */
function wireRow(id: string, overrides: Partial<WireSession> = {}): WireSession {
  return {
    id,
    workspace_id: 'ws_1',
    title: `session ${id}`,
    created_at: '2026-07-30T00:00:00.000Z',
    updated_at: '2026-07-30T01:00:00.000Z',
    busy: false,
    pending_interaction: 'none',
    metadata: { cwd: `/work/${id}` },
    agent_config: { model: 'k2' },
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_cost_usd: 0,
      context_tokens: 0,
      context_limit: 0,
      turn_count: 0,
    },
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
    ...overrides,
  };
}

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    workDir: `/work/${id}`,
    sessionDir: '',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function workChanged(
  sessionId: string,
  fields: {
    busy: boolean;
    pending_interaction?: 'none' | 'approval' | 'question';
    last_turn_reason?: 'completed' | 'cancelled' | 'failed';
  },
): Event {
  return { type: 'event.session.work_changed', agentId: 'main', sessionId, ...fields };
}

function metaUpdated(sessionId: string, fields: { title?: string; patch?: Record<string, unknown> }): Event {
  return { type: 'session.meta.updated', agentId: 'main', sessionId, ...fields };
}

function sessionCreated(
  id: string,
  overrides: {
    title?: string;
    updated_at?: string;
    busy?: boolean;
    pending_interaction?: 'none' | 'approval' | 'question';
    last_prompt?: string;
    last_assistant_text?: string;
    cwd?: string;
  } = {},
): Event {
  return {
    type: 'event.session.created',
    agentId: 'main',
    sessionId: id,
    session: {
      id,
      workspace_id: 'ws_1',
      title: overrides.title ?? `session ${id}`,
      created_at: '2026-07-30T00:00:00.000Z',
      updated_at: overrides.updated_at ?? '2026-07-30T01:00:00.000Z',
      busy: overrides.busy ?? false,
      pending_interaction: overrides.pending_interaction,
      metadata: { cwd: overrides.cwd ?? `/work/${id}` },
      agent_config: { model: 'k2' },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        total_cost_usd: 0,
        context_tokens: 0,
        context_limit: 0,
        turn_count: 0,
      },
      permission_rules: [],
      message_count: 0,
      last_seq: 0,
      last_prompt: overrides.last_prompt,
      last_assistant_text: overrides.last_assistant_text,
    },
  };
}

function groupIds(roster: AgentsRoster): string[] {
  return roster.groups().map((group) => group.id);
}

function groupRows(roster: AgentsRoster, id: 'awaiting' | 'working' | 'pinned' | 'completed') {
  return roster.groups().find((group) => group.id === id)?.rows ?? [];
}

describe('AgentsRoster', () => {
  it('setAll filters archived sessions and sorts each group by updatedAt desc', () => {
    const roster = new AgentsRoster(new Set());
    roster.setAll([
      summary('a', { updatedAt: 100 }),
      summary('b', { updatedAt: 400, archived: true }),
      summary('c', { updatedAt: 300 }),
      summary('d', { updatedAt: 200 }),
    ]);

    expect(roster.get('b')).toBeUndefined();
    expect(groupRows(roster, 'completed').map((row) => row.id)).toEqual(['c', 'd', 'a']);
    expect(roster.counts()).toEqual({ awaiting: 0, working: 0, completed: 3 });
  });

  it('work_changed with pending approval moves the row into the awaiting group', () => {
    const roster = new AgentsRoster(new Set());
    roster.setAll([summary('a'), summary('b')]);

    roster.applyEvent(workChanged('a', { busy: true, pending_interaction: 'approval' }));

    expect(groupIds(roster)).toEqual(['awaiting', 'completed']);
    expect(groupRows(roster, 'awaiting').map((row) => row.id)).toEqual(['a']);
    expect(roster.get('a')?.busy).toBe(true);
    expect(roster.get('a')?.pendingInteraction).toBe('approval');
    expect(roster.counts()).toEqual({ awaiting: 1, working: 0, completed: 1 });
  });

  it('counts(excludeId) drops the named row from the tally (attach badge)', () => {
    const roster = new AgentsRoster(new Set());
    roster.setAll([summary('a'), summary('b'), summary('c')]);
    roster.applyEvent(workChanged('a', { busy: true }));
    roster.applyEvent(workChanged('b', { busy: false, pending_interaction: 'approval' }));

    expect(roster.counts()).toEqual({ awaiting: 1, working: 1, completed: 1 });
    expect(roster.counts('a')).toEqual({ awaiting: 1, working: 0, completed: 1 });
    expect(roster.counts('b')).toEqual({ awaiting: 0, working: 1, completed: 1 });
    // Excluding a completed row or an unknown id changes nothing badge-facing.
    expect(roster.counts('c')).toEqual({ awaiting: 1, working: 1, completed: 0 });
    expect(roster.counts('nope')).toEqual({ awaiting: 1, working: 1, completed: 1 });
  });

  it('work_changed with busy and no pending interaction lands in working and keeps last_turn_reason', () => {
    const roster = new AgentsRoster(new Set());
    roster.setAll([summary('a')]);

    roster.applyEvent(workChanged('a', { busy: true }));
    expect(groupRows(roster, 'working').map((row) => row.id)).toEqual(['a']);
    expect(roster.get('a')?.pendingInteraction).toBe('none');

    roster.applyEvent(workChanged('a', { busy: false, last_turn_reason: 'failed' }));
    expect(groupRows(roster, 'completed').map((row) => row.id)).toEqual(['a']);
    expect(roster.get('a')?.lastTurnReason).toBe('failed');
    expect(roster.counts()).toEqual({ awaiting: 0, working: 0, completed: 1 });
  });

  it('session.meta.updated renames the row and updates lastPrompt from the patch', () => {
    const roster = new AgentsRoster(new Set());
    roster.setAll([summary('a', { title: 'old' })]);

    roster.applyEvent(metaUpdated('a', { title: 'new title', patch: { title: 'new title', lastPrompt: 'do the thing' } }));

    expect(roster.get('a')?.title).toBe('new title');
    expect(roster.get('a')?.lastPrompt).toBe('do the thing');
  });

  it('event.session.created inserts a row from the wire session payload', () => {
    const roster = new AgentsRoster(new Set());
    roster.setAll([summary('a')]);

    roster.applyEvent(
      sessionCreated('b', {
        title: 'fresh',
        cwd: '/work/fresh',
        last_prompt: 'hello',
        last_assistant_text: 'hi there',
        updated_at: '2026-07-30T02:00:00.000Z',
      }),
    );

    const row = roster.get('b');
    expect(row?.title).toBe('fresh');
    expect(row?.workDir).toBe('/work/fresh');
    expect(row?.lastPrompt).toBe('hello');
    expect(row?.lastAssistantText).toBe('hi there');
    expect(row?.updatedAt).toBe(Date.parse('2026-07-30T02:00:00.000Z'));
    expect(row?.pinned).toBe(false);
    expect(roster.counts()).toEqual({ awaiting: 0, working: 0, completed: 2 });
  });

  it('session.meta.updated updates lastAssistantText from the patch', () => {
    const roster = new AgentsRoster(new Set());
    roster.setAll([summary('a')]);

    roster.applyEvent(metaUpdated('a', { patch: { lastAssistantText: 'the assistant said this' } }));

    expect(roster.get('a')?.lastAssistantText).toBe('the assistant said this');
  });

  it('setAll and setAllRows carry lastAssistantText through from the seed', () => {
    const roster = new AgentsRoster(new Set());
    roster.setAll([summary('a', { lastAssistantText: 'from summary' })]);
    expect(roster.get('a')?.lastAssistantText).toBe('from summary');

    roster.setAllRows([wireRow('a', { last_assistant_text: 'from wire row' })]);
    expect(roster.get('a')?.lastAssistantText).toBe('from wire row');
  });

  it('ignores events for unknown sessions and unrelated event types', () => {
    const roster = new AgentsRoster(new Set());
    roster.setAll([summary('a', { title: 'keep' })]);

    roster.applyEvent(workChanged('missing', { busy: true }));
    roster.applyEvent(metaUpdated('missing', { title: 'nope' }));
    roster.applyEvent({ type: 'turn.started', agentId: 'main', sessionId: 'a', turnId: 1, origin: { kind: 'user' } });

    expect(roster.get('a')?.title).toBe('keep');
    expect(roster.get('a')?.busy).toBe(false);
    expect(roster.get('missing')).toBeUndefined();
  });

  it('pinned idle rows form the pinned group, but awaiting/working always win', () => {
    const roster = new AgentsRoster(new Set(['p1', 'p2', 'p3']));
    roster.setAll([
      summary('p1', { updatedAt: 300 }),
      summary('p2', { updatedAt: 200 }),
      summary('p3', { updatedAt: 100 }),
      summary('x', { updatedAt: 400 }),
    ]);

    expect(groupIds(roster)).toEqual(['pinned', 'completed']);
    expect(groupRows(roster, 'pinned').map((row) => row.id)).toEqual(['p1', 'p2', 'p3']);

    roster.applyEvent(workChanged('p1', { busy: true }));
    expect(groupRows(roster, 'working').map((row) => row.id)).toEqual(['p1']);
    expect(groupRows(roster, 'pinned').map((row) => row.id)).toEqual(['p2', 'p3']);

    roster.applyEvent(workChanged('p2', { busy: true, pending_interaction: 'question' }));
    expect(groupIds(roster)).toEqual(['pinned', 'awaiting', 'working', 'completed']);
    expect(groupRows(roster, 'awaiting').map((row) => row.id)).toEqual(['p2']);
  });

  it('setPinned toggles group membership and counts never double-count pinned rows', () => {
    const roster = new AgentsRoster(new Set());
    roster.setAll([summary('a'), summary('b')]);

    roster.setPinned('a', true);
    expect(roster.get('a')?.pinned).toBe(true);
    expect(groupRows(roster, 'pinned').map((row) => row.id)).toEqual(['a']);
    expect(roster.counts()).toEqual({ awaiting: 0, working: 0, completed: 2 });

    roster.setPinned('a', false);
    expect(roster.get('a')?.pinned).toBe(false);
    expect(groupRows(roster, 'pinned')).toEqual([]);
    expect(roster.counts()).toEqual({ awaiting: 0, working: 0, completed: 2 });
  });

  it('groups() truncates the completed group to the page size while counts stay total', () => {
    const roster = new AgentsRoster(new Set());
    roster.setAll(
      Array.from({ length: 12 }, (_, index) => summary(`s${index}`, { updatedAt: 1_000 + index })),
    );

    const groups = roster.groups(10);
    const completed = groups.find((group) => group.id === 'completed');
    expect(completed?.rows).toHaveLength(10);
    expect(completed?.rows[0]?.id).toBe('s11');
    expect(roster.counts().completed).toBe(12);
    expect(roster.groups(20).find((group) => group.id === 'completed')?.rows).toHaveLength(12);
  });

  it('setTrusted records the trust flag on the row', () => {
    const roster = new AgentsRoster(new Set());
    roster.setAll([summary('a')]);

    roster.setTrusted('a', false);
    expect(roster.get('a')?.trusted).toBe(false);
    roster.setTrusted('a', undefined);
    expect(roster.get('a')?.trusted).toBeUndefined();
  });

  it('setAllRows seeds busy/awaiting state from wire rows and preserves trusted badges', () => {
    // Final review I1: the cold-open (and post-reconnect) roster must not
    // default live sessions to Completed — the rich wire rows carry the facts.
    const roster = new AgentsRoster(new Set());
    roster.setAll([summary('a'), summary('b')]);
    roster.setTrusted('b', false);

    roster.setAllRows([
      wireRow('a', { busy: true }),
      wireRow('b', { busy: false, pending_interaction: 'approval', last_turn_reason: 'failed' }),
      wireRow('c', { archived: true }),
    ]);

    expect(roster.get('c')).toBeUndefined();
    expect(roster.get('a')?.busy).toBe(true);
    const b = roster.get('b');
    expect(b?.pendingInteraction).toBe('approval');
    expect(b?.lastTurnReason).toBe('failed');
    // The wire rows carry no trust info — the badge survives the re-seed.
    expect(b?.trusted).toBe(false);
    expect(groupIds(roster)).toEqual(['awaiting', 'working']);
    expect(roster.counts()).toEqual({ awaiting: 1, working: 1, completed: 0 });
  });
});

describe('agents view state persistence', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-agents-view-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('saveAgentsViewState / loadAgentsViewState round-trips pins and the view-session registry', async () => {
    await saveAgentsViewState(dir, { pins: new Set(['a', 'b']), sessions: new Set(['s1']), seenAt: new Map() });

    const raw = JSON.parse(await readFile(join(dir, 'agents-view.json'), 'utf-8')) as unknown;
    expect(raw).toEqual({
      pins: expect.arrayContaining(['a', 'b']),
      sessions: expect.arrayContaining(['s1']),
      seen: {},
    });

    const loaded = await loadAgentsViewState(dir);
    expect([...loaded.pins].toSorted()).toEqual(['a', 'b']);
    expect([...loaded.sessions].toSorted()).toEqual(['s1']);
    expect(loaded.seenAt).toEqual(new Map());
  });

  it('saveAgentsViewState / loadAgentsViewState round-trips the seenAt map', async () => {
    await saveAgentsViewState(dir, {
      pins: new Set(),
      sessions: new Set(['s1', 's2']),
      seenAt: new Map([
        ['s1', 1_000],
        ['s2', 2_000],
      ]),
    });

    const raw = JSON.parse(await readFile(join(dir, 'agents-view.json'), 'utf-8')) as unknown;
    expect(raw).toEqual({
      pins: [],
      sessions: expect.arrayContaining(['s1', 's2']),
      seen: { s1: 1_000, s2: 2_000 },
    });

    const loaded = await loadAgentsViewState(dir);
    expect(loaded.seenAt).toEqual(
      new Map([
        ['s1', 1_000],
        ['s2', 2_000],
      ]),
    );
  });

  it('loadAgentsViewState returns empty sets when the file is missing', async () => {
    const loaded = await loadAgentsViewState(dir);
    expect(loaded.pins).toEqual(new Set());
    expect(loaded.sessions).toEqual(new Set());
    expect(loaded.seenAt).toEqual(new Map());
  });

  it('loadAgentsViewState returns empty sets for corrupt JSON or a wrong shape', async () => {
    await writeFile(join(dir, 'agents-view.json'), '{ not json', 'utf-8');
    expect(await loadAgentsViewState(dir)).toEqual({ pins: new Set(), sessions: new Set(), seenAt: new Map() });

    await writeFile(join(dir, 'agents-view.json'), JSON.stringify({ pins: 'a', sessions: 1 }), 'utf-8');
    expect(await loadAgentsViewState(dir)).toEqual({ pins: new Set(), sessions: new Set(), seenAt: new Map() });

    await writeFile(join(dir, 'agents-view.json'), JSON.stringify({ pins: [], sessions: [], seen: 'nope' }), 'utf-8');
    expect((await loadAgentsViewState(dir)).seenAt).toEqual(new Map());

    await writeFile(
      join(dir, 'agents-view.json'),
      JSON.stringify({ pins: [], sessions: [], seen: { a: 'not-a-number', b: 5 } }),
      'utf-8',
    );
    expect((await loadAgentsViewState(dir)).seenAt).toEqual(new Map([['b', 5]]));
  });

  it('loadAgentsViewState reads a legacy pins-only file with an empty registry and no seenAt', async () => {
    await writeFile(join(dir, 'agents-view.json'), JSON.stringify({ pins: ['a'] }), 'utf-8');
    const loaded = await loadAgentsViewState(dir);
    expect([...loaded.pins]).toEqual(['a']);
    expect(loaded.sessions).toEqual(new Set());
    expect(loaded.seenAt).toEqual(new Map());
  });

  it('a file written by this version still round-trips pins/sessions once seen is ignored by an older reader', async () => {
    // Backward-compat in the other direction: readIdSet only ever reads the
    // 'pins'/'sessions' keys, so the additive 'seen' key never interferes.
    await saveAgentsViewState(dir, { pins: new Set(['a']), sessions: new Set(['s1']), seenAt: new Map([['s1', 42]]) });
    const raw = JSON.parse(await readFile(join(dir, 'agents-view.json'), 'utf-8')) as Record<string, unknown>;
    expect(Object.keys(raw).toSorted()).toEqual(['pins', 'seen', 'sessions']);
  });

  it('saveAgentsViewState leaves no tmp files behind', async () => {
    await saveAgentsViewState(dir, { pins: new Set(['a']), sessions: new Set(), seenAt: new Map() });
    await saveAgentsViewState(dir, { pins: new Set(['a', 'b']), sessions: new Set(['s1']), seenAt: new Map([['s1', 5]]) });
    const loaded = await loadAgentsViewState(dir);
    expect(loaded.pins).toEqual(new Set(['a', 'b']));
    expect(loaded.sessions).toEqual(new Set(['s1']));
    expect(loaded.seenAt).toEqual(new Map([['s1', 5]]));
    const files = await readdir(dir);
    expect(files).toEqual(['agents-view.json']);
  });
});

describe('AgentsRoster — unseen bit', () => {
  it('a row with no seenAt entry starts unseen', () => {
    const roster = new AgentsRoster(new Set());
    roster.setAll([summary('a', { updatedAt: 1_000 })]);
    expect(roster.get('a')?.unseen).toBe(true);
  });

  it('a row seeded with a seenAt at or after its updatedAt starts seen', () => {
    const roster = new AgentsRoster(new Set(), new Map([['a', 1_000]]));
    roster.setAll([summary('a', { updatedAt: 1_000 })]);
    expect(roster.get('a')?.unseen).toBe(false);
  });

  it('markSeen clears unseen and records the row updatedAt', () => {
    const roster = new AgentsRoster(new Set());
    roster.setAll([summary('a', { updatedAt: 1_000 })]);
    expect(roster.get('a')?.unseen).toBe(true);

    roster.markSeen('a');
    expect(roster.get('a')?.unseen).toBe(false);
  });

  it('markSeen on an unknown id is a no-op', () => {
    const roster = new AgentsRoster(new Set());
    roster.setAll([summary('a')]);
    expect(() => {
      roster.markSeen('missing');
    }).not.toThrow();
  });

  it('a new event after markSeen flips the row back to unseen', () => {
    const roster = new AgentsRoster(new Set());
    roster.setAll([summary('a', { updatedAt: 1_000 })]);
    roster.markSeen('a');
    expect(roster.get('a')?.unseen).toBe(false);

    roster.applyEvent(metaUpdated('a', { title: 'server renamed it' }));
    expect(roster.get('a')?.unseen).toBe(true);
  });

  it('work_changed after markSeen also flips the row back to unseen', () => {
    const roster = new AgentsRoster(new Set());
    roster.setAll([summary('a', { updatedAt: 1_000 })]);
    roster.markSeen('a');

    roster.applyEvent(workChanged('a', { busy: true }));
    expect(roster.get('a')?.unseen).toBe(true);
  });

  it('a freshly created session starts unseen', () => {
    const roster = new AgentsRoster(new Set());
    roster.setAll([summary('a')]);
    roster.applyEvent(sessionCreated('b'));
    expect(roster.get('b')?.unseen).toBe(true);
  });

  it('the seenAt map handed to the constructor is mutated in place by markSeen (persistable by reference)', () => {
    const seenAt = new Map<string, number>();
    const roster = new AgentsRoster(new Set(), seenAt);
    roster.setAll([summary('a', { updatedAt: 1_000 })]);
    roster.markSeen('a');
    expect(seenAt.get('a')).toBe(1_000);
  });
});


describe('roster row mutation (controller actions)', () => {
  it('remove drops the row from groups and counts', () => {
    const roster = new AgentsRoster(new Set());
    roster.setAll([summary('a'), summary('b')]);
    roster.remove('a');
    expect(roster.get('a')).toBeUndefined();
    expect(roster.counts()).toEqual({ awaiting: 0, working: 0, completed: 1 });
    expect(roster.groups().flatMap((group) => group.rows).map((row) => row.id)).toEqual(['b']);
  });

  it('setTitle rewrites the row title without touching ordering fields', () => {
    const roster = new AgentsRoster(new Set());
    roster.setAll([summary('a', { title: 'old', updatedAt: 5_000 })]);
    roster.setTitle('a', 'new');
    const row = roster.get('a');
    expect(row?.title).toBe('new');
    expect(row?.updatedAt).toBe(5_000);
    roster.setTitle('missing', 'noop');
    expect(roster.get('missing')).toBeUndefined();
  });
});
