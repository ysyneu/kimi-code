/**
 * AgentsViewApp — full-screen alt-screen takeover listing the view's OWN
 * sessions (dispatched from or attached through this view — the server-wide
 * list is filtered controller-side) as a grouped roster (Awaiting input /
 * Working / Pinned / Completed), each group separated by a blank spacer
 * line. Mirrors the TasksBrowserApp mount/render contract: mounted by a
 * controller via container swap, `render(width)` returns exactly
 * `terminal.rows` lines (header 4 [brand mark + version / model · cwd /
 * status counts / trailing blank] + body + footer 1, or 2 while the `?` grid
 * is open), data flows in via `setProps`, user actions fire the `on*`
 * callbacks.
 *
 * Zero SDK access: the controller owns the roster, delete / rename / pin
 * side effects and re-pushes props after every action.
 *
 * Behaviour notes for the controller:
 * - Delete confirm: while `confirmDeleteId` is set the component still
 *   routes keys normally (Ctrl+X confirms, everything else fires its usual
 *   callback); the controller must clear `confirmDeleteId` on ANY action
 *   callback it receives — including `onQuit` (Esc during confirm cancels
 *   the confirm instead of quitting).
 * - Rename cancel: Esc during rename submits the ORIGINAL title via
 *   `onRenameSubmit`; the controller treats an unchanged title as a cancel
 *   (clears `renameDraft`, skips the SDK call).
 * - Dispatch editor: the mounted `dispatchEditor` renders into the bottom
 *   box. While `dispatchFocused`, every key routes to the editor — Esc is
 *   the editor's own `onEscape` (the controller wires it to unfocus).
 *   List-focused, a printable char focuses the editor and feeds it the
 *   text; the sole printable shortcut (`?`) only acts while the editor is
 *   EMPTY, once it holds text every printable char belongs to it.
 * - Open: Enter and → both fire `onOpen` on a row — opening always hands
 *   off to the session's own full-screen chat, never an in-view detail.
 */

