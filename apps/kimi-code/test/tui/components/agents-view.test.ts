import type { Terminal, TUI } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AgentsGroup, AgentsGroupId, AgentsRosterRow } from '@/tui/agents/roster';
import { AgentsViewApp, type AgentsViewProps } from '@/tui/components/agents-view/app';
import { AgentsExitConfirmComponent } from '@/tui/components/agents-view/exit-confirm';
import { CustomEditor } from '@/tui/components/editor/custom-editor';
import { darkColors } from '@/tui/theme/colors';

const ANSI_SGR = /\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

const ESC = String.fromCodePoint(27);
const CTRL_C = String.fromCodePoint(3);

/** Minimal Terminal stub — only `rows` is read by the component. */
function fakeTerminal(rows: number, columns = 120): Terminal {
  return {
    start: () => {},
    stop: () => {},
    drainInput: () => Promise.resolve(),
    write: () => {},
    get columns() {
      return columns;
    },
    get rows() {
      return rows;
    },
    get kittyProtocolActive() {
      return false;
    },
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
  };
}

const GROUP_LABELS: Record<AgentsGroupId, string> = {
  awaiting: 'Needs input',
  working: 'Working',
  pinned: 'Pinned',
  completed: 'Completed',
};

function row(id: string, overrides: Partial<AgentsRosterRow> = {}): AgentsRosterRow {
  return {
    id,
    title: `${id} title`,
    workDir: '/home/user/project',
    updatedAt: 1_000,
    busy: false,
    pendingInteraction: 'none',
    pinned: false,
    unseen: false,
    ...overrides,
  };
}

function group(id: AgentsGroupId, rows: readonly AgentsRosterRow[]): AgentsGroup {
  return { id, label: GROUP_LABELS[id], rows };
}

/** A real dispatch editor over a minimal fake TUI (same stub shape as the
 *  controller test's FakeUI), built with the same options the real
 *  `AgentsViewDispatch` uses — the rule-only frame, `❯` prompt and
 *  placeholder are only real if the fixture actually opts into them. */
function makeDispatchEditor(): CustomEditor {
  const tui = {
    requestRender: () => {},
    render: () => [],
    terminal: { rows: 40, columns: 120 },
  } as unknown as TUI;
  return new CustomEditor(tui, {
    frameVariant: 'rules',
    promptSymbol: '❯',
    placeholder: 'describe a task for a new session',
  });
}

function makeProps(overrides: Partial<AgentsViewProps> = {}): AgentsViewProps {
  return {
    groups: [],
    counts: { awaiting: 0, working: 0, completed: 0 },
    selectedId: undefined,
    originId: undefined,
    serverLabel: 'embedded',
    modelLabel: 'kimi-k2',
    confirmDeleteId: undefined,
    renameDraft: undefined,
    flashMessage: undefined,
    dispatchFocused: false,
    dispatchEditor: makeDispatchEditor(),
    replyTargetId: undefined,
    pendingReplyIds: new Set(),
    replyFailureIds: new Set(),
    pendingExitArmed: false,
    onSelect: vi.fn(),
    onOpen: vi.fn(),
    onDeleteRequest: vi.fn(),
    onDeleteConfirm: vi.fn(),
    onRenameBegin: vi.fn(),
    onRenameSubmit: vi.fn(),
    onPinToggle: vi.fn(),
    onReplyRequest: vi.fn(),
    onReorderPinned: vi.fn(),
    onHelpToggle: vi.fn(),
    onQuit: vi.fn(),
    onCtrlC: vi.fn(),
    onDispatchFocusChange: vi.fn(),
    ...overrides,
  };
}

function makeApp(props: Partial<AgentsViewProps> = {}, rows = 30, columns = 120): AgentsViewApp {
  return new AgentsViewApp(makeProps(props), fakeTerminal(rows, columns));
}

function render(app: AgentsViewApp, width = 120): string {
  return strip(app.render(width).join('\n'));
}

/** Unstripped join, for bold-vs-plain SGR assertions `render()` can't make. */
function renderRaw(app: AgentsViewApp, width = 120): string {
  return app.render(width).join('\n');
}

