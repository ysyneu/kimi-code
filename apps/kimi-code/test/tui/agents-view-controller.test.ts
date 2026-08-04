import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Event, KimiHarness, Session, SessionSummary } from '@moonshot-ai/kimi-code-sdk';
import type { Component, ProcessTerminal, Terminal, TUI } from '@moonshot-ai/pi-tui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadPins } from '@/tui/agents/roster-persistence';
import type { AgentsViewApp } from '@/tui/components/agents-view/app';
import type { CustomEditor } from '@/tui/components/editor/custom-editor';
import {
  AgentsViewController,
  type AgentsViewHost,
  type AgentsViewState,
} from '@/tui/controllers/agents-view';
import { currentTheme } from '@/tui/theme';

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

interface FakeUI {
  children: unknown[];
  clear(): void;
  addChild(child: unknown): void;
  setFocus: ReturnType<typeof vi.fn>;
  requestRender: ReturnType<typeof vi.fn>;
}

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    title: `${id} title`,
    workDir: '/home/user/project',
    sessionDir: `/tmp/${id}`,
    createdAt: 1,
    updatedAt: 1_000,
    ...overrides,
  };
}

interface FakeHarness {
  harness: KimiHarness;
  listSessions: ReturnType<typeof vi.fn>;
  resumeSession: ReturnType<typeof vi.fn>;
  deleteSession: ReturnType<typeof vi.fn>;
  renameSession: ReturnType<typeof vi.fn>;
  session: { getContext: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  emit(event: unknown): void;
}

function makeHarness(homeDir: string, summaries: readonly SessionSummary[]): FakeHarness {
  const listeners = new Set<(event: Event) => void>();
  const session = {
    getContext: vi.fn(async () => ({ history: [], tokenCount: 0 })),
    steer: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const listSessions = vi.fn(async () => summaries);
  const resumeSession = vi.fn(async () => session as unknown as Session);
  const deleteSession = vi.fn(async () => {});
  const renameSession = vi.fn(async () => {});
  const harness = {
    homeDir,
    listSessions,
    resumeSession,
    deleteSession,
    renameSession,
    onEvent: (listener: (event: Event) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as KimiHarness;
  return {
    harness,
    listSessions,
    resumeSession,
    deleteSession,
    renameSession,
    session,
    emit: (event: unknown) => {
      for (const listener of listeners) listener(event as Event);
    },
  };
}

interface Boot {
  homeDir: string;
  fake: FakeHarness;
  host: AgentsViewHost;
  controller: AgentsViewController;
  ui: FakeUI;
  showError: ReturnType<typeof vi.fn>;
  showStatus: ReturnType<typeof vi.fn>;
  view(): AgentsViewState;
  component(): AgentsViewApp;
  render(): string;
}

const SENTINEL_A = { tag: 'sentinel-a' } as unknown as Component;
const SENTINEL_B = { tag: 'sentinel-b' } as unknown as Component;

async function boot(
  summaries: readonly SessionSummary[],
  opts: { onOpenSession?: (id: string) => void } = {},
): Promise<Boot> {
  const homeDir = await mkdtemp(join(tmpdir(), 'agents-view-controller-'));
  const fake = makeHarness(homeDir, summaries);
  const ui: FakeUI = {
    children: [SENTINEL_A, SENTINEL_B],
    clear() {
      this.children.length = 0;
    },
    addChild(child: unknown) {
      this.children.push(child);
    },
    setFocus: vi.fn(),
    requestRender: vi.fn(),
  };
  const state = {
    agentsView: undefined as AgentsViewState | undefined,
    theme: currentTheme,
    terminal: fakeTerminal(30) as unknown as ProcessTerminal,
    ui: ui as unknown as TUI,
    editor: { tag: 'editor' } as unknown as CustomEditor,
  };
  const showError = vi.fn();
  const showStatus = vi.fn();
  const host: AgentsViewHost = {
    state,
    harness: fake.harness,
    showError,
    showStatus,
    setAgentsView: (value) => {
      state.agentsView = value;
    },
    agentsViewServerLabel: () => 'test-server',
    onOpenSession: opts.onOpenSession,
  };
  const controller = new AgentsViewController(host);
  await controller.show();
  return {
    homeDir,
    fake,
    host,
    controller,
    ui,
    showError,
    showStatus,
    view: () => {
      const view = state.agentsView;
      if (view === undefined) throw new Error('agents view is not mounted');
      return view;
    },
    component: () => {
      const view = state.agentsView;
      if (view === undefined) throw new Error('agents view is not mounted');
      return view.component;
    },
    render: () => strip(state.agentsView?.component.render(120).join('\n') ?? ''),
  };
}

/** Flush the microtask queue so fire-and-forget controller actions settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** savePins does real fs I/O (mkdir + write + rename), which needs several
 *  event-loop turns — poll the file instead of guessing a delay. */
async function waitForPins(homeDir: string, expected: Set<string>): Promise<void> {
  await vi.waitFor(async () => {
    expect(await loadPins(homeDir)).toEqual(expected);
  });
}

const ESC = '\u001B';
const CTRL_X = '\u0018';
const CTRL_R = '\u0012';
const CTRL_T = '\u0014';
const DOWN = '\u001B[B';
const ENTER = '\r';

describe('AgentsViewController — mount / unmount', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('show mounts the component as the sole child and focuses it', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    expect(b.controller.isOpen).toBe(true);
    expect(b.ui.children).toEqual([b.component()]);
    expect(b.ui.setFocus).toHaveBeenCalledWith(b.component());
    expect(b.ui.requestRender).toHaveBeenCalledWith(true);
  });

  it('show renders the listSessions rows', async () => {
    const b = await boot([summary('s1'), summary('s2')]);
    dir = b.homeDir;
    const out = b.render();
    expect(out).toContain('s1 title');
    expect(out).toContain('s2 title');
    expect(out).toContain('test-server');
  });

  it('show failure reports the error and does not mount', async () => {
    const b = await boot([]);
    dir = b.homeDir;
    b.fake.listSessions.mockRejectedValueOnce(new Error('server down'));
    b.controller.close();
    await b.controller.show();
    expect(b.controller.isOpen).toBe(false);
    expect(b.ui.children).toEqual([SENTINEL_A, SENTINEL_B]);
    expect(b.showError).toHaveBeenCalledWith(expect.stringContaining('server down'));
  });

  it('a second show while open is a no-op', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    await b.controller.show();
    expect(b.fake.listSessions).toHaveBeenCalledTimes(1);
  });

  it('Esc unmounts, restores the saved children and refocuses the editor', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(ESC);
    expect(b.controller.isOpen).toBe(false);
    expect(b.ui.children).toEqual([SENTINEL_A, SENTINEL_B]);
    expect(b.ui.setFocus).toHaveBeenLastCalledWith(b.host.state.editor);
  });

  it('close unsubscribes the global event feed', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.controller.close();
    b.ui.requestRender.mockClear();
    b.fake.emit({ type: 'event.session.work_changed', sessionId: 's1', busy: true });
    expect(b.ui.requestRender).not.toHaveBeenCalled();
  });
});

