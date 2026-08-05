/**
 * AgentsViewApp — full-screen alt-screen takeover listing every kap-server
 * session as a grouped roster (Awaiting input / Working / Pinned /
 * Completed). Mirrors the TasksBrowserApp mount/render contract: mounted by
 * a controller via container swap, `render(width)` returns exactly
 * `terminal.rows` lines (header 1 + body rows-2 + footer 1), data flows in
 * via `setProps`, user actions fire the `on*` callbacks.
 *
 * Zero SDK access: the controller owns the roster, peek content, delete /
 * rename / pin side effects and re-pushes props after every action.
 *
 * Behaviour notes for the controller (design §4.3 state machine):
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
 *   text; the printable shortcuts (j/k/q/Space/?) only act while the
 *   editor is EMPTY, once it holds text every printable char belongs to it.
 * - Peek reply: while a peek is open, printable input edits the reply draft
 *   via `onPeekReplyChange` (the controller owns the draft and the steer
 *   side effect), Enter fires `onPeekReplySubmit`, and Esc clears a
 *   non-empty draft before closing the peek. The dispatch editor never
 *   sees these keys — a reply must not become a new-session dispatch.
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
import { currentTheme } from '#/tui/theme';
import { printableChar, isPrintableChar } from '@/tui/utils/printable-key';

import { fitExactly, renderGroupHeader, renderMoreRow, renderRosterRow } from './rows';

export interface AgentsViewPeek {
  readonly sessionId: string;
  readonly lines: readonly string[];
  readonly replyDraft: string;
}

export interface AgentsViewProps {
  readonly groups: readonly AgentsGroup[];
  readonly counts: { awaiting: number; working: number; completed: number };
  /** Selected item: a row id, `group:<id>`, or `more:completed`. */
  readonly selectedId: string | undefined;
  /** "embedded" or host:port of the connected kap-server. */
  readonly serverLabel: string;
  readonly peek: AgentsViewPeek | undefined;
  /** Ctrl+X first-press target awaiting a second Ctrl+X. */
  readonly confirmDeleteId: string | undefined;
  readonly renameDraft: { readonly sessionId: string; readonly text: string } | undefined;
  readonly flashMessage: string | undefined;
  readonly dispatchFocused: boolean;
  /** The assembled dispatch editor (controller-owned); rendered into the bottom box. */
  readonly dispatchEditor: CustomEditor;
  onSelect(id: string): void;
  onOpen(id: string): void;
  onPeekToggle(id: string): void;
  onDeleteRequest(id: string): void;
  onDeleteConfirm(id: string): void;
  onRenameBegin(id: string): void;
  onRenameSubmit(id: string, text: string): void;
  onPinToggle(id: string): void;
  onHelpToggle(): void;
  onQuit(): void;
  onDispatchFocusChange(focused: boolean): void;
  /** Peek reply draft edit (printable char / Backspace / Esc-clear). */
  onPeekReplyChange(text: string): void;
  /** Enter while peeked: submit the current draft as a steer to this session. */
  onPeekReplySubmit(sessionId: string): void;
}

/** Minimum dimensions before we just print a "too small" message. */
const MIN_WIDTH = 48;
const MIN_HEIGHT = 10;

const MORE_ITEM_ID = 'more:completed';

type ViewItemKind = 'header' | 'row' | 'more';

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