describe('AgentsViewApp — originId threads into the row\'s bold "came from" styling', () => {
  // R4 parity: `originId` (the session this roster-attach lifecycle was
  // last backed out of via ←) is independent of `selectedId` — only the
  // row matching `originId` bolds its name, and moving the cursor selection
  // must not touch it.
  //
  // Bold-vs-plain assertions below need chalk actually emitting SGR codes —
  // the test process is not a TTY, so chalk auto-detects level 0 without
  // this. Scoped to just this describe block: this file's own `strip()`
  // (used by every OTHER describe block here) doesn't strip the leading ESC
  // byte, so forcing color file-wide would leave stray ESC characters in
  // every stripped substring check outside this block.
  const previousChalkLevel = chalk.level;
  beforeAll(() => {
    chalk.level = 3;
  });
  afterAll(() => {
    chalk.level = previousChalkLevel;
  });

  it('the row matching originId renders its name bold; other rows do not', () => {
    const groups = [group('working', [row('s1'), row('s2')])];
    const out = renderRaw(makeApp({ groups, originId: 's1' }));
    const lines = out.split('\n');
    const s1Line = lines.find((l) => l.includes('s1 title'));
    const s2Line = lines.find((l) => l.includes('s2 title'));
    expect(s1Line).toContain(chalk.hex(darkColors.textStrong).bold('s1 title'));
    expect(s2Line).not.toContain(chalk.hex(darkColors.textStrong).bold('s2 title'));
  });

  it('selecting a different row than originId does not bold the selected row nor un-bold the origin row', () => {
    const groups = [group('working', [row('s1'), row('s2')])];
    const out = renderRaw(makeApp({ groups, originId: 's1', selectedId: 's2' }));
    const lines = out.split('\n');
    const s1Line = lines.find((l) => l.includes('s1 title'));
    const s2Line = lines.find((l) => l.includes('s2 title'));
    expect(s1Line).toContain(chalk.hex(darkColors.textStrong).bold('s1 title'));
    expect(s2Line).not.toContain(chalk.hex(darkColors.textStrong).bold('s2 title'));
  });

  it('originId undefined (fresh open, no prior attach): no row is bold', () => {
    const groups = [group('working', [row('s1'), row('s2')])];
    const out = renderRaw(makeApp({ groups, originId: undefined, selectedId: 's1' }));
    const lines = out.split('\n');
    const s1Line = lines.find((l) => l.includes('s1 title'));
    expect(s1Line).not.toContain(chalk.hex(darkColors.textStrong).bold('s1 title'));
  });

  it('the same row as both selected and origin still bolds (the two flags compose)', () => {
    const groups = [group('working', [row('s1')])];
    const out = renderRaw(makeApp({ groups, originId: 's1', selectedId: 's1' }));
    const line = out.split('\n').find((l) => l.includes('s1 title'));
    expect(line).toContain(chalk.hex(darkColors.textStrong).bold('s1 title'));
  });

  it('the selected row carries the surfaceSelected background fill; an unselected row does not', () => {
    const bgOpen = chalk.bgHex(darkColors.surfaceSelected)('x').split('x')[0];
    const groups = [group('working', [row('s1'), row('s2')])];
    const out = renderRaw(makeApp({ groups, selectedId: 's1' }));
    const lines = out.split('\n');
    const s1Line = lines.find((l) => l.includes('s1 title'));
    const s2Line = lines.find((l) => l.includes('s2 title'));
    expect(s1Line).toContain(bgOpen);
    expect(s2Line).not.toContain(bgOpen);
  });

  it('the same row as both selected and origin shows the background fill AND the bold name together', () => {
    const bgOpen = chalk.bgHex(darkColors.surfaceSelected)('x').split('x')[0];
    const groups = [group('working', [row('s1')])];
    const out = renderRaw(makeApp({ groups, originId: 's1', selectedId: 's1' }));
    const line = out.split('\n').find((l) => l.includes('s1 title'));
    expect(line).toContain(bgOpen);
    expect(line).toContain(chalk.hex(darkColors.textStrong).bold('s1 title'));
  });
});