describe('AgentsViewController — live roster events', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('work_changed moves the row into the Working group', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    expect(b.render()).toContain('Completed');
    b.fake.emit({ type: 'event.session.work_changed', sessionId: 's1', busy: true, pending_interaction: 'none' });
    const out = b.render();
    expect(out).toContain('Working');
    expect(out).toContain('1 working');
  });

  it('meta.updated renames the row', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.fake.emit({ type: 'session.meta.updated', sessionId: 's1', title: 'renamed by server' });
    expect(b.render()).toContain('renamed by server');
  });

  it('session.created inserts a new row', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.fake.emit({
      type: 'event.session.created',
      session: {
        id: 's9',
        title: 'fresh session',
        last_prompt: 'do things',
        metadata: { cwd: '/home/user/fresh' },
        updated_at: new Date().toISOString(),
        busy: false,
        pending_interaction: 'none',
      },
    });
    expect(b.render()).toContain('fresh session');
  });

  it('ignores non-global events', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.ui.requestRender.mockClear();
    b.fake.emit({ type: 'turn.started', sessionId: 's1' });
    expect(b.ui.requestRender).not.toHaveBeenCalled();
  });
});

describe('AgentsViewController — delete', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('Ctrl+X twice archives the session and removes the row', async () => {
    const b = await boot([summary('s1'), summary('s2')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN); // onto row s1
    b.component().handleInput(CTRL_X);
    expect(b.view().confirmDeleteId).toBe('s1');
    expect(b.render()).toContain('Archive session "s1 title"?');
    b.component().handleInput(CTRL_X);
    await flush();
    expect(b.fake.deleteSession).toHaveBeenCalledWith('s1');
    expect(b.view().confirmDeleteId).toBeUndefined();
    expect(b.render()).not.toContain('s1 title');
    expect(b.render()).toContain('s2 title');
  });

  it('Esc during delete-confirm cancels the confirm instead of quitting', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(CTRL_X);
    expect(b.view().confirmDeleteId).toBe('s1');
    b.component().handleInput(ESC);
    expect(b.controller.isOpen).toBe(true);
    expect(b.view().confirmDeleteId).toBeUndefined();
    expect(b.render()).not.toContain('Archive session');
    expect(b.fake.deleteSession).not.toHaveBeenCalled();
  });

  it('any other action clears a pending delete confirm', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(CTRL_X);
    expect(b.view().confirmDeleteId).toBe('s1');
    b.component().handleInput(CTRL_T); // pin instead
    await flush();
    expect(b.view().confirmDeleteId).toBeUndefined();
    expect(b.fake.deleteSession).not.toHaveBeenCalled();
    await waitForPins(b.homeDir, new Set(['s1']));
  });

  it('Ctrl+X on a group header archives every row in the group', async () => {
    const b = await boot([summary('s1'), summary('s2')]);
    dir = b.homeDir;
    // selection starts on the Completed group header
    b.component().handleInput(CTRL_X);
    expect(b.view().confirmDeleteId).toBe('group:completed');
    expect(b.render()).toContain('Archive all sessions in "Completed"?');
    b.component().handleInput(CTRL_X);
    await flush();
    expect(b.fake.deleteSession).toHaveBeenCalledWith('s1');
    expect(b.fake.deleteSession).toHaveBeenCalledWith('s2');
  });
});

