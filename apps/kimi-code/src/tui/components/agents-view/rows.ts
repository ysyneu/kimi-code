/**
 * Row-level rendering for the agents view: roster rows, group headers and
 * the collapsed "… N more" row. Pure line builders — every function returns
 * a single line fitted to exactly `width` columns; the component in
 * `app.ts` owns layout, scrolling and key routing.
 */

import { truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';

import type { AgentsRosterRow } from '@/tui/agents/roster';
import { SELECT_POINTER } from '@/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';

const ELLIPSIS = '…';

/** Fixed left-aligned width of the name column (see `renderRosterRow`). */
const NAME_WIDTH = 42;

/** Idle-row glyphs: has new output since last viewed vs. already seen. */
const TEARDROP_ASTERISK = '✻';
const BULLET_OPERATOR = '∙';

/**
 * Busy-row spinner charset: an asterisk bloom rather than a braille dial.
 * `platform` is injectable for tests; production calls always default to
 * `process.platform`. macOS terminals render the fifth glyph as its own
 * asterisk; other platforms substitute a plain `*` there.
 */
export function spinnerFrames(platform: NodeJS.Platform = process.platform): readonly string[] {
  const charset = platform === 'darwin' ? ['·', '✢', '✳', '✶', '✻', '✽'] : ['·', '✢', '*', '✶', '✻', '✽'];
  // Ping-pong: forward through the charset, then back — a 12-frame bounce.
  return [...charset, ...charset.toReversed()];
}

const SPINNER_FRAME_MS = 120;

function spinnerFrame(nowMs: number): string {
  const frames = spinnerFrames();
  const index = Math.floor(nowMs / SPINNER_FRAME_MS) % frames.length;
  return frames[index] ?? frames[0]!;
}

export function padToWidth(line: string, width: number): string {
  const w = visibleWidth(line);
  if (w === width) return line;
  if (w > width) return truncateToWidth(line, width, ELLIPSIS);
  return line + ' '.repeat(width - w);
}

/** Fit `line` into exactly `width` columns, even after CJK-edge truncation. */
export function fitExactly(line: string, width: number): string {
  let s = line;
  if (visibleWidth(s) > width) s = truncateToWidth(s, width, ELLIPSIS);
  return padToWidth(s, width);
}

function singleLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

export function formatRelativeTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const diffSec = Math.floor(Math.max(0, Date.now() - ts) / 1000);
  if (diffSec < 60) return 'just now';
  const minutes = Math.floor(diffSec / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}

function pointer(selected: boolean): string {
  return currentTheme.fg(selected ? 'primary' : 'textDim', selected ? `${SELECT_POINTER} ` : '  ');
}

type StatusColor = 'success' | 'textMuted';

/**
 * Busy rows show the ping-pong spinner. Idle rows carry an orthogonal
 * "unseen" bit — independent of group/busy/last-turn-reason — that flips to
 * the bullet the moment the row is opened (`AgentsRoster.markSeen`).
 */
function statusSymbol(row: AgentsRosterRow): { glyph: string; color: StatusColor } {
  if (row.busy) return { glyph: spinnerFrame(Date.now()), color: 'success' };
  if (row.unseen) return { glyph: TEARDROP_ASTERISK, color: 'textMuted' };
  return { glyph: BULLET_OPERATOR, color: 'textMuted' };
}

/**
 * The summary snippet shown next to the name: the main agent's most recent
 * assistant reply. Older sessions without `lastAssistantText` fall back to
 * `lastPrompt` — except when that would just repeat the name already shown
 * (a single-turn session whose title was auto-derived from that same
 * prompt, or an untitled row whose name itself fell back to the prompt),
 * where the summary is left blank instead.
 */
function summaryText(row: AgentsRosterRow, name: string): string {
  if (row.lastAssistantText !== undefined) return singleLine(row.lastAssistantText);
  if (row.lastPrompt === undefined) return '';
  const prompt = singleLine(row.lastPrompt);
  return prompt === name ? '' : prompt;
}

/**
 * The name shown for a row: its title, falling back to the last prompt,
 * then a static placeholder for a row with neither. Shared by the row
 * renderer and the reply-mode composer placeholder (`reply to <name>`) so
 * the two copies never drift apart.
 */
export function rosterRowName(row: AgentsRosterRow): string {
  return singleLine(row.title) || singleLine(row.lastPrompt ?? '') || '(untitled)';
}

/**
 * `<ptr><symbol> <name padded/truncated to 42 cols><summary><meta>`.
 *
 * Three independently-fitted zones, in this order:
 * - `name`: fixed 42-column left-aligned slot, space-padded or
 *   ellipsis-truncated — never affected by how long the summary or meta is.
 * - `summary` (the assistant reply / fallback prompt): fills whatever space
 *   remains between the name and the reserved meta zone, itself
 *   ellipsis-truncated when it doesn't fit.
 * - `meta` (untrusted badge + relative time): right-flush to the row's last
 *   column, reserved ahead of the summary budget so it never truncates —
 *   a long summary only ever eats into its own space.
 *
 * One name per row: the server auto-titles a session with its first prompt
 * verbatim, so rendering `lastPrompt` next to the title reads as the same
 * message twice. The title wins; the prompt is only the untitled fallback.
 * No cwd — the row's elements are name, assistant summary, and meta.
 *
 * `selected` (cursor position) and `isOrigin` (the session this roster-attach
 * lifecycle was last backed out of via ←) are independent flags that can
 * both be true on the same row at once: `selected` drives the `❯` pointer
 * and a full-row `surfaceSelected` background fill — not bold; `isOrigin` is
 * what bolds the name — not a background. The two compose freely on the
 * same row.
 */
export function renderRosterRow(
  row: AgentsRosterRow,
  selected: boolean,
  isOrigin: boolean,
  width: number,
): string {
  const symbol = statusSymbol(row);
  const name = rosterRowName(row);
  const prefix = pointer(selected) + currentTheme.fg(symbol.color, symbol.glyph) + ' ';
  const prefixWidth = visibleWidth(prefix);

  const styledName = isOrigin ? currentTheme.boldFg('textStrong', name) : currentTheme.fg('text', name);
  const nameSlot = truncateToWidth(styledName, NAME_WIDTH, ELLIPSIS, true);

  const metaBudget = Math.max(0, width - prefixWidth - NAME_WIDTH);
  const metaParts = reservedMetaParts(row, metaBudget);
  const metaText = metaParts.join(' · ');
  const metaWidth = metaText.length > 0 ? 1 + visibleWidth(metaText) : 0;
  const metaSegment = metaText.length > 0 ? currentTheme.fg('textMuted', ` ${metaText}`) : '';

  const summary = summaryText(row, name);
  const summaryBudget = Math.max(0, width - prefixWidth - NAME_WIDTH - metaWidth);
  const summarySegment =
    summary.length > 0 && summaryBudget > 1
      ? currentTheme.fg('textMuted', ` ${truncateToWidth(summary, summaryBudget - 1, ELLIPSIS)}`)
      : '';

  const left = prefix + nameSlot + summarySegment;
  const fillWidth = Math.max(0, width - visibleWidth(left) - metaWidth);
  // The 42-col name slot is fixed regardless of `width`; fitExactly is a
  // last-resort safety net for terminals narrower than prefix+name (46
  // cols) can hold — below the app's own minimum width, in practice.
  const line = fitExactly(left + ' '.repeat(fillWidth) + metaSegment, width);
  // Background wraps the already width-exact, already fg/bold-styled line
  // last, so it never interferes with fitExactly's own ANSI-aware width
  // measurement — nested bg/fg/bold each carry independent SGR resets, the
  // same composition question-dialog.ts already relies on for its own
  // `bg('primary', boldFg('text', text))`.
  return selected ? currentTheme.bg('surfaceSelected', line) : line;
}

/**
 * Picks the richest meta content (untrusted badge + relative time) that
 * fits in `budget` columns. The relative time is the element the parity
 * spec calls out as never-truncating; the untrusted badge is what a narrow
 * terminal loses first so the time keeps its guarantee as long as possible.
 */
function reservedMetaParts(row: AgentsRosterRow, budget: number): string[] {
  const time = formatRelativeTime(row.updatedAt);
  const badge = row.trusted === false ? 'untrusted' : '';
  const widthOf = (parts: readonly string[]): number => {
    const text = parts.join(' · ');
    return text.length > 0 ? 1 + visibleWidth(text) : 0;
  };
  if (badge.length > 0 && time.length > 0) {
    const both = [badge, time];
    if (widthOf(both) <= budget) return both;
  }
  if (time.length > 0 && widthOf([time]) <= budget) return [time];
  return [];
}

/**
 * Group header line: `<ptr><label>`, or `<ptr><label> (N)` while manually
 * collapsed. An *expanded* header never shows a count — that lives only in
 * the top summary line, matching the reference layout. `collapsedCount` is
 * the one exception: collapsing a group empties its row list, so without a
 * count here a collapsed group would look like it lost its contents rather
 * than just hiding them. Always rendered on the single header line, never
 * wrapped onto its own line.
 */
export function renderGroupHeader(
  label: string,
  collapsedCount: number | undefined,
  selected: boolean,
  width: number,
): string {
  const suffix = collapsedCount === undefined ? '' : ` (${String(collapsedCount)})`;
  const line = pointer(selected) + currentTheme.boldFg('textStrong', label + suffix);
  return fitExactly(line, width);
}

/** The collapsed completed-group remainder: `<ptr>… N more`. */
export function renderMoreRow(moreCount: number, selected: boolean, width: number): string {
  const line = pointer(selected) + currentTheme.fg('textMuted', `… ${String(moreCount)} more`);
  return fitExactly(line, width);
}