describe('AgentsViewApp — full-screen rendering', () => {
  it('fills exactly terminal.rows lines (height takeover)', () => {
    const lines = makeApp({}, 30).render(120);
    expect(lines.length).toBe(30);
  });

  it('reacts to terminal height changes', () => {
    const props = makeProps({ groups: [group('working', [row('s1', { busy: true })])] });
    expect(new AgentsViewApp(props, fakeTerminal(15, 120)).render(120).length).toBe(15);
    expect(new AgentsViewApp(props, fakeTerminal(40, 120)).render(120).length).toBe(40);
  });

  it('falls back to a too-small message below the minimum size', () => {
    const out = render(makeApp({}, 5, 30), 30);
    expect(out).toContain('too small');
  });

  it('shows the 3-line header (brand + version / model · cwd / status counts), then a trailing blank line', () => {
    const lines = makeApp({
      counts: { awaiting: 1, working: 2, completed: 5 },
      modelLabel: 'kimi-k2',
    })
      .render(120)
      .map(strip);
    expect(lines[0]).toContain('Kimi Code v');
    expect(lines[1]).toContain('kimi-k2');
    expect(lines[1]).toContain(process.cwd());
    expect(lines[2]).toContain('1 awaiting input');
    expect(lines[2]).toContain('2 working');
    expect(lines[2]).toContain('5 completed');
    expect(lines[3]?.trim()).toBe('');
  });

  it('drops the server label from the header — Claude Code has no server-label slot there', () => {
    const out = render(makeApp({ serverLabel: '127.0.0.1:58627' }));
    expect(out).not.toContain('127.0.0.1:58627');
  });

  it('renders group headers and rows in group order', () => {
    const out = render(
      makeApp({
        groups: [
          group('awaiting', [row('await-1', { pendingInteraction: 'approval' })]),
          group('working', [row('work-1', { busy: true })]),
          group('completed', [row('done-1')]),
        ],
      }),
    );
    const awaitingHeader = out.indexOf('Needs input');
    const workingHeader = out.indexOf('Working');
    const completedHeader = out.indexOf('Completed');
    expect(awaitingHeader).toBeGreaterThan(-1);
    expect(workingHeader).toBeGreaterThan(awaitingHeader);
    expect(completedHeader).toBeGreaterThan(workingHeader);
    expect(out.indexOf('await-1 title')).toBeGreaterThan(awaitingHeader);
    expect(out.indexOf('await-1 title')).toBeLessThan(workingHeader);
    expect(out.indexOf('work-1 title')).toBeGreaterThan(workingHeader);
    expect(out.indexOf('work-1 title')).toBeLessThan(completedHeader);
    expect(out.indexOf('done-1 title')).toBeGreaterThan(completedHeader);
  });

  it('inserts a blank spacer line between groups; the blank before the first one is the header\'s own trailing line, not a deriveItems spacer', () => {
    const app = makeApp({
      groups: [
        group('awaiting', [row('await-1', { pendingInteraction: 'approval' })]),
        group('working', [row('work-1', { busy: true })]),
      ],
    });
    const lines = app.render(120).map(strip);
    const awaitingHeaderIdx = lines.findIndex((l) => l.includes('Needs input'));
    const workingHeaderIdx = lines.findIndex((l) => l.includes('Working'));
    // The line right above the second group's header is a deriveItems spacer.
    expect(lines[workingHeaderIdx - 1]?.trim()).toBe('');
    // The first group sits right after the fixed 4-line header block (3 info
    // lines + its own trailing blank at index 3) — never a leading spacer
    // item, which would break moveSelection's step-over invariant.
    expect(awaitingHeaderIdx).toBe(4);
    expect(lines[3]?.trim()).toBe('');
  });

  it('renders the untrusted badge on rows, without the cwd', () => {
    const out = render(
      makeApp({
        groups: [
          group('awaiting', [
            row('s1', { pendingInteraction: 'question', trusted: false, workDir: '/tmp/secretproj' }),
          ]),
        ],
      }),
    );
    expect(out).not.toContain('secretproj');
    expect(out).toContain('untrusted');
  });

  it('renders the assistant reply summary next to the name', () => {
    const out = render(
      makeApp({
        groups: [
          group('completed', [
            row('s1', { title: 's1 title', lastAssistantText: 'the answer is 42' }),
          ]),
        ],
      }),
    );
    expect(out).toContain('the answer is 42');
  });

  it('shows the empty-state copy when there are no groups', () => {
    const out = render(makeApp());
    expect(out).toContain('No sessions');
  });

  it('renders the dispatch editor as a rule-only frame with its `❯` prompt', () => {
    const out = render(makeApp());
    expect(out).toContain('─'.repeat(20));
    expect(out).toContain('❯');
  });

  it('composer: an empty buffer shows the dim placeholder, no side borders on the rule frame', () => {
    const lines = makeApp().render(120).map(strip);
    const ruleLines = lines.filter((l) => l.length > 0 && l[0] === '─' && l.at(-1) === '─');
    expect(ruleLines.length).toBe(2); // top + bottom rule, full-width dashes
    const promptLine = lines.find((l) => l.includes('❯'));
    expect(promptLine).toContain('describe a task for a new session');
    // No side bars or corners anywhere — the rule-only variant never draws them.
    expect(lines.some((l) => /[╭╮╰╯│]/.test(l))).toBe(false);
  });

  it('composer: a non-empty buffer hides the placeholder and shows the typed text', () => {
    const editor = makeDispatchEditor();
    editor.setText('fix the flaky test');
    const out = render(makeApp({ dispatchEditor: editor }));
    expect(out).toContain('fix the flaky test');
    expect(out).not.toContain('describe a task for a new session');
  });

  it('collapses completed rows behind a "… N more" row', () => {
    const completedRows = Array.from({ length: 10 }, (_, i) => row(`done-${String(i)}`));
    const out = render(
      makeApp({
        groups: [group('completed', completedRows)],
        counts: { awaiting: 0, working: 0, completed: 13 },
      }),
    );
    expect(out).toContain('… 3 more');
  });

  it('does not count pinned rows toward the "… N more" remainder', () => {
    // counts().completed includes the pinned bucket; with 2 pinned rows and
    // 10 completed rows shown, a total of 12 must NOT render a phantom
    // "… 2 more" (the naive `completed − shown` formula would).
    const completedRows = Array.from({ length: 10 }, (_, i) => row(`done-${String(i)}`));
    const pinnedRows = [row('pin-1', { pinned: true }), row('pin-2', { pinned: true })];
    const noMore = render(
      makeApp({
        groups: [group('pinned', pinnedRows), group('completed', completedRows)],
        counts: { awaiting: 0, working: 0, completed: 12 },
      }),
    );
    expect(noMore).not.toContain('more');
    const oneMore = render(
      makeApp({
        groups: [group('pinned', pinnedRows), group('completed', completedRows)],
        counts: { awaiting: 0, working: 0, completed: 13 },
      }),
    );
    expect(oneMore).toContain('… 1 more');
  });

  it('a manually-collapsed Completed group shows its real hidden count, never a contradicting "… N more" row', () => {
    // Mirrors the controller's collapse transform: rows emptied, the
    // window's true size (10, not the group's full 13) stashed in
    // collapsedCount. Before the fix, hiddenCompletedCount() still read the
    // now-empty rows.length and derived a second, different number for a
    // phantom "more" row underneath an already-collapsed header.
    const collapsedCompleted: AgentsGroup = {
      id: 'completed',
      label: 'Completed',
      rows: [],
      collapsedCount: 10,
    };
    const out = render(makeApp({ groups: [collapsedCompleted], counts: { awaiting: 0, working: 0, completed: 13 } }));
    expect(out).toContain('Completed (10)');
    expect(out).not.toContain('more');
  });

  it('a manually-collapsed Pinned group does not inflate the Completed "… N more" remainder', () => {
    // Collapsing Pinned also empties its rows — hiddenCompletedCount() must
    // still subtract the real pinned count (from collapsedCount, not the
    // now-empty rows.length) or the remainder phantom-inflates by however
    // many rows are pinned.
    const collapsedPinned: AgentsGroup = { id: 'pinned', label: 'Pinned', rows: [], collapsedCount: 2 };
    const completedRows = Array.from({ length: 10 }, (_, i) => row(`done-${String(i)}`));
    const out = render(
      makeApp({
        groups: [collapsedPinned, group('completed', completedRows)],
        counts: { awaiting: 0, working: 0, completed: 13 },
      }),
    );
    expect(out).toContain('… 1 more');
  });

  it('renders freshly derived rows after setProps (no stale row cache)', () => {
    const app = makeApp({ groups: [group('completed', [row('s1', { title: 'old title' })])] });
    app.setProps(makeProps({ groups: [group('completed', [row('s1', { title: 'new title' })])] }));
    const out = render(app);
    expect(out).toContain('new title');
    expect(out).not.toContain('old title');
  });

  it('renders the title once — the last prompt is not repeated next to it', () => {
    // The server auto-titles a session with its first prompt verbatim, so a
    // row that showed both read as the same message twice.
    const out = render(
      makeApp({
        groups: [
          group('completed', [
            row('s1', { title: 'fix the flaky test', lastPrompt: 'fix the flaky test' }),
          ]),
        ],
      }),
    );
    expect(out.indexOf('fix the flaky test')).toBe(out.lastIndexOf('fix the flaky test'));
  });

  it('an untitled row falls back to its last prompt as the name', () => {
    const out = render(
      makeApp({
        groups: [
          group('completed', [row('s1', { title: '', lastPrompt: 'summarize   the\nlogs' })]),
        ],
      }),
    );
    expect(out).toContain('summarize the logs');
  });

  it('a failed last turn renders the same seen/unseen glyph as any other idle row — no ✗ marker', () => {
    const seen = render(
      makeApp({
        groups: [group('completed', [row('s1', { lastTurnReason: 'failed', unseen: false })])],
      }),
    );
    expect(seen).not.toContain('✗');
    expect(seen).toContain('∙');

    const unseen = render(
      makeApp({
        groups: [group('completed', [row('s1', { lastTurnReason: 'failed', unseen: true })])],
      }),
    );
    expect(unseen).not.toContain('✗');
    expect(unseen).toContain('✻');
  });

  it('renders flash messages in the footer', () => {
    const out = render(makeApp({ flashMessage: 'Attach is not available from this host' }));
    expect(out).toContain('Attach is not available from this host');
  });

  it('a flash truncates the static hints instead of being dropped', () => {
    // Selection on a group header makes the hint bar long; hints + this flash
    // do not both fit at 120 columns — the flash (the action's outcome) wins.
    const out = render(
      makeApp({
        groups: [group('completed', [row('s1')])],
        counts: { awaiting: 0, working: 0, completed: 1 },
        selectedId: 'group:completed',
        flashMessage: 'Dispatch failed: workspace rejected',
      }),
    );
    expect(out).toContain('Dispatch failed: workspace rejected');
  });
});