describe('AgentsViewController — pin', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('Ctrl+T pins the row and persists the pins file', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(CTRL_T);
    await waitForPins(b.homeDir, new Set(['s1']));
    expect(b.render()).toContain('Pinned');
  });

  it('Ctrl+T on a pinned row unpins and persists', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(CTRL_T);
    await waitForPins(b.homeDir, new Set(['s1']));
    b.component().handleInput(CTRL_T);
    await waitForPins(b.homeDir, new Set());
    expect(b.render()).not.toContain('Pinned');
  });
});

describe('AgentsViewController — rename', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('Ctrl+R + edit + Enter renames the session via the SDK', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(CTRL_R);
    b.component().handleInput('X');
    b.component().handleInput(ENTER);
    await flush();
    expect(b.fake.renameSession).toHaveBeenCalledWith({ id: 's1', title: 's1 titleX' });
    expect(b.view().renameDraft).toBeUndefined();
    expect(b.render()).toContain('s1 titleX');
  });

  it('Esc-cancel submits the original title and skips the SDK call', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(CTRL_R);
    b.component().handleInput('X');
    b.component().handleInput(ESC);
    await flush();
    expect(b.fake.renameSession).not.toHaveBeenCalled();
    expect(b.view().renameDraft).toBeUndefined();
  });

  it('a failed rename rolls the row title back and reports the error', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.fake.renameSession.mockRejectedValueOnce(new Error('rename broke'));
    b.component().handleInput(DOWN);
    b.component().handleInput(CTRL_R);
    b.component().handleInput('X');
    b.component().handleInput(ENTER);
    await flush();
    expect(b.showError).toHaveBeenCalledWith(expect.stringContaining('rename broke'));
    expect(b.render()).toContain('s1 title');
    expect(b.render()).not.toContain('s1 titleX');
  });
});

