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

/** Braille frames for the working spinner; advances whenever a render lands. */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

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

type StatusColor = 'warning' | 'success' | 'textMuted' | 'error';

function statusSymbol(row: AgentsRosterRow): { glyph: string; color: StatusColor } {
  if (row.pendingInteraction !== 'none') return { glyph: '!', color: 'warning' };
  if (row.busy) {
    const frame = Math.floor(Date.now() / 120) % SPINNER_FRAMES.length;
    return { glyph: SPINNER_FRAMES[frame] ?? '⠋', color: 'success' };
  }
  if (row.lastTurnReason === 'failed' || row.lastTurnReason === 'cancelled') {
    return { glyph: '✗', color: 'error' };
  }
  if (row.lastTurnReason === 'completed') return { glyph: '✻', color: 'textMuted' };
  return { glyph: '∙', color: 'textMuted' };
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
 * `<ptr><symbol> <name> <助手摘要> <相对时间> [untrusted]`.
 *
 * One name per row: the server auto-titles a session with its first prompt
 * verbatim, so rendering `lastPrompt` next to the title reads as the same
 * message twice. The title wins; the prompt is only the untitled fallback.
 * No cwd — the row's elements are name, assistant summary, and time.
 */
export function renderRosterRow(row: AgentsRosterRow, selected: boolean, width: number): string {
  const symbol = statusSymbol(row);
  const name = row.title || singleLine(row.lastPrompt ?? '') || '(untitled)';
  const prefix =
    pointer(selected) +
    currentTheme.fg(symbol.color, symbol.glyph) +
    ' ' +
    (selected ? currentTheme.boldFg('textStrong', name) : currentTheme.fg('text', name));

  const summary = summaryText(row, name);
  const summarySuffix = summary.length > 0 ? currentTheme.fg('textMuted', ` ${summary}`) : '';

  const metaParts: string[] = [];
  const rel = formatRelativeTime(row.updatedAt);
  if (rel.length > 0) metaParts.push(rel);
  if (row.trusted === false) metaParts.push('untrusted');
  const metaSuffix = metaParts.length > 0 ? currentTheme.fg('textMuted', ` ${metaParts.join(' · ')}`) : '';

  return fitExactly(prefix + summarySuffix + metaSuffix, width);
}

/** Group header line: `<ptr><label> (N)`. */
export function renderGroupHeader(
  label: string,
  count: number,
  selected: boolean,
  width: number,
): string {
  const line =
    pointer(selected) +
    currentTheme.boldFg('textStrong', label) +
    currentTheme.fg('textMuted', ` (${String(count)})`);
  return fitExactly(line, width);
}

/** The collapsed completed-group remainder: `<ptr>… N more`. */
export function renderMoreRow(moreCount: number, selected: boolean, width: number): string {
  const line = pointer(selected) + currentTheme.fg('textMuted', `… ${String(moreCount)} more`);
  return fitExactly(line, width);
}