describe('AgentsViewApp — collapsed group header shows its hidden count', () => {
  it('an expanded group header renders the label alone, on one line, no count', () => {
    // The first group's header is auto-selected on boot (parity spec), so
    // strip the leading pointer the same way the row layout tests do.
    const lines = makeApp({
      groups: [group('completed', [row('done-1'), row('done-2')])],
    })
      .render(120)
      .map(strip);
    const headerLine = lines.find((l) => l.includes('Completed'));
    expect(headerLine?.replace(/^[❯\s]+/, '').trim()).toBe('Completed');
  });

  it('a manually-collapsed group header renders label + hidden count together, on one line', () => {
    // Mirrors what the controller's collapse transform actually produces:
    // rows emptied, the true size stashed in collapsedCount.
    const collapsedGroup: AgentsGroup = { id: 'completed', label: 'Completed', rows: [], collapsedCount: 9 };
    const lines = makeApp({ groups: [collapsedGroup] }).render(120).map(strip);
    const headerLine = lines.find((l) => l.includes('Completed'));
    expect(headerLine?.replace(/^[❯\s]+/, '').trim()).toBe('Completed (9)');
    // Regression guard: the count must never land on the line below the
    // label — the very bug this test was written to catch.
    const headerIdx = lines.findIndex((l) => l.includes('Completed'));
    expect(lines[headerIdx + 1]?.trim()).not.toMatch(/^\d/);
  });
});

describe('AgentsViewApp — footer hints follow the selection target', () => {
  const completedRows = Array.from({ length: 10 }, (_, i) => row(`done-${String(i)}`));
  const groups = [
    group('working', [row('work-1', { busy: true })]),
    group('completed', completedRows),
  ];
  const counts = { awaiting: 0, working: 1, completed: 11 };

  it('session row footer mentions open/reply/delete — rename/pin moved into the ? grid', () => {
    const out = render(makeApp({ groups, counts, selectedId: 'work-1' }));
    expect(out).toContain('enter to open');
    expect(out).toContain('space to reply');
    expect(out).toContain('ctrl+x to delete');
    expect(out).not.toContain('rename');
    expect(out).not.toContain('pin');
  });

  it('group header footer mentions collapse', () => {
    const out = render(makeApp({ groups, counts, selectedId: 'group:completed' }));
    expect(out).toContain('collapse');
  });

  it('more-row footer mentions expand', () => {
    const out = render(makeApp({ groups, counts, selectedId: 'more:completed' }));
    expect(out).toContain('expand');
  });
});

describe('AgentsViewApp — navigation', () => {
  const groups = [group('working', [row('a', { busy: true }), row('b', { busy: true })])];

  it('arrow keys move the selection across rows and group headers', () => {
    const onSelect = vi.fn();
    const app = makeApp({ groups, selectedId: 'a', onSelect });
    app.handleInput('\u001B[B'); // ↓
    expect(onSelect).toHaveBeenLastCalledWith('b');
    app.handleInput('\u001B[A'); // ↑
    expect(onSelect).toHaveBeenLastCalledWith('a');
    app.handleInput('\u001B[A'); // ↑ onto the group header
    expect(onSelect).toHaveBeenLastCalledWith('group:working');
  });

  it('j/k type into the dispatch editor, even on an empty list — no navigation', () => {
    const editor = makeDispatchEditor();
    const onSelect = vi.fn();
    const onDispatchFocusChange = vi.fn();
    const app = makeApp({
      groups,
      selectedId: 'a',
      onSelect,
      dispatchEditor: editor,
      onDispatchFocusChange,
    });
    app.handleInput('j');
    app.handleInput('k');
    expect(onSelect).not.toHaveBeenCalled();
    expect(editor.getText()).toBe('jk');
    expect(onDispatchFocusChange).toHaveBeenCalledWith(true);
  });

  it('Kitty CSI-u encoded j/k also type into the dispatch editor', () => {
    const editor = makeDispatchEditor();
    const onSelect = vi.fn();
    const app = makeApp({ groups, selectedId: 'a', onSelect, dispatchEditor: editor });
    app.handleInput('[106u'); // j
    app.handleInput('[107u'); // k
    expect(onSelect).not.toHaveBeenCalled();
    expect(editor.getText()).toBe('jk');
  });

  it('steps over the spacer between groups instead of stopping on it', () => {
    const onSelect = vi.fn();
    const spacedGroups = [group('working', [row('a', { busy: true })]), group('completed', [row('b')])];
    const app = makeApp({ groups: spacedGroups, selectedId: 'a', onSelect });
    // Items: header:working, row:a, spacer:completed, header:completed, row:b.
    // Down from row a must land on the next group's header, not the spacer.
    app.handleInput('\u001B[B');
    expect(onSelect).toHaveBeenLastCalledWith('group:completed');
    // Up back must land on row a again, not the spacer.
    app.handleInput('\u001B[A');
    expect(onSelect).toHaveBeenLastCalledWith('a');
  });

  it('keeps selection across setProps when the id still exists', () => {
    const app = makeApp({ groups, selectedId: 'b' });
    app.setProps(makeProps({ groups, selectedId: 'b' }));
    const onSelect = vi.fn();
    app.setProps(makeProps({ groups, selectedId: 'b', onSelect }));
    app.handleInput('\u001B[A');
    expect(onSelect).toHaveBeenLastCalledWith('a');
  });
});