describe('AgentsViewController — peek', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('Space resumes the session, projects the context tail and detaches', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.fake.session.getContext.mockResolvedValueOnce({
      history: [
        { role: 'user', content: [{ type: 'text', text: 'hello agent' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'working on it\nalmost done' }] },
      ],
      tokenCount: 42,
    });
    b.component().handleInput(DOWN);
    b.component().handleInput(' ');
    await flush();
    expect(b.fake.resumeSession).toHaveBeenCalledWith({ id: 's1' });
    expect(b.fake.session.getContext).toHaveBeenCalled();
    expect(b.fake.session.close).toHaveBeenCalled();
    const out = b.render();
    expect(out).toContain('Peek: s1 title');
    expect(out).toContain('almost done');
  });

  it('Esc closes the peek without resuming again', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(' ');
    await flush();
    expect(b.render()).toContain('Peek:');
    b.component().handleInput(ESC);
    expect(b.controller.isOpen).toBe(true);
    expect(b.view().peek).toBeUndefined();
    expect(b.fake.resumeSession).toHaveBeenCalledTimes(1);
  });

  it('a failed peek flashes the error and closes the panel', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.fake.resumeSession.mockRejectedValueOnce(new Error('no such session'));
    b.component().handleInput(DOWN);
    b.component().handleInput(' ');
    await flush();
    expect(b.view().peek).toBeUndefined();
    expect(b.render()).toContain('no such session');
    b.controller.close(); // clear the pending flash timer
  });

  it('submitPeekReply steers the session (Task 4 wires the reply editor to it)', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    await b.controller.submitPeekReply('s1', 'please continue');
    expect(b.fake.resumeSession).toHaveBeenCalledWith({ id: 's1' });
    expect(b.fake.session.steer).toHaveBeenCalledWith('please continue');
    expect(b.fake.session.close).toHaveBeenCalled();
    b.controller.close();
  });
});

describe('AgentsViewController — open', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('Enter on a row shows the attach placeholder', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(ENTER);
    expect(b.showStatus).toHaveBeenCalledWith('Attach lands in M4');
  });

  it('Enter on a row delegates to onOpenSession when the host provides one', async () => {
    const onOpenSession = vi.fn();
    const b = await boot([summary('s1')], { onOpenSession });
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(ENTER);
    expect(onOpenSession).toHaveBeenCalledWith('s1');
    expect(b.showStatus).not.toHaveBeenCalled();
  });

  it('Enter on a group header collapses and re-expands its rows', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    // selection starts on the Completed group header
    b.component().handleInput(ENTER);
    expect(b.render()).toContain('Completed');
    expect(b.render()).not.toContain('s1 title');
    b.component().handleInput(ENTER);
    expect(b.render()).toContain('s1 title');
  });

  it('Enter on the more row expands the completed group', async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      summary(`s${String(i)}`, { updatedAt: 1_000 + i }),
    );
    const b = await boot(rows);
    dir = b.homeDir;
    expect(b.render()).toContain('… 2 more');
    for (let i = 0; i < 11; i += 1) b.component().handleInput(DOWN);
    b.component().handleInput(ENTER);
    const out = b.render();
    expect(out).not.toContain('… 2 more');
    expect(out).toContain('s0 title');
  });
});
