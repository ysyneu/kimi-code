/**
 * Directory-mode grouping (A6): the agents view's second roster layout,
 * cycled via Ctrl+S alongside the (unchanged) status grouping `AgentsRoster.
 * groups()` already implements. Kept out of `agents/roster.ts` deliberately —
 * "group by workdir" is a view-layer decision, not something the roster
 * model needs to know about; `buildDirectoryGroups` is a pure function of a
 * row snapshot (`AgentsRoster.allRows()`) and the pins set, same shape as the
 * state-mode grouping it sits beside. The controller (`agents-view.ts`)
 * is the only caller — it picks this or `roster.groups()` per the view's
 * current `AgentsGroupMode` and hands the component a flat `AgentsGroup[]`
 * either way; `AgentsViewApp` never branches on mode itself.
 */

import { homedir } from 'node:os';

import type { AgentsGroup, AgentsRosterRow } from '../agents/roster';

export type AgentsGroupMode = 'state' | 'directory';

const PINNED_GROUP_ID = 'pinned';
const PINNED_GROUP_LABEL = 'Pinned';
const OTHER_GROUP_ID = 'other';
const OTHER_GROUP_LABEL = 'Other';

/**
 * Directory-mode group label: the session's workDir with the user's home
 * prefix collapsed to `~`, e.g. `/home/alex/go/src/github.com/example-org/
 * sample-repo` → `~/go/src/github.com/example-org/sample-repo`. Deliberately
 * NOT `chrome/footer.ts`'s `shortenCwd` — that helper also trims to the last
 * few path segments to fit a single status-line row, a width budget this
 * group header (a full list row) doesn't share; reusing it would make two
 * different real directories collapse to the same displayed label.
 */
export function shortenWorkDirLabel(workDir: string, home: string = homedir()): string {
  if (home.length > 0 && workDir === home) return '~';
  if (home.length > 0 && workDir.startsWith(`${home}/`)) return `~${workDir.slice(home.length)}`;
  return workDir;
}

function sortByPinOrder(rows: AgentsRosterRow[], pins: ReadonlySet<string>): AgentsRosterRow[] {
  const order = new Map<string, number>();
  let i = 0;
  for (const id of pins) order.set(id, i++);
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return rows;
}

function sortByRecency(rows: AgentsRosterRow[]): AgentsRosterRow[] {
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows;
}

/**
 * Buckets `rows` by workDir instead of status.
 *
 * - Pinned rows float out to a leading `Pinned` group, UNCONDITIONALLY —
 *   unlike state mode's `groupOf`, which only pulls a pinned row out of its
 *   status bucket when that bucket would otherwise be `completed` (a busy or
 *   awaiting-input pinned row stays in Working/Needs input there, so live
 *   work never hides behind the Pinned list). Directory mode has no
 *   Working/Needs-input bucket to protect that visibility with, so the
 *   simpler unconditional rule applies: every pinned row is in Pinned, full
 *   stop. Same manual pins-Set order as state mode (`onReorderPinned`
 *   shift+↑↓ keeps working unchanged — it reorders the same `pins` Set both
 *   grouping strategies read).
 * - Every other row buckets by its exact `workDir` — one group per distinct
 *   value, label = `shortenWorkDirLabel`, sorted by recency within the
 *   group (same rule state mode uses for its own non-pinned buckets). A
 *   fresh A2 optimistic dispatch placeholder (`AgentsRoster.upsertLocalRow`)
 *   is not a special case here: `handleDispatch` seeds it with the real
 *   dispatch workDir (`host.agentsViewWorkDir()`) up front, before the
 *   session id is even known, so it already has a normal, known `workDir` by
 *   the time any grouping runs — it buckets alongside every other session in
 *   that directory, never in `Other`.
 * - Rows with no/blank workDir (never true for a real session or an A2
 *   placeholder in practice, but the roster's own type doesn't guarantee it)
 *   land in a trailing `Other` bucket instead of minting a group for `''`.
 * - Directory groups are ordered by `localeCompare` on their label; `Other`
 *   is always last, after every real directory. No windowing/pagination
 *   here (contrast state mode's `completed` bucket, `DEFAULT_PAGE_SIZE`) —
 *   directory buckets are typically small and per-project, and the brief
 *   doesn't ask for a "N more" affordance on them.
 */
export function buildDirectoryGroups(
  rows: readonly AgentsRosterRow[],
  pins: ReadonlySet<string>,
  home: string = homedir(),
): readonly AgentsGroup[] {
  const pinnedRows: AgentsRosterRow[] = [];
  const otherRows: AgentsRosterRow[] = [];
  const byWorkDir = new Map<string, { label: string; rows: AgentsRosterRow[] }>();

  for (const row of rows) {
    if (row.pinned) {
      pinnedRows.push(row);
      continue;
    }
    const workDir = row.workDir.trim();
    if (workDir.length === 0) {
      otherRows.push(row);
      continue;
    }
    const bucket = byWorkDir.get(workDir);
    if (bucket !== undefined) bucket.rows.push(row);
    else byWorkDir.set(workDir, { label: shortenWorkDirLabel(workDir, home), rows: [row] });
  }

  const groups: AgentsGroup[] = [];
  if (pinnedRows.length > 0) {
    groups.push({ id: PINNED_GROUP_ID, label: PINNED_GROUP_LABEL, rows: sortByPinOrder(pinnedRows, pins) });
  }
  const dirEntries = [...byWorkDir.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label));
  for (const [workDir, bucket] of dirEntries) {
    groups.push({ id: `dir:${workDir}`, label: bucket.label, rows: sortByRecency(bucket.rows) });
  }
  if (otherRows.length > 0) {
    groups.push({ id: OTHER_GROUP_ID, label: OTHER_GROUP_LABEL, rows: sortByRecency(otherRows) });
  }
  return groups;
}