describe('AgentsViewApp — open', () => {
  it('Enter on a session row invokes onOpen with the row id', () => {
    const onOpen = vi.fn();
    const app = makeApp({ groups: [group('working', [row('s1', { busy: true })])], selectedId: 's1', onOpen });
    app.handleInput('\r');
    expect(onOpen).toHaveBeenCalledWith('s1');
  });

  it('Enter on a group header invokes onOpen with the group id', () => {
    const onOpen = vi.fn();
    const app = makeApp({
      groups: [group('working', [row('s1', { busy: true })])],
      selectedId: 'group:working',
      onOpen,
    });
    app.handleInput('\r');
    expect(onOpen).toHaveBeenCalledWith('group:working');
  });

  it('Enter on the more row invokes onOpen with more:completed', () => {
    const onOpen = vi.fn();
    const completedRows = Array.from({ length: 10 }, (_, i) => row(`done-${String(i)}`));
    const app = makeApp({
      groups: [group('completed', completedRows)],
      counts: { awaiting: 0, working: 0, completed: 11 },
      selectedId: 'more:completed',
      onOpen,
    });
    app.handleInput('\r');
    expect(onOpen).toHaveBeenCalledWith('more:completed');
  });
});

describe('AgentsViewApp — arrow keys open the selected session', () => {
  it('→ on a session row invokes onOpen — same effect as Enter', () => {
    const onOpen = vi.fn();
    const app = makeApp({
      groups: [group('working', [row('s1', { busy: true })])],
      selectedId: 's1',
      onOpen,
    });
    app.handleInput('\u001B[C');
    expect(onOpen).toHaveBeenCalledWith('s1');
  });

  it('→ expands a collapsed group header, ← collapses an expanded one', () => {
    const onOpen = vi.fn();
    const collapsed = makeApp({
      groups: [group('completed', [])],
      selectedId: 'group:completed',
      onOpen,
    });
    collapsed.handleInput('\u001B[C');
    expect(onOpen).toHaveBeenCalledWith('group:completed');

    onOpen.mockClear();
    const expanded = makeApp({
      groups: [group('completed', [row('s1')])],
      selectedId: 'group:completed',
      onOpen,
    });
    expanded.handleInput('\u001B[D');
    expect(onOpen).toHaveBeenCalledWith('group:completed');
  });

  it('← on a plain row is a no-op (nothing to collapse)', () => {
    const onOpen = vi.fn();
    const app = makeApp({
      groups: [group('working', [row('s1', { busy: true })])],
      selectedId: 's1',
      onOpen,
    });
    app.handleInput('\u001B[D');
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('AgentsViewApp — delete confirmation', () => {
  const busyGroups = [group('working', [row('s1', { busy: true, title: 'train model' })])];
  const idleGroups = [group('completed', [row('s2', { title: 'old task' })])];

  it('first Ctrl+X invokes onDeleteRequest on the selected row', () => {
    const onDeleteRequest = vi.fn();
    const app = makeApp({ groups: busyGroups, selectedId: 's1', onDeleteRequest });
    app.handleInput('\u0018');
    expect(onDeleteRequest).toHaveBeenCalledWith('s1');
  });

  it('confirm copy for a busy session warns the turn will be cancelled first', () => {
    const out = render(makeApp({ groups: busyGroups, selectedId: 's1', confirmDeleteId: 's1' }));
    expect(out).toContain('train model');
    expect(out).toContain('cancelled first');
  });

  it('confirm copy for an idle session has no cancel warning', () => {
    const out = render(makeApp({ groups: idleGroups, selectedId: 's2', confirmDeleteId: 's2' }));
    expect(out).toContain('old task');
    expect(out).not.toContain('cancelled first');
  });

  it('second Ctrl+X invokes onDeleteConfirm with the pending target', () => {
    const onDeleteConfirm = vi.fn();
    const app = makeApp({ groups: busyGroups, selectedId: 's1', confirmDeleteId: 's1', onDeleteConfirm });
    app.handleInput('\u0018');
    expect(onDeleteConfirm).toHaveBeenCalledWith('s1');
  });
});

describe('AgentsViewApp — rename', () => {
  const groups = [group('completed', [row('s1', { title: 'abc' })])];

  it('Ctrl+R invokes onRenameBegin on the selected row', () => {
    const onRenameBegin = vi.fn();
    const app = makeApp({ groups, selectedId: 's1', onRenameBegin });
    app.handleInput('\u0012');
    expect(onRenameBegin).toHaveBeenCalledWith('s1');
  });

  it('typed characters extend the draft and Enter submits it', () => {
    const onRenameSubmit = vi.fn();
    const app = makeApp({ groups, selectedId: 's1', onRenameSubmit });
    app.handleInput('\u0012'); // begin, draft = 'abc'
    app.handleInput('d');
    expect(render(app)).toContain('abcd');
    app.handleInput('\r');
    expect(onRenameSubmit).toHaveBeenCalledWith('s1', 'abcd');
  });

  it('backspace shrinks the draft', () => {
    const onRenameSubmit = vi.fn();
    const app = makeApp({ groups, selectedId: 's1', onRenameSubmit });
    app.handleInput('\u0012');
    app.handleInput('\u007F'); // delete 'c'
    app.handleInput('\r');
    expect(onRenameSubmit).toHaveBeenCalledWith('s1', 'ab');
  });

  it('Esc cancels by submitting the original title', () => {
    const onRenameSubmit = vi.fn();
    const app = makeApp({ groups, selectedId: 's1', onRenameSubmit });
    app.handleInput('\u0012');
    app.handleInput('z');
    app.handleInput('\u001B');
    expect(onRenameSubmit).toHaveBeenCalledWith('s1', 'abc');
  });

  it('renders a controller-driven rename draft from props', () => {
    const out = render(makeApp({ groups, selectedId: 's1', renameDraft: { sessionId: 's1', text: 'draft text' } }));
    expect(out).toContain('draft text');
  });

  it('the rename-draft row also carries the selection background fill — rename can only start on the selected row, so it always applies (fix round 1)', () => {
    const previousChalkLevel = chalk.level;
    chalk.level = 3;
    try {
      const bgOpen = chalk.bgHex(darkColors.surfaceSelected)('x').split('x')[0];
      const out = renderRaw(
        makeApp({ groups, selectedId: 's1', renameDraft: { sessionId: 's1', text: 'draft text' } }),
      );
      const line = out.split('\n').find((l) => l.includes('draft text'));
      expect(line).toContain(bgOpen);
    } finally {
      chalk.level = previousChalkLevel;
    }
  });
});

describe('AgentsViewApp — pin / help / quit', () => {
  it('Ctrl+T invokes onPinToggle on the selected row', () => {
    const onPinToggle = vi.fn();
    const app = makeApp({ groups: [group('completed', [row('s1')])], selectedId: 's1', onPinToggle });
    app.handleInput('\u0014');
    expect(onPinToggle).toHaveBeenCalledWith('s1');
  });

  it('? replaces the footer with the 2-row grid — the roster list stays visible underneath', () => {
    const onHelpToggle = vi.fn();
    const groups = [group('completed', [row('s1')])];
    const app = makeApp({ groups, onHelpToggle });
    expect(render(app)).toContain('s1 title');

    app.handleInput('?');
    expect(onHelpToggle).toHaveBeenCalledTimes(1);
    const opened = render(app);
    expect(opened).toContain('s1 title'); // the list never gets swapped out
    expect(opened).toContain('? to close');
    expect(opened).toContain('ctrl+r to rename');
    expect(opened).toContain('ctrl+j for newline');
    // gap 10 + 12: the previously-missing keys now have grid copy.
    expect(opened).toContain('shift+↑↓ to reorder');
    expect(opened).toContain('alt+1-9 to open');
    expect(opened).toContain('space to reply');
    expect(opened).toContain('@ to mention');
    // ctrl+s (switch views) is deliberately absent — no second view mode
    // exists to switch to, and the brief bans inventing one.
    expect(opened).not.toContain('ctrl+s');

    app.handleInput('?');
    expect(onHelpToggle).toHaveBeenCalledTimes(2);
    expect(render(app)).not.toContain('? to close');
  });

  it("the ? grid shrinks the list's visible window by exactly one row", () => {
    const completedRows = Array.from({ length: 10 }, (_, i) => row(`done-${String(i)}`));
    const app = new AgentsViewApp(
      makeProps({
        groups: [group('completed', completedRows)],
        counts: { awaiting: 0, working: 0, completed: 10 },
      }),
      fakeTerminal(15, 120),
    );
    const before = strip(app.render(120).join('\n'));
    expect(before).toContain('done-5 title');
    app.handleInput('?');
    const after = strip(app.render(120).join('\n'));
    expect(after).not.toContain('done-5 title');
    expect(after).toContain('done-4 title');
  });

  it('Esc closes the ? grid without quitting', () => {
    const onQuit = vi.fn();
    const app = makeApp({ onQuit });
    app.handleInput('?');
    app.handleInput('\u001B');
    expect(onQuit).not.toHaveBeenCalled();
    expect(render(app)).not.toContain('? to close');
  });

  it('Esc quits from the plain list', () => {
    const onQuit = vi.fn();
    makeApp({ onQuit }).handleInput('\u001B');
    expect(onQuit).toHaveBeenCalledTimes(1);
  });

  // ── R9 Q3: Esc closes the innermost overlay, otherwise quits — no origin-return ──

  it('Esc quits even when an origin is set — no origin-return (R9 Q3)', () => {
    const onQuit = vi.fn();
    const onOpen = vi.fn();
    const app = makeApp({ onQuit, onOpen, originId: 'ses-origin' });
    app.handleInput(ESC);
    expect(onQuit).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('a delete confirm still absorbs Esc as a cancel first, even with an origin set', () => {
    // The confirm is itself the innermost thing to dismiss — it must not be
    // skipped just because there's an origin to fall back to.
    const onQuit = vi.fn();
    const onOpen = vi.fn();
    const app = makeApp({
      groups: [group('completed', [row('s1')])],
      confirmDeleteId: 's1',
      onQuit,
      onOpen,
      originId: 'ses-origin',
    });
    app.handleInput(ESC);
    expect(onQuit).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('Esc while the ? grid is open just closes the grid, even with an origin set — no return, no quit', () => {
    const onQuit = vi.fn();
    const onOpen = vi.fn();
    const app = makeApp({ onQuit, onOpen, originId: 'ses-origin' });
    app.handleInput('?');
    app.handleInput(ESC);
    expect(onQuit).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(render(app)).not.toContain('? to close');
  });

  it("Esc in reply mode is the composer's own escape, not the origin-return/quit branch", () => {
    const onQuit = vi.fn();
    const onOpen = vi.fn();
    const app = makeApp({
      dispatchEditor: makeDispatchEditor(),
      dispatchFocused: true,
      replyTargetId: 's1',
      onQuit,
      onOpen,
      originId: 'ses-origin',
    });
    app.handleInput(ESC);
    expect(onQuit).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('q types into the dispatch editor on an empty list — no quit', () => {
    const editor = makeDispatchEditor();
    const onQuit = vi.fn();
    const onDispatchFocusChange = vi.fn();
    const app = makeApp({ dispatchEditor: editor, onQuit, onDispatchFocusChange });
    app.handleInput('q');
    expect(onQuit).not.toHaveBeenCalled();
    expect(editor.getText()).toBe('q');
    expect(onDispatchFocusChange).toHaveBeenCalledWith(true);
  });

  it('Kitty CSI-u encoded q also types into the dispatch editor', () => {
    const editor = makeDispatchEditor();
    const onQuit = vi.fn();
    const app = makeApp({ dispatchEditor: editor, onQuit });
    app.handleInput('[113u');
    expect(onQuit).not.toHaveBeenCalled();
    expect(editor.getText()).toBe('q');
  });
});

describe('AgentsViewApp — Ctrl+C reports to the controller (R4 parity, fix round 1)', () => {
  // The two-stage arm/timeout/auto-disarm state machine now lives in the
  // controller, not here — only it has `state.ui.requestRender()` to repaint
  // on a silent timeout (see agents-view-controller.test.ts's "Ctrl+C
  // two-stage exit confirm" block for that coverage). This component just
  // forwards every press via `onCtrlC` and renders whatever
  // `pendingExitArmed` it's handed — no arm/quit decision, no timer, here.

  it('every Ctrl+C press reports to onCtrlC unconditionally — no local arm/quit decision', () => {
    const onCtrlC = vi.fn();
    const onQuit = vi.fn();
    const app = makeApp({ onCtrlC, onQuit });
    app.handleInput(CTRL_C);
    app.handleInput(CTRL_C);
    expect(onCtrlC).toHaveBeenCalledTimes(2);
    expect(onQuit).not.toHaveBeenCalled();
  });

  it('renders the armed footer hint with the running-agent count when pendingExitArmed is true', () => {
    const app = makeApp({ pendingExitArmed: true, counts: { awaiting: 0, working: 3, completed: 0 } });
    const out = render(app);
    expect(out).toContain('Press Ctrl+C again to exit');
    expect(out).toContain('3 agents will keep running');
  });

  it('omits the running-agent suffix when nothing is working', () => {
    const app = makeApp({ pendingExitArmed: true, counts: { awaiting: 0, working: 0, completed: 0 } });
    const out = render(app);
    expect(out).toContain('Press Ctrl+C again to exit');
    expect(out).not.toContain('will keep running');
  });

  it('uses singular phrasing for exactly one working agent', () => {
    const app = makeApp({ pendingExitArmed: true, counts: { awaiting: 0, working: 1, completed: 0 } });
    const out = render(app);
    expect(out).toContain('1 agent will keep running');
    expect(out).not.toContain('1 agents');
  });

  it('shows no hint at all when pendingExitArmed is false', () => {
    const app = makeApp({ pendingExitArmed: false, counts: { awaiting: 0, working: 3, completed: 0 } });
    expect(render(app)).not.toContain('Press Ctrl+C again to exit');
  });
});

describe('AgentsViewApp — dispatch editor mount', () => {
  it('a printable char on an empty editor routes to the editor and requests focus', () => {
    const editor = makeDispatchEditor();
    const onDispatchFocusChange = vi.fn();
    const app = makeApp({ dispatchEditor: editor, onDispatchFocusChange });
    app.handleInput('d');
    expect(editor.getText()).toBe('d');
    expect(onDispatchFocusChange).toHaveBeenCalledWith(true);
  });

  it('j/k/space/q route to the editor once it holds text (no navigation/quit/reply)', () => {
    const editor = makeDispatchEditor();
    editor.setText('fix');
    const onSelect = vi.fn();
    const onQuit = vi.fn();
    const onReplyRequest = vi.fn();
    const onDispatchFocusChange = vi.fn();
    const app = makeApp({
      groups: [group('working', [row('a', { busy: true }), row('b', { busy: true })])],
      selectedId: 'a',
      dispatchEditor: editor,
      onSelect,
      onQuit,
      onReplyRequest,
      onDispatchFocusChange,
    });
    app.handleInput('j');
    app.handleInput('k');
    expect(onSelect).not.toHaveBeenCalled();
    expect(editor.getText()).toBe('fixjk');
    app.handleInput(' ');
    expect(editor.getText()).toBe('fixjk ');
    expect(onReplyRequest).not.toHaveBeenCalled();
    app.handleInput('q');
    expect(onQuit).not.toHaveBeenCalled();
    expect(onDispatchFocusChange).toHaveBeenCalledWith(true);
  });

  it('a focused dispatch editor receives every key; Esc reaches the editor onEscape, never onQuit', () => {
    const editor = makeDispatchEditor();
    editor.setText('do stuff');
    const onEscape = vi.fn();
    editor.onEscape = onEscape;
    const onQuit = vi.fn();
    const onDispatchFocusChange = vi.fn();
    const app = makeApp({
      dispatchEditor: editor,
      dispatchFocused: true,
      onQuit,
      onDispatchFocusChange,
    });
    app.handleInput('x');
    expect(editor.getText()).toBe('do stuffx');
    app.handleInput('\u001B');
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(onQuit).not.toHaveBeenCalled();
  });

  it('the footer shows dispatch hints while the editor is focused', () => {
    const out = render(makeApp({ dispatchFocused: true }));
    expect(out).toContain('dispatch');
    expect(out).toContain('back to list');
  });

  it('the footer shows send/cancel while reply mode is focused, not dispatch/back-to-list', () => {
    const out = render(makeApp({ dispatchFocused: true, replyTargetId: 's1' }));
    expect(out).toContain('enter to send');
    expect(out).toContain('esc to cancel');
    // Narrower than a bare 'to dispatch' substring check: the empty-roster
    // banner ("type below to dispatch a new session") legitimately contains
    // that phrase too — only the footer's own hint text is under test here.
    expect(out).not.toContain('enter to dispatch');
    expect(out).not.toContain('back to list');
  });
});

// ── R3-4: space to reply, shift+↑↓ reorder, alt+1-9 quick-open (gap 10 + 12) ──

describe('AgentsViewApp — space to reply (gap 10)', () => {
  it('space on a selected session row fires onReplyRequest with the row id', () => {
    const onReplyRequest = vi.fn();
    const app = makeApp({
      groups: [group('working', [row('s1', { busy: true })])],
      selectedId: 's1',
      onReplyRequest,
    });
    app.handleInput(' ');
    expect(onReplyRequest).toHaveBeenCalledWith('s1');
  });

  it('space on a group header is a no-op for reply — falls through and types into the composer', () => {
    const editor = makeDispatchEditor();
    const onReplyRequest = vi.fn();
    const onDispatchFocusChange = vi.fn();
    const app = makeApp({
      groups: [group('working', [row('s1', { busy: true })])],
      selectedId: 'group:working',
      dispatchEditor: editor,
      onReplyRequest,
      onDispatchFocusChange,
    });
    app.handleInput(' ');
    expect(onReplyRequest).not.toHaveBeenCalled();
    expect(editor.getText()).toBe(' ');
    expect(onDispatchFocusChange).toHaveBeenCalledWith(true);
  });

  it('Kitty CSI-u encoded space also fires onReplyRequest on a row', () => {
    const onReplyRequest = vi.fn();
    const app = makeApp({
      groups: [group('working', [row('s1', { busy: true })])],
      selectedId: 's1',
      onReplyRequest,
    });
    app.handleInput('[32u');
    expect(onReplyRequest).toHaveBeenCalledWith('s1');
  });
});

describe('AgentsViewApp — shift+↑↓ reorder pinned rows (gap 12)', () => {
  const pinnedGroups = [
    group('pinned', [row('p1', { pinned: true }), row('p2', { pinned: true })]),
  ];

  it('shift+↑ on a pinned row fires onReorderPinned with delta -1', () => {
    const onReorderPinned = vi.fn();
    const app = makeApp({ groups: pinnedGroups, selectedId: 'p2', onReorderPinned });
    app.handleInput('[a'); // shift+up
    expect(onReorderPinned).toHaveBeenCalledWith('p2', -1);
  });

  it('shift+↓ on a pinned row fires onReorderPinned with delta +1', () => {
    const onReorderPinned = vi.fn();
    const app = makeApp({ groups: pinnedGroups, selectedId: 'p1', onReorderPinned });
    app.handleInput('[b'); // shift+down
    expect(onReorderPinned).toHaveBeenCalledWith('p1', 1);
  });

  it('shift+↑↓ on a non-pinned row is a no-op — no reorder and no plain-arrow navigation either', () => {
    const onReorderPinned = vi.fn();
    const onSelect = vi.fn();
    const groups = [group('completed', [row('a'), row('b')])];
    const app = makeApp({ groups, selectedId: 'a', onReorderPinned, onSelect });
    app.handleInput('[a');
    app.handleInput('[b');
    expect(onReorderPinned).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shift+↑↓ on a group header is a no-op', () => {
    const onReorderPinned = vi.fn();
    const app = makeApp({ groups: pinnedGroups, selectedId: 'group:pinned', onReorderPinned });
    app.handleInput('[a');
    expect(onReorderPinned).not.toHaveBeenCalled();
  });
});

describe('AgentsViewApp — alt+1-9 quick-open (gap 12)', () => {
  const threeRowGroups = [
    group('working', [row('a', { busy: true }), row('b', { busy: true })]),
    group('completed', [row('c')]),
  ];

  it('alt+1 opens the first visible session row', () => {
    const onOpen = vi.fn();
    const app = makeApp({ groups: threeRowGroups, onOpen });
    app.handleInput('1'); // alt+1 (legacy ESC-prefixed)
    expect(onOpen).toHaveBeenCalledWith('a');
  });

  it('alt+3 opens the third row, counting across group headers/spacers', () => {
    const onOpen = vi.fn();
    const app = makeApp({ groups: threeRowGroups, onOpen });
    app.handleInput('3'); // alt+3
    expect(onOpen).toHaveBeenCalledWith('c');
  });

  it('alt+N beyond the row count is a no-op', () => {
    const onOpen = vi.fn();
    const app = makeApp({ groups: threeRowGroups, onOpen });
    app.handleInput('9'); // alt+9, only 3 rows exist
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('alt+1 is a global shortcut — fires regardless of the current selection', () => {
    const onOpen = vi.fn();
    const app = makeApp({ groups: threeRowGroups, selectedId: 'group:completed', onOpen });
    app.handleInput('1');
    expect(onOpen).toHaveBeenCalledWith('a');
  });

  it('no number badges are rendered on rows', () => {
    const out = render(makeApp({ groups: threeRowGroups }));
    // Row text is `<ptr><glyph> <name>...` — no leading digit/index prefix.
    expect(out).not.toMatch(/[▸ ]\s*[1-9][.)]/);
  });
});

// ── Shutdown-time exit confirmation (embedded server) ──

describe('AgentsExitConfirmComponent', () => {
  it('renders the interruption copy with the running count', () => {
    const component = new AgentsExitConfirmComponent({ running: 3, onResolve: () => {} });
    const out = component.render(100).map(strip).join('\n');
    expect(out).toContain(
      '3 session(s) still running — quitting interrupts them (saved; resumable).',
    );
    expect(out).toContain('Y quit');
    expect(out).toContain('N cancel');
  });

  it('y and Y confirm', () => {
    for (const key of ['y', 'Y']) {
      const onResolve = vi.fn();
      const component = new AgentsExitConfirmComponent({ running: 1, onResolve });
      component.handleInput(key);
      expect(onResolve).toHaveBeenCalledTimes(1);
      expect(onResolve).toHaveBeenCalledWith(true);
    }
  });

  it('any other key cancels — the safe default for a shutdown confirm is to stay', () => {
    for (const key of ['n', 'N', 'q', '\u001B', '\u0003', '\t']) {
      const onResolve = vi.fn();
      const component = new AgentsExitConfirmComponent({ running: 1, onResolve });
      component.handleInput(key);
      expect(onResolve).toHaveBeenCalledTimes(1);
      expect(onResolve).toHaveBeenCalledWith(false);
    }
  });

  it('auto-cancels on timeout — and a late key cannot clobber the timeout', () => {
    vi.useFakeTimers();
    try {
      const onResolve = vi.fn();
      const component = new AgentsExitConfirmComponent({ running: 1, onResolve });
      expect(onResolve).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      expect(onResolve).toHaveBeenCalledTimes(1);
      expect(onResolve).toHaveBeenCalledWith(false);
      component.handleInput('y');
      expect(onResolve).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves only once — the timeout cannot clobber a key answer', () => {
    vi.useFakeTimers();
    try {
      const onResolve = vi.fn();
      const component = new AgentsExitConfirmComponent({ running: 1, onResolve });
      component.handleInput('y');
      vi.advanceTimersByTime(60_000);
      component.handleInput('n');
      expect(onResolve).toHaveBeenCalledTimes(1);
      expect(onResolve).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
