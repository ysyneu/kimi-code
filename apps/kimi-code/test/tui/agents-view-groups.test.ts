import { describe, expect, it } from 'vitest';

import type { AgentsRosterRow } from '@/tui/agents/roster';
import { buildDirectoryGroups, shortenWorkDirLabel } from '@/tui/controllers/agents-view-groups';

// `buildDirectoryGroups`'s labels default to the REAL `os.homedir()`, which
// varies per machine/CI — every call below pins a fixed HOME explicitly so
// `~`-shortened label assertions are deterministic.
const HOME = '/home/alex';

function row(id: string, overrides: Partial<AgentsRosterRow> = {}): AgentsRosterRow {
  return {
    id,
    title: `${id} title`,
    workDir: '/home/alex/projects/sample-repo',
    updatedAt: 1_000,
    busy: false,
    pendingInteraction: 'none',
    pinned: false,
    unseen: false,
    ...overrides,
  };
}

describe('shortenWorkDirLabel', () => {
  it('collapses an exact home match to ~', () => {
    expect(shortenWorkDirLabel('/home/alex', '/home/alex')).toBe('~');
  });

  it('collapses a home-prefixed path to ~/...', () => {
    expect(shortenWorkDirLabel('/home/alex/go/src/github.com/example-org/sample-repo', '/home/alex')).toBe(
      '~/go/src/github.com/example-org/sample-repo',
    );
  });

  it('leaves a non-home path untouched', () => {
    expect(shortenWorkDirLabel('/srv/build/sample-repo', '/home/alex')).toBe('/srv/build/sample-repo');
  });

  it('does not falsely match a sibling directory that merely starts with the home path', () => {
    // '/home/alexandria' must not be treated as a child of '/home/alex'.
    expect(shortenWorkDirLabel('/home/alexandria/sample-repo', '/home/alex')).toBe('/home/alexandria/sample-repo');
  });

  it('leaves the path untouched when home is unknown (empty)', () => {
    expect(shortenWorkDirLabel('/home/alex/sample-repo', '')).toBe('/home/alex/sample-repo');
  });

  it('collapses a workDir with exactly one trailing slash past home to ~, not ~/ (review round 1, Minor finding #4)', () => {
    expect(shortenWorkDirLabel('/home/alex/', '/home/alex')).toBe('~');
  });
});