const HELP_LINES: readonly string[] = [
  'Shortcuts',
  '',
  '  ↑/↓ or j/k   move selection (j/k type into a non-empty dispatch box)',
  '  type         focus the dispatch editor · Enter dispatches · Esc back',
  '  Enter        open session · collapse/expand group · expand completed',
  '  Space        peek latest output · type to draft a reply · Enter sends',
  '  Ctrl+X       delete session (press twice to confirm)',
  '  Ctrl+R       rename session',
  '  Ctrl+T       pin / unpin',
  '  ?            toggle this help',
  '  Esc / q      quit (Esc clears the reply draft, then closes peek)',
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
    if (this.props.selectedId !== undefined) {
      const idx = items.findIndex((item) => item.id === this.props.selectedId);
      if (idx !== -1) {
        this.selectedIndex = idx;
        return;
      }
    }
    if (this.selectedIndex >= items.length) this.selectedIndex = items.length - 1;
  }

  // ── key routing (design §4.3 state machine) ──────────────────────────

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
      const peek = this.props.peek;
      // Esc clears a non-empty reply draft first; the next Esc closes the peek.
      if (peek !== undefined && peek.replyDraft !== '') this.props.onPeekReplyChange('');
      else if (peek !== undefined) this.props.onPeekToggle(peek.sessionId);
      else this.props.onQuit();
      return;
    }

    // Peek reply box: while a peek is open, printable input drafts the reply
    // — NEVER the dispatch editor, or a reply would silently become a
    // new-session dispatch. Enter submits, Backspace edits; navigation keys
    // fall through to the list handling below.
    const peek = this.props.peek;
    if (peek !== undefined) {
      if (matchesKey(data, Key.enter)) {
        this.props.onPeekReplySubmit(peek.sessionId);
        return;
      }
      if (matchesKey(data, Key.backspace)) {
        this.props.onPeekReplyChange([...peek.replyDraft].slice(0, -1).join(''));
        return;
      }
      if (isPrintableChar(k)) {
        this.props.onPeekReplyChange(peek.replyDraft + k);
        return;
      }
    }

    // Once the dispatch editor holds text, printable chars belong to it —
    // the printable shortcuts below (j/k/q/Space/?) only act on an empty
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

    if (k === 'q' || k === 'Q') {
      this.props.onQuit();
      return;
    }

    if (matchesKey(data, Key.up) || k === 'k') {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, Key.down) || k === 'j') {
      this.moveSelection(1);
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
      if (k === ' ') {
        if (item.kind === 'row') this.props.onPeekToggle(item.id);
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
    this.selectedIndex = Math.max(0, Math.min(items.length - 1, this.selectedIndex + delta));
    this.props.onSelect(items[this.selectedIndex]?.id ?? '');
    this.invalidate();
  }

  // ── render ───────────────────────────────────────────────────────────

  override render(width: number): string[] {
    const rows = Math.max(1, this.terminal.rows);
    if (width < MIN_WIDTH || rows < MIN_HEIGHT) {
      return this.renderTooSmall(width, rows);
    }

    const bodyHeight = rows - 2;
    // The dispatch editor box (bordered CustomEditor: ≥3 lines, taller while
    // the autocomplete dropdown is open) takes the bottom of the body; the
    // list keeps at least 3 rows.
    const dispatchLines = this.props.dispatchEditor.render(width);
    const dispatchHeight = Math.min(dispatchLines.length, Math.max(3, bodyHeight - 3));
    const listHeight = Math.max(1, bodyHeight - dispatchHeight);

    const lines: string[] = [this.renderHeader(width)];
    if (this.helpVisible) {
      lines.push(...this.renderHelp(width, listHeight));
    } else if (this.props.peek !== undefined) {
      const peekHeight = Math.max(3, Math.floor(listHeight / 3));
      lines.push(...this.renderList(width, listHeight - peekHeight));
      lines.push(...this.renderPeek(width, peekHeight, this.props.peek));
    } else {
      lines.push(...this.renderList(width, listHeight));
    }
    lines.push(...dispatchLines.slice(0, dispatchHeight));
    lines.push(this.renderFooter(width));
    return lines;
  }

  private renderHeader(width: number): string {
    const { awaiting, working, completed } = this.props.counts;
    const line =
      currentTheme.boldFg('primary', ' KIMI AGENTS ') +
      currentTheme.fg('textMuted', ` ${this.props.serverLabel} `) +
      currentTheme.fg(
        'textDim',
        ` ${String(awaiting)} awaiting input · ${String(working)} working · ${String(completed)} completed `,
      );
    return fitExactly(line, width);
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

  private renderPeek(width: number, height: number, peek: AgentsViewPeek): string[] {
    const title = this.findRow(peek.sessionId)?.title ?? peek.sessionId;
    const label = `─ Peek: ${title} `;
    const lines: string[] = [
      fitExactly(currentTheme.fg('primary', label + '─'.repeat(Math.max(0, width - visibleWidth(label)))), width),
    ];
    const bodyRows = height - 2;
    for (const text of peek.lines.slice(-Math.max(0, bodyRows))) {
      lines.push(fitExactly(currentTheme.fg('textDim', ` ${text}`), width));
    }
    while (lines.length < height - 1) lines.push(' '.repeat(width));
    lines.push(
      fitExactly(
        currentTheme.fg('accent', ' reply › ') +
          currentTheme.fg('text', peek.replyDraft) +
          currentTheme.fg('textDim', '▌'),
        width,
      ),
    );
    return lines.slice(0, height);
  }

  private renderHelp(width: number, height: number): string[] {
    const lines: string[] = [];
    for (const [i, text] of HELP_LINES.entries()) {
      lines.push(
        fitExactly(i === 0 ? currentTheme.boldFg('textStrong', text) : currentTheme.fg('text', text), width),
      );
    }
    while (lines.length < height) lines.push(' '.repeat(width));
    return lines.slice(0, height);
  }

  private renderFooter(width: number): string {
    const key = (text: string): string => currentTheme.boldFg('primary', text);
    const dim = (text: string): string => currentTheme.fg('textMuted', text);

    let left: string;
    if (this.draftFor(this.props.renameDraft?.sessionId ?? this.rename?.id ?? '') !== undefined) {
      left = ` ${key('Enter')} ${dim('submit rename')}  ${key('Esc')} ${dim('cancel')} `;
    } else if (this.props.dispatchFocused) {
      left = ` ${key('Enter')} ${dim('dispatch')}  ${key('Esc')} ${dim('back to list')} `;
    } else if (this.props.confirmDeleteId !== undefined) {
      left = ` ${currentTheme.boldFg('warning', this.deleteConfirmCopy(this.props.confirmDeleteId))} ${key('^X')} ${dim('confirm')}  ${dim('any other key cancels')} `;
    } else if (this.helpVisible) {
      left = ` ${key('?')}${dim('/')}${key('Esc')} ${dim('close')} `;
    } else if (this.props.peek !== undefined) {
      left = ` ${key('Enter')} ${dim('send reply')}  ${key('Esc')} ${dim('clear draft / close peek')} `;
    } else {
      const item = this.deriveItems()[this.selectedIndex];
      if (item === undefined) {
        left = ` ${key('?')} ${dim('shortcuts')}  ${key('q')} ${dim('quit')} `;
      } else if (item.kind === 'header') {
        left = ` ${key('↑↓')} ${dim('select')}  ${key('Enter')} ${dim('collapse')}  ${key('^X')} ${dim('delete group')}  ${key('?')} ${dim('shortcuts')}  ${key('q')} ${dim('quit')} `;
      } else if (item.kind === 'more') {
        left = ` ${key('↑↓')} ${dim('select')}  ${key('Enter')} ${dim('expand')}  ${key('q')} ${dim('quit')} `;
      } else {
        left = ` ${key('↑↓')} ${dim('select')}  ${key('Enter')} ${dim('open')}  ${key('Space')} ${dim('peek')}  ${key('^X')} ${dim('delete')}  ${key('^R')} ${dim('rename')}  ${key('^T')} ${dim('pin')}  ${key('?')} ${dim('shortcuts')}  ${key('q')} ${dim('quit')} `;
      }
    }

    const flash = this.props.flashMessage;
    if (flash !== undefined && flash.length > 0) {
      const flashStyled = currentTheme.fg('warning', ` ${flash} `);
      const total = visibleWidth(left) + visibleWidth(flashStyled);
      if (total <= width) return left + ' '.repeat(width - total) + flashStyled;
    }
    return fitExactly(left, width);
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
