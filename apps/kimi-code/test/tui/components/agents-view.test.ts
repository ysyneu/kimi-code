import type { Terminal } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import type { AgentsGroup, AgentsGroupId, AgentsRosterRow } from '@/tui/agents/roster';
import { AgentsViewApp, type AgentsViewProps } from '@/tui/components/agents-view/app';

const ANSI_SGR = /\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

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
  awaiting: 'Awaiting input',
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
    ...overrides,
  };
}

function group(id: AgentsGroupId, rows: readonly AgentsRosterRow[]): AgentsGroup {
  return { id, label: GROUP_LABELS[id], rows };
}

function makeProps(overrides: Partial<AgentsViewProps> = {}): AgentsViewProps {
  return {
    groups: [],
    counts: { awaiting: 0, working: 0, completed: 0 },
    selectedId: undefined,
    serverLabel: 'embedded',
    peek: undefined,
    confirmDeleteId: undefined,
    renameDraft: undefined,
    flashMessage: undefined,
    dispatchFocused: false,
    onSelect: vi.fn(),
    onOpen: vi.fn(),
    onPeekToggle: vi.fn(),
    onDeleteRequest: vi.fn(),
    onDeleteConfirm: vi.fn(),
    onRenameBegin: vi.fn(),
    onRenameSubmit: vi.fn(),
    onPinToggle: vi.fn(),
    onHelpToggle: vi.fn(),
    onQuit: vi.fn(),
    ...overrides,
  };
}

function makeApp(props: Partial<AgentsViewProps> = {}, rows = 30, columns = 120): AgentsViewApp {
  return new AgentsViewApp(makeProps(props), fakeTerminal(rows, columns));
}

