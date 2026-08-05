import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Event, SessionSummary } from '@moonshot-ai/kimi-code-sdk';

import { AgentsRoster } from '#/tui/agents/roster';
import { loadPins, savePins } from '#/tui/agents/roster-persistence';

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
        updated_at: '2026-07-30T02:00:00.000Z',
      }),
    );

    const row = roster.get('b');
    expect(row?.title).toBe('fresh');
    expect(row?.workDir).toBe('/work/fresh');
    expect(row?.lastPrompt).toBe('hello');
    expect(row?.updatedAt).toBe(Date.parse('2026-07-30T02:00:00.000Z'));
    expect(row?.pinned).toBe(false);
    expect(roster.counts()).toEqual({ awaiting: 0, working: 0, completed: 2 });
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
    expect(groupIds(roster)).toEqual(['awaiting', 'working', 'pinned', 'completed']);
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
});

describe('roster pin persistence', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-agents-view-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('savePins / loadPins round-trips a pin set through { "pins": string[] }', async () => {
    await savePins(dir, new Set(['a', 'b']));

    const raw = JSON.parse(await readFile(join(dir, 'agents-view.json'), 'utf-8')) as unknown;
    expect(raw).toEqual({ pins: expect.arrayContaining(['a', 'b']) });

    const loaded = await loadPins(dir);
    expect([...loaded].toSorted()).toEqual(['a', 'b']);
  });

  it('loadPins returns an empty set when the file is missing', async () => {
    expect(await loadPins(dir)).toEqual(new Set());
  });

  it('loadPins returns an empty set for corrupt JSON or a wrong shape', async () => {
    await writeFile(join(dir, 'agents-view.json'), '{ not json', 'utf-8');
    expect(await loadPins(dir)).toEqual(new Set());

    await writeFile(join(dir, 'agents-view.json'), JSON.stringify({ pins: 'a' }), 'utf-8');
    expect(await loadPins(dir)).toEqual(new Set());
  });

  it('savePins leaves no tmp files behind', async () => {
    await savePins(dir, new Set(['a']));
    await savePins(dir, new Set(['a', 'b']));
    expect(await loadPins(dir)).toEqual(new Set(['a', 'b']));
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