import {
  Container,
  Key,
  matchesKey,
  type Terminal,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';

import type { AgentsGroup, AgentsGroupId, AgentsRosterRow } from '@/tui/agents/roster';
import type { CustomEditor } from '@/tui/components/editor/custom-editor';
import { getVersion } from '#/cli/version';
import { PRODUCT_NAME } from '#/constant/app';
import { currentTheme } from '#/tui/theme';
import { printableChar, isPrintableChar } from '@/tui/utils/printable-key';

import { fitExactly, renderGroupHeader, renderMoreRow, renderRosterRow } from './rows';

export interface AgentsViewProps {
  readonly groups: readonly AgentsGroup[];
  readonly counts: { awaiting: number; working: number; completed: number };
  /** Selected item: a row id, `group:<id>`, or `more:completed`. */
  readonly selectedId: string | undefined;
  /** "embedded" or host:port of the connected kap-server. Not currently shown
   *  by the header chrome (Claude Code's header has no server-label slot),
   *  but kept on the props contract for the host wiring that supplies it. */
  readonly serverLabel: string;
  /** Header label for the model new sessions dispatch with by default. */
  readonly modelLabel: string;
  /** Ctrl+X first-press target awaiting a second Ctrl+X. */
  readonly confirmDeleteId: string | undefined;
  readonly renameDraft: { readonly sessionId: string; readonly text: string } | undefined;
  readonly flashMessage: string | undefined;
  readonly dispatchFocused: boolean;
  /** The assembled dispatch editor (controller-owned); rendered into the bottom box. */
  readonly dispatchEditor: CustomEditor;
  onSelect(id: string): void;
  onOpen(id: string): void;
  onDeleteRequest(id: string): void;
  onDeleteConfirm(id: string): void;
  onRenameBegin(id: string): void;
  onRenameSubmit(id: string, text: string): void;
  onPinToggle(id: string): void;
  onHelpToggle(): void;
  onQuit(): void;
  onDispatchFocusChange(focused: boolean): void;
}

/** Minimum dimensions before we just print a "too small" message. */
const MIN_WIDTH = 48;
const MIN_HEIGHT = 10;

/** Header block: 3 info lines + 1 trailing blank before the first group (the
 *  blank line lives here, never as a leading spacer item — see `deriveItems`'s
 *  `moveSelection` invariant docs). */
const HEADER_HEIGHT = 4;

/** Small brand mark reused from the welcome banner (`chrome/welcome.ts`) —
 *  no new ASCII art invented for this view. */
const LOGO = ['▐█▛█▛█▌', '▐█████▌'] as const;

let cachedVersion: string | undefined;
function kimiVersion(): string {
  cachedVersion ??= getVersion();
  return cachedVersion;
}

const MORE_ITEM_ID = 'more:completed';

type ViewItemKind = 'header' | 'row' | 'more' | 'spacer';

interface ViewItem {
  readonly id: string;
  readonly kind: ViewItemKind;
  readonly group: AgentsGroup;
  readonly row?: AgentsRosterRow;
}

interface RenameState {
  readonly id: string;
  readonly original: string;
  text: string;
}

/**
 * `?` help overlay: a 2-row key/hint grid replacing the single-line footer
 * (the roster list itself stays visible and scrollable behind it — see
 * `render`). Column-aligned per row; `undefined` is a blank cell. Only keys
 * that exist today — the reorder / switch-views / mention / quick-open keys
 * from the Claude Code reference are a later task's addition.
 */
type HelpCell = readonly [key: string, hint: string];

const HELP_GRID: readonly (readonly (HelpCell | undefined)[])[] = [
  [
    ['↑↓', 'to select'],
    ['ctrl+r', 'to rename'],
    ['ctrl+t', 'to pin/unpin'],
    ['esc', 'to quit'],
  ],
  [
    ['ctrl+j', 'for newline'],
    ['ctrl+x', 'to delete'],
    undefined,
    ['?', 'to close'],
  ],
];

export class AgentsViewApp extends Container implements Focusable {
  focused = false;

  private props: AgentsViewProps;
  private readonly terminal: Terminal;
  private selectedIndex = 0;
  private listScroll = 0;
  private helpVisible = false;
  private rename: RenameState | undefined = undefined;

  constructor(props: AgentsViewProps, terminal: Terminal) {
    super();
    this.props = props;
    this.terminal = terminal;
    this.syncSelectionFromProps();
  }

  setProps(next: AgentsViewProps): void {
    this.props = next;
    this.syncSelectionFromProps();
    this.invalidate();
  }

  // ── derived view items (fresh on every call — rows are re-derived by
  //    the controller between frames, so never cache them) ──────────────

  private hiddenCompletedCount(): number {
    const pinnedRows = this.props.groups.find((g) => g.id === 'pinned')?.rows.length ?? 0;
    const shownCompleted = this.props.groups.find((g) => g.id === 'completed')?.rows.length ?? 0;
    // counts.completed covers both the pinned and completed buckets, so the
    // pinned rows must come out of the remainder or they phantom-inflate it.
    return Math.max(0, this.props.counts.completed - pinnedRows - shownCompleted);
  }

  private deriveItems(): ViewItem[] {
    const items: ViewItem[] = [];
    for (const group of this.props.groups) {
      // A blank line between groups, never before the first one.
      if (items.length > 0) items.push({ id: `spacer:${group.id}`, kind: 'spacer', group });
      items.push({ id: `group:${group.id}`, kind: 'header', group });
      for (const row of group.rows) items.push({ id: row.id, kind: 'row', group, row });
      if (group.id === 'completed' && this.hiddenCompletedCount() > 0) {
        items.push({ id: MORE_ITEM_ID, kind: 'more', group });
      }
    }
    return items;
  }

  private findRow(id: string): AgentsRosterRow | undefined {
    for (const group of this.props.groups) {
      const hit = group.rows.find((r) => r.id === id);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  private syncSelectionFromProps(): void {
    const items = this.deriveItems();
    if (items.length === 0) {
      this.selectedIndex = 0;
      this.listScroll = 0;
      return;
    }
    let idx = this.selectedIndex;
    if (this.props.selectedId !== undefined) {
      const found = items.findIndex((item) => item.id === this.props.selectedId);
      if (found !== -1) idx = found;
    }
    if (idx >= items.length) idx = items.length - 1;
    // A spacer is never a valid selection target — nudge onto the header
    // that always follows it.
    if (items[idx]?.kind === 'spacer') idx = Math.min(idx + 1, items.length - 1);
    this.selectedIndex = idx;
  }

  // ── key routing ─────────────────────────────────────────────────────

  handleInput(data: string): void {
    const k = printableChar(data);

    // Rename is a modal inline editor: all keys edit / submit / cancel.
    if (this.rename === undefined && this.props.renameDraft !== undefined) {
      this.rename = {
        id: this.props.renameDraft.sessionId,
        original: this.findRow(this.props.renameDraft.sessionId)?.title ?? this.props.renameDraft.text,
        text: this.props.renameDraft.text,
      };
    }
    if (this.rename !== undefined) {
      const rename = this.rename;
      if (matchesKey(data, Key.enter)) {
        this.rename = undefined;
        this.props.onRenameSubmit(rename.id, rename.text);
      } else if (matchesKey(data, Key.escape)) {
        // Cancel = submit the original title; the controller no-ops it.
        this.rename = undefined;
        this.props.onRenameSubmit(rename.id, rename.original);
      } else if (matchesKey(data, Key.backspace)) {
        rename.text = [...rename.text].slice(0, -1).join('');
      } else if (isPrintableChar(k)) {
        rename.text += k;
      }
      this.invalidate();
      return;
    }

    // Dispatch editor focused: every key belongs to the editor. Esc is the
    // editor's own onEscape (the controller wires it to unfocus); Enter is
    // the editor's own submit.
    if (this.props.dispatchFocused) {
      this.props.dispatchEditor.handleInput(data);
      this.invalidate();
      return;
    }

    // Help page: only `?` / Esc leave it.
    if (this.helpVisible) {
      if (k === '?' || matchesKey(data, Key.escape)) {
        this.helpVisible = false;
        if (k === '?') this.props.onHelpToggle();
        this.invalidate();
      }
      return;
    }

    if (matchesKey(data, Key.ctrl('x'))) {
      if (this.props.confirmDeleteId !== undefined) {
        this.props.onDeleteConfirm(this.props.confirmDeleteId);
        return;
      }
      const item = this.deriveItems()[this.selectedIndex];
      if (item !== undefined && item.kind !== 'more') this.props.onDeleteRequest(item.id);
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.props.onQuit();
      return;
    }

    // Once the dispatch editor holds text, printable chars belong to it —
    // the printable shortcuts below (j/k/q/?) only act on an empty
    // editor.
    if (this.props.dispatchEditor.getText().length > 0 && isPrintableChar(k)) {
      this.routeToDispatch(data);
      return;
    }

    if (k === '?') {
      this.helpVisible = true;
      this.props.onHelpToggle();
      this.invalidate();
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveSelection(1);
      return;
    }

    // ← / → : a tree-navigation convention on group headers only — → expands
    // a collapsed group, ← collapses an expanded one. A collapsed header is
    // recognizable by its emptied rows (the controller zeroes them). On a
    // row, → opens the session (same as Enter); ← is a no-op there.
    if (matchesKey(data, Key.right)) {
      const item = this.deriveItems()[this.selectedIndex];
      if (item !== undefined) {
        if (item.kind === 'row') this.props.onOpen(item.id);
        else if (item.kind === 'header' && item.group.rows.length === 0) this.props.onOpen(item.id);
      }
      return;
    }
    if (matchesKey(data, Key.left)) {
      const item = this.deriveItems()[this.selectedIndex];
      if (item !== undefined && item.kind === 'header' && item.group.rows.length > 0) {
        this.props.onOpen(item.id);
      }
      return;
    }

    const item = this.deriveItems()[this.selectedIndex];
    if (item !== undefined) {
      if (matchesKey(data, Key.enter)) {
        // `more:completed` and `group:*` ids are interpreted by the
        // controller (expand / collapse); a row id is an open request.
        this.props.onOpen(item.id);
        return;
      }
      if (matchesKey(data, Key.ctrl('r'))) {
        if (item.kind === 'row' && item.row !== undefined) {
          this.rename = { id: item.id, original: item.row.title, text: item.row.title };
          this.props.onRenameBegin(item.id);
          this.invalidate();
        }
        return;
      }
      if (matchesKey(data, Key.ctrl('t'))) {
        if (item.kind === 'row') this.props.onPinToggle(item.id);
        return;
      }
    }

    // Empty editor, no shortcut matched: start typing a dispatch.
    if (isPrintableChar(k)) {
      this.routeToDispatch(data);
    }
  }

  private routeToDispatch(data: string): void {
    this.props.dispatchEditor.handleInput(data);
    this.props.onDispatchFocusChange(true);
    this.invalidate();
  }

  private moveSelection(delta: number): void {
    const items = this.deriveItems();
    if (items.length === 0) return;
    let next = Math.max(0, Math.min(items.length - 1, this.selectedIndex + delta));
    // A spacer is never a valid stop — step over it in the same direction.
    // It always sits strictly between two groups, so this cannot run off
    // either end.
    while (items[next]?.kind === 'spacer') {
      next = Math.max(0, Math.min(items.length - 1, next + delta));
    }
    this.selectedIndex = next;
    this.props.onSelect(items[this.selectedIndex]?.id ?? '');
    this.invalidate();
  }

  // ── render ───────────────────────────────────────────────────────────

  override render(width: number): string[] {
    const rows = Math.max(1, this.terminal.rows);
    if (width < MIN_WIDTH || rows < MIN_HEIGHT) {
      return this.renderTooSmall(width, rows);
    }

    // The `?` grid replaces the single-line footer with a 2-row one — the
    // list's visible window shrinks by one row to make room; total screen
    // rows stay fixed either way.
    const footerLines = this.renderFooter(width);
    const bodyHeight = rows - HEADER_HEIGHT - footerLines.length;
    // The dispatch editor box (bordered CustomEditor: ≥3 lines, taller while
    // the autocomplete dropdown is open) takes the bottom of the body; the
    // list keeps at least 3 rows.
    const dispatchLines = this.props.dispatchEditor.render(width);
    const dispatchHeight = Math.min(dispatchLines.length, Math.max(3, bodyHeight - 3));
    const listHeight = Math.max(1, bodyHeight - dispatchHeight);

    // The roster stays visible and scrollable behind the `?` grid — it never
    // gets swapped out for a full-body help screen.
    return [
      ...this.renderHeader(width),
      ...this.renderList(width, listHeight),
      ...dispatchLines.slice(0, dispatchHeight),
      ...footerLines,
    ];
  }

  /**
   * 3 info lines (brand mark + version, model · cwd, status counts) + 1
   * trailing blank line before the first group. The blank line is rendered
   * HERE, not inserted into `deriveItems` as a leading spacer — a spacer at
   * index 0 would break `moveSelection`'s "spacer never sits at the list's
   * first stop" invariant and its step-over loop could spin forever.
   */
  private renderHeader(width: number): string[] {
    const { awaiting, working, completed } = this.props.counts;
    const logoWidth = Math.max(...LOGO.map((row) => visibleWidth(row)));
    const gap = '  ';
    const logoCol = (row: string): string =>
      ' ' + currentTheme.fg('primary', row) + ' '.repeat(logoWidth - visibleWidth(row)) + gap;

    const titleLine = logoCol(LOGO[0]) + currentTheme.boldFg('textStrong', `${PRODUCT_NAME} v${kimiVersion()}`);
    const modelCwdLine =
      logoCol(LOGO[1]) + currentTheme.fg('textMuted', `${this.props.modelLabel} · ${process.cwd()}`);
    const countsLine =
      ' ' +
      ' '.repeat(logoWidth) +
      gap +
      currentTheme.fg(
        'textDim',
        `${String(awaiting)} awaiting input · ${String(working)} working · ${String(completed)} completed`,
      );

    return [
      fitExactly(titleLine, width),
      fitExactly(modelCwdLine, width),
      fitExactly(countsLine, width),
      ' '.repeat(width),
    ];
  }

  private renderList(width: number, height: number): string[] {
    const items = this.deriveItems();
    const lines: string[] = [];
    if (items.length === 0) {
      lines.push(
        fitExactly(
          currentTheme.fg('textMuted', 'No sessions yet — type below to dispatch a new session.'),
          width,
        ),
      );
    } else {
      this.adjustScroll(height, items.length);
      const window = items.slice(this.listScroll, this.listScroll + height);
      for (const [vi, item] of window.entries()) {
        const selected = this.listScroll + vi === this.selectedIndex;
        lines.push(this.renderItem(item, selected, width));
      }
    }
    while (lines.length < height) lines.push(' '.repeat(width));
    return lines.slice(0, height);
  }

  private renderItem(item: ViewItem, selected: boolean, width: number): string {
    if (item.kind === 'spacer') {
      return ' '.repeat(width);
    }
    if (item.kind === 'header') {
      return renderGroupHeader(item.group.label, item.group.rows.length, selected, width);
    }
    if (item.kind === 'more') {
      return renderMoreRow(this.hiddenCompletedCount(), selected, width);
    }
    const row = item.row!;
    const draft = this.draftFor(row.id);
    if (draft !== undefined) {
      const line =
        currentTheme.fg(selected ? 'primary' : 'textDim', selected ? '▸ ' : '  ') +
        currentTheme.fg('accent', '✎ ') +
        currentTheme.fg('text', draft) +
        currentTheme.fg('textDim', '▌');
      return fitExactly(line, width);
    }
    return renderRosterRow(row, selected, width);
  }

  private draftFor(id: string): string | undefined {
    if (this.rename !== undefined && this.rename.id === id) return this.rename.text;
    if (this.props.renameDraft !== undefined && this.props.renameDraft.sessionId === id) {
      return this.props.renameDraft.text;
    }
    return undefined;
  }

  /**
   * The `?` grid: 2 rows, column-aligned (each column padded to its widest
   * cell across both rows). Replaces the single-line footer entirely while
   * visible — the roster list underneath is untouched (see `render`).
   */
  private renderHelpGrid(width: number): string[] {
    const columns = Math.max(...HELP_GRID.map((row) => row.length));
    const colWidths = Array.from({ length: columns }, (_unused, c) =>
      Math.max(
        0,
        ...HELP_GRID.map((row) => {
          const cell = row[c];
          return cell === undefined ? 0 : cell[0].length + 1 + cell[1].length;
        }),
      ),
    );
    return HELP_GRID.map((row) => {
      const cells = row.map((cell, c) => {
        const colWidth = colWidths[c] ?? 0;
        if (cell === undefined) return ' '.repeat(colWidth);
        const [cellKey, hint] = cell;
        const plainWidth = cellKey.length + 1 + hint.length;
        return (
          currentTheme.boldFg('primary', cellKey) +
          ' ' +
          currentTheme.fg('textMuted', hint) +
          ' '.repeat(Math.max(0, colWidth - plainWidth))
        );
      });
      return fitExactly('  ' + cells.join('   '), width);
    });
  }

  /**
   * Terse, `" · "`-joined hints (Claude Code's register) instead of an
   * always-on verbose bar — rename/pin/quit live in the `?` grid instead of
   * every row footer. Returns 2 lines while the `?` grid is open, 1
   * otherwise (see `render`'s header/footer height accounting).
   */
  private renderFooter(width: number): string[] {
    if (this.helpVisible) return this.renderHelpGrid(width);

    const key = (text: string): string => currentTheme.boldFg('primary', text);
    const dim = (text: string): string => currentTheme.fg('textMuted', text);
    const hint = (k: string, rest: string): string => `${key(k)} ${dim(rest)}`;
    const compose = (...parts: string[]): string => ` ${parts.join(dim(' · '))} `;

    let left: string;
    if (this.draftFor(this.props.renameDraft?.sessionId ?? this.rename?.id ?? '') !== undefined) {
      left = compose(hint('enter', 'to submit'), hint('esc', 'to cancel'));
    } else if (this.props.dispatchFocused) {
      left = compose(hint('enter', 'to dispatch'), hint('esc', 'to back to list'));
    } else if (this.props.confirmDeleteId !== undefined) {
      left = compose(
        currentTheme.boldFg('warning', this.deleteConfirmCopy(this.props.confirmDeleteId)),
        hint('ctrl+x', 'to confirm'),
        dim('any other key cancels'),
      );
    } else {
      const item = this.deriveItems()[this.selectedIndex];
      if (item === undefined) {
        left = compose(hint('?', 'for shortcuts'));
      } else if (item.kind === 'header') {
        left = compose(hint('enter', 'to collapse'), hint('ctrl+x', 'to delete all'), hint('?', 'for shortcuts'));
      } else if (item.kind === 'more') {
        left = compose(hint('enter', 'to expand'), hint('?', 'for shortcuts'));
      } else {
        left = compose(hint('enter', 'to open'), hint('ctrl+x', 'to delete'), hint('?', 'for shortcuts'));
      }
    }

    const flash = this.props.flashMessage;
    if (flash !== undefined && flash.length > 0) {
      const flashStyled = currentTheme.fg('warning', ` ${flash} `);
      const flashWidth = visibleWidth(flashStyled);
      if (flashWidth < width) {
        // The flash is transient and carries the action's outcome (dispatch
        // errors!) — the static key hints truncate to make room instead of
        // the flash being dropped on narrower terminals.
        return [fitExactly(left, width - flashWidth) + flashStyled];
      }
      return [fitExactly(flashStyled, width)];
    }
    return [fitExactly(left, width)];
  }

  private deleteConfirmCopy(id: string): string {
    if (id.startsWith('group:')) {
      const groupId = id.slice('group:'.length) as AgentsGroupId;
      const group = this.props.groups.find((g) => g.id === groupId);
      const label = group?.label ?? groupId;
      const busyCount = group?.rows.filter((r) => r.busy).length ?? 0;
      return (
        `Archive all sessions in "${label}"?` +
        (busyCount > 0 ? ' Running turns will be cancelled first.' : '')
      );
    }
    const row = this.findRow(id);
    const title = row?.title ?? id;
    const busy = row?.busy ?? false;
    return `Archive session "${title}"?` + (busy ? ' Its running turn will be cancelled first.' : '');
  }

  private adjustScroll(visibleRows: number, itemCount: number): void {
    if (visibleRows <= 0) {
      this.listScroll = 0;
      return;
    }
    if (this.selectedIndex < this.listScroll) {
      this.listScroll = this.selectedIndex;
    } else if (this.selectedIndex >= this.listScroll + visibleRows) {
      this.listScroll = this.selectedIndex - visibleRows + 1;
    }
    const maxScroll = Math.max(0, itemCount - visibleRows);
    if (this.listScroll < 0) this.listScroll = 0;
    if (this.listScroll > maxScroll) this.listScroll = maxScroll;
  }

  private renderTooSmall(width: number, rows: number): string[] {
    const lines: string[] = [];
    const msg = currentTheme.fg(
      'error',
      `Terminal too small (need ≥ ${String(MIN_WIDTH)} × ${String(MIN_HEIGHT)})`,
    );
    lines.push(fitExactly(msg, width));
    for (let i = 1; i < rows; i++) lines.push(' '.repeat(width));
    return lines;
  }
}