describe('buildDirectoryGroups', () => {
  it('returns no groups for an empty roster', () => {
    expect(buildDirectoryGroups([], new Set(), HOME)).toEqual([]);
  });

  it('buckets rows by exact workDir, one group per distinct directory', () => {
    const rows = [
      row('a', { workDir: '/home/alex/projects/sample-repo' }),
      row('b', { workDir: '/home/alex/projects/another-app' }),
      row('c', { workDir: '/home/alex/projects/sample-repo' }),
    ];
    const groups = buildDirectoryGroups(rows, new Set(), HOME);
    expect(groups.map((g) => g.id)).toEqual([
      'dir:/home/alex/projects/another-app',
      'dir:/home/alex/projects/sample-repo',
    ]);
    expect(
      groups.find((g) => g.id === 'dir:/home/alex/projects/sample-repo')?.rows.map((r) => r.id).sort(),
    ).toEqual(['a', 'c']);
  });

  it('sorts directory groups by localeCompare on the label, not raw code-unit order', () => {
    // Plain code-unit ordering would sort 'Zebra' before 'apple' ('Z' < 'a'
    // in ASCII); locale collation orders alphabetically regardless of case,
    // so 'apple' sorts first. This is the case that would fail under a
    // naive `.sort()` without `localeCompare`.
    const rows = [
      row('z', { workDir: '/home/alex/projects/Zebra' }),
      row('a', { workDir: '/home/alex/projects/apple' }),
    ];
    const groups = buildDirectoryGroups(rows, new Set(), HOME);
    expect(groups.map((g) => g.label)).toEqual(['~/projects/apple', '~/projects/Zebra']);
  });

  it('sends rows with no/blank workDir to a trailing Other bucket, after every real directory', () => {
    const rows = [
      row('a', { workDir: '/home/alex/projects/sample-repo' }),
      row('unknown', { workDir: '' }),
      row('blank', { workDir: '   ' }),
    ];
    const groups = buildDirectoryGroups(rows, new Set(), HOME);
    expect(groups.map((g) => g.id)).toEqual(['dir:/home/alex/projects/sample-repo', 'other']);
    const other = groups.find((g) => g.id === 'other');
    expect(other?.label).toBe('Other');
    expect(other?.rows.map((r) => r.id).sort()).toEqual(['blank', 'unknown']);
  });

  it('floats every pinned row into a leading Pinned group, unconditionally — including a busy/awaiting one', () => {
    // Directory mode has no Working/Needs-input bucket to protect a live
    // pinned row's visibility with (the reason state mode's `groupOf` only
    // pins-out an otherwise-idle row) — so here ALL pinned rows float,
    // regardless of busy/pendingInteraction.
    const rows = [
      row('idle-pinned', { pinned: true, workDir: '/home/alex/projects/sample-repo' }),
      row('busy-pinned', { pinned: true, busy: true, workDir: '/home/alex/projects/another-app' }),
      row('awaiting-pinned', {
        pinned: true,
        pendingInteraction: 'approval',
        workDir: '/home/alex/projects/another-app',
      }),
      row('unpinned', { workDir: '/home/alex/projects/sample-repo' }),
    ];
    const groups = buildDirectoryGroups(rows, new Set(), HOME);
    // Not state mode's 'pinned' literal — see the id's own doc for why
    // (collapsedGroups id-space disjointness, review round 1 finding #2).
    expect(groups[0]?.id).toBe('directory-pinned');
    expect(groups[0]?.rows.map((r) => r.id).sort()).toEqual(['awaiting-pinned', 'busy-pinned', 'idle-pinned']);
    expect(groups.find((g) => g.id === 'dir:/home/alex/projects/sample-repo')?.rows.map((r) => r.id)).toEqual([
      'unpinned',
    ]);
    // The directory that only had pinned rows in it never gets its own
    // (now-empty) group.
    expect(groups.find((g) => g.id === 'dir:/home/alex/projects/another-app')).toBeUndefined();
  });

  it('orders the Pinned group by the pins Set insertion order (manual reorder), not recency', () => {
    const rows = [
      row('first-pinned', { pinned: true, updatedAt: 100 }),
      row('second-pinned', { pinned: true, updatedAt: 999 }),
    ];
    const pins = new Set(['second-pinned', 'first-pinned']);
    const groups = buildDirectoryGroups(rows, pins, HOME);
    expect(groups[0]?.rows.map((r) => r.id)).toEqual(['second-pinned', 'first-pinned']);
  });

  it('sorts rows within a directory group by recency, most recent first', () => {
    const rows = [
      row('old', { updatedAt: 100 }),
      row('newest', { updatedAt: 300 }),
      row('mid', { updatedAt: 200 }),
    ];
    const groups = buildDirectoryGroups(rows, new Set(), HOME);
    expect(groups[0]?.rows.map((r) => r.id)).toEqual(['newest', 'mid', 'old']);
  });

  it('buckets an in-flight A2 dispatch placeholder under its own (known) workDir, not Other', () => {
    // `handleDispatch` seeds the placeholder row with the real dispatch
    // workDir (`host.agentsViewWorkDir()`) at creation time, before the
    // session id is even known — this function treats it like any other
    // row, no placeholder-id special-casing needed.
    const rows = [
      row('pending-dispatch:abc123', { workDir: '/home/alex/projects/sample-repo', busy: true }),
      row('real-session', { workDir: '/home/alex/projects/sample-repo' }),
    ];
    const groups = buildDirectoryGroups(rows, new Set(), HOME);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe('dir:/home/alex/projects/sample-repo');
    expect(groups[0]?.rows.map((r) => r.id).sort()).toEqual(['pending-dispatch:abc123', 'real-session']);
  });
});
