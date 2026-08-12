/**
 * ReplyPanel — the bordered preview panel `space` opens on a focused roster
 * row (task A1 / R9 deviation-matrix §2.A1). It renders in the SAME slot
 * between the roster list and the footer that the plain dispatch composer
 * normally occupies (see `AgentsViewApp.render`): a rounded box, matching
 * the codebase's other dialog chrome (e.g. `FeedbackInputDialog`), holding —
 * top to bottom — a clamped preview of the row's latest content, a dim
 * relative-age line, and the SAME shared dispatch editor the plain composer
 * uses (see `AgentsViewController`'s "reply reuses dispatchEditor" doc
 * comment — this module never mounts a second composer).
 *
 * Pure render function, no state of its own: the R4 controller/component
 * split keeps the open/close state machine in the controller
 * (`replyTargetId`) and the shared editor's own text-editing state; this
 * module only draws. The editor's own "rules" frame (unchanged — still
 * drawn by `CustomEditor` itself) doubles as the divider between the
 * preview/age block and the input row, so no separate divider is drawn
 * here.
 */

import { truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';

import type { AgentsRosterRow } from '@/tui/agents/roster';
import type { CustomEditor } from '@/tui/components/editor/custom-editor';
import { currentTheme } from '#/tui/theme';

import { fitExactly, formatRelativeTime } from './rows';

/** Up to ~6 lines of preview content — never a scrolling transcript. */
const MAX_PREVIEW_LINES = 6;

/**
 * The panel's content source: the row's most recent assistant output — the
 * SAME field the roster's summary column reads (`lastAssistantText`, see
 * `rows.ts`'s `summaryText`) — falling back to the session's initial prompt
 * only when no output exists yet. Never a transcript, never a sent-reply
 * echo: both fields already hold current session state (not a message log),
 * so reading them directly can't accidentally surface one.
 */
function previewSource(row: AgentsRosterRow): string | undefined {
  if (row.lastAssistantText !== undefined && row.lastAssistantText.trim().length > 0) {
    return row.lastAssistantText;
  }
  if (row.lastPrompt !== undefined && row.lastPrompt.trim().length > 0) {
    return row.lastPrompt;
  }
  return undefined;
}

/**
 * Up to `maxLines` non-empty lines from the preview source — whitespace runs
 * WITHIN a line collapsed to a single space, but line breaks preserved
 * (unlike the roster row's own single-line `summaryText`, which squashes
 * everything including newlines into one line). Width-clamping is
 * `renderReplyPanel`'s job — it needs the actual column budget, which varies
 * with terminal width.
 */
export function previewLines(row: AgentsRosterRow, maxLines = MAX_PREVIEW_LINES): string[] {
  const source = previewSource(row);
  if (source === undefined) return [];
  return source
    .split('\n')
    .map((line) => line.replaceAll(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .slice(0, maxLines);
}

/**
 * Renders the full bordered panel for `width` columns: `╭─╮`/`│ │`/`╰─╯`
 * chrome (same convention as `FeedbackInputDialog`) around the preview
 * block, the age line, and the editor's own render output at the matching
 * inner width. `row` is `undefined` only in the unlikely case the target row
 * vanished from the roster while the panel stayed open (e.g. deleted from
 * another client mid-session) — the panel still renders, just without a
 * preview.
 */
export function renderReplyPanel(
  row: AgentsRosterRow | undefined,
  editor: CustomEditor,
  width: number,
): string[] {
  const safeWidth = Math.max(0, width);
  if (safeWidth < 4) return editor.render(safeWidth);

  const innerWidth = Math.max(1, safeWidth - 4);
  const pad = '  ';
  const border = (s: string): string => currentTheme.fg('primary', s);

  const contentLines: string[] = [];
  if (row !== undefined) {
    const preview = previewLines(row);
    for (const line of preview) {
      contentLines.push(currentTheme.fg('textMuted', truncateToWidth(line, innerWidth, '…')));
    }
    const age = formatRelativeTime(row.updatedAt);
    if (age.length > 0) contentLines.push(currentTheme.fg('textDim', age));
    if (contentLines.length > 0) contentLines.push('');
  }
  for (const line of editor.render(innerWidth)) contentLines.push(line);

  const lines: string[] = [border('╭' + '─'.repeat(Math.max(0, safeWidth - 2)) + '╮')];
  for (const content of contentLines) {
    const vis = visibleWidth(content);
    const rightPad = Math.max(0, innerWidth - vis);
    lines.push(border('│') + pad + content + ' '.repeat(rightPad) + border('│'));
  }
  lines.push(border('╰' + '─'.repeat(Math.max(0, safeWidth - 2)) + '╯'));
  return lines.map((line) => fitExactly(line, safeWidth));
}