function render(app: AgentsViewApp, width = 120): string {
  return strip(app.render(width).join('\n'));
}

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

  it('shows the header with server label and the summary counts', () => {
    const out = render(
      makeApp({ counts: { awaiting: 1, working: 2, completed: 5 }, serverLabel: '127.0.0.1:58627' }),
    );
    expect(out).toContain('KIMI AGENTS');
    expect(out).toContain('127.0.0.1:58627');
    expect(out).toContain('1 awaiting input');
    expect(out).toContain('2 working');
    expect(out).toContain('5 completed');
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
    const awaitingHeader = out.indexOf('Awaiting input');
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

  it('renders the awaiting marker, cwd basename and untrusted badge on rows', () => {
    const out = render(
      makeApp({
        groups: [
          group('awaiting', [
            row('s1', { pendingInteraction: 'question', trusted: false, workDir: '/tmp/secretproj' }),
          ]),
        ],
      }),
    );
    expect(out).toContain('!');
    expect(out).toContain('secretproj');
    expect(out).toContain('untrusted');
  });

  it('shows the empty-state copy when there are no groups', () => {
    const out = render(makeApp());
    expect(out).toContain('No sessions');
  });

  it('renders a dispatch placeholder line above the footer', () => {
    const out = render(makeApp());
    expect(out).toContain('describe a task');
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

  it('renders freshly derived rows after setProps (no stale row cache)', () => {
    const app = makeApp({ groups: [group('completed', [row('s1', { title: 'old title' })])] });
    app.setProps(makeProps({ groups: [group('completed', [row('s1', { title: 'new title' })])] }));
    const out = render(app);
    expect(out).toContain('new title');
    expect(out).not.toContain('old title');
  });

  it('renders flash messages in the footer', () => {
    const out = render(makeApp({ flashMessage: 'Attach lands in M4' }));
    expect(out).toContain('Attach lands in M4');
  });
});

describe('AgentsViewApp — footer hints follow the selection target', () => {
  const completedRows = Array.from({ length: 10 }, (_, i) => row(`done-${String(i)}`));
  const groups = [
    group('working', [row('work-1', { busy: true })]),
    group('completed', completedRows),
  ];
  const counts = { awaiting: 0, working: 1, completed: 11 };

  it('session row footer mentions peek/rename/pin', () => {
    const out = render(makeApp({ groups, counts, selectedId: 'work-1' }));
    expect(out).toContain('peek');
    expect(out).toContain('rename');
    expect(out).toContain('pin');
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

  it('j/k always navigate (dispatch editor lands in Task 4)', () => {
    const onSelect = vi.fn();
    const app = makeApp({ groups, selectedId: 'a', onSelect });
    app.handleInput('j');
    expect(onSelect).toHaveBeenLastCalledWith('b');
    app.handleInput('k');
    expect(onSelect).toHaveBeenLastCalledWith('a');
  });

  it('Kitty CSI-u encoded j/k navigate', () => {
    const onSelect = vi.fn();
    const app = makeApp({ groups, selectedId: 'a', onSelect });
    app.handleInput('[106u'); // j
    expect(onSelect).toHaveBeenLastCalledWith('b');
    app.handleInput('[107u'); // k
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

describe('AgentsViewApp — open / peek', () => {
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

  it('Space on a session row invokes onPeekToggle', () => {
    const onPeekToggle = vi.fn();
    const app = makeApp({
      groups: [group('working', [row('s1', { busy: true })])],
      selectedId: 's1',
      onPeekToggle,
    });
    app.handleInput(' ');
    expect(onPeekToggle).toHaveBeenCalledWith('s1');
  });

  it('peek open renders the tail lines and the reply draft', () => {
    const out = render(
      makeApp({
        groups: [group('working', [row('s1', { busy: true })])],
        selectedId: 's1',
        peek: { sessionId: 's1', lines: ['first line', 'latest output'], replyDraft: 'hel' },
      }),
    );
    expect(out).toContain('first line');
    expect(out).toContain('latest output');
    expect(out).toContain('hel');
  });

  it('Esc closes an open peek before quitting', () => {
    const onPeekToggle = vi.fn();
    const onQuit = vi.fn();
    const app = makeApp({
      groups: [group('working', [row('s1', { busy: true })])],
      selectedId: 's1',
      peek: { sessionId: 's1', lines: ['x'], replyDraft: '' },
      onPeekToggle,
      onQuit,
    });
    app.handleInput('\u001B');
    expect(onPeekToggle).toHaveBeenCalledWith('s1');
    expect(onQuit).not.toHaveBeenCalled();
  });

  it('q does not quit while a peek is open (reply text seam)', () => {
    const onQuit = vi.fn();
    const app = makeApp({
      groups: [group('working', [row('s1', { busy: true })])],
      selectedId: 's1',
      peek: { sessionId: 's1', lines: ['x'], replyDraft: '' },
      onQuit,
    });
    app.handleInput('q');
    expect(onQuit).not.toHaveBeenCalled();
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
});

describe('AgentsViewApp — pin / help / quit', () => {
  it('Ctrl+T invokes onPinToggle on the selected row', () => {
    const onPinToggle = vi.fn();
    const app = makeApp({ groups: [group('completed', [row('s1')])], selectedId: 's1', onPinToggle });
    app.handleInput('\u0014');
    expect(onPinToggle).toHaveBeenCalledWith('s1');
  });

  it('? toggles the shortcuts page and fires onHelpToggle', () => {
    const onHelpToggle = vi.fn();
    const app = makeApp({ onHelpToggle });
    app.handleInput('?');
    expect(onHelpToggle).toHaveBeenCalledTimes(1);
    expect(render(app)).toContain('Shortcuts');
    app.handleInput('?');
    expect(onHelpToggle).toHaveBeenCalledTimes(2);
    expect(render(app)).not.toContain('Shortcuts');
  });

  it('Esc closes the help page without quitting', () => {
    const onQuit = vi.fn();
    const app = makeApp({ onQuit });
    app.handleInput('?');
    app.handleInput('\u001B');
    expect(onQuit).not.toHaveBeenCalled();
    expect(render(app)).not.toContain('Shortcuts');
  });

  it('Esc quits from the plain list', () => {
    const onQuit = vi.fn();
    makeApp({ onQuit }).handleInput('\u001B');
    expect(onQuit).toHaveBeenCalledTimes(1);
  });

  it('q quits from the plain list', () => {
    const onQuit = vi.fn();
    makeApp({ onQuit }).handleInput('q');
    expect(onQuit).toHaveBeenCalledTimes(1);
  });

  it('Kitty CSI-u encoded q quits', () => {
    const onQuit = vi.fn();
    makeApp({ onQuit }).handleInput('[113u');
    expect(onQuit).toHaveBeenCalledTimes(1);
  });
});
