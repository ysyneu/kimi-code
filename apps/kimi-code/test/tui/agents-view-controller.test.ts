import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Event, KimiHarness, Session, SessionSummary, WireSession } from '@moonshot-ai/kimi-code-sdk';
import { SDKRpcClientWire } from '@moonshot-ai/kimi-code-sdk';
import type { Component, Container, ProcessTerminal, Terminal, TUI } from '@moonshot-ai/pi-tui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadPins } from '@/tui/agents/roster-persistence';
import type { AgentsViewApp } from '@/tui/components/agents-view/app';
import type { CustomEditor } from '@/tui/components/editor/custom-editor';
import {
  AgentsViewController,
  dispatchSlashCommands,
  hintDeferredPermissionOnce,
  type AgentsViewHost,
  type AgentsViewState,
} from '@/tui/controllers/agents-view';
import {
  AgentsViewDispatch,
  parseDispatchInput,
} from '@/tui/controllers/agents-view-dispatch';
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
  render(): string[];
  terminal: { rows: number; columns: number };
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

/** A full wire session row (what `SDKRpcClientWire.listSessionRows` serves). */
function wireRow(id: string, overrides: Partial<WireSession> = {}): WireSession {
  return {
    id,
    workspace_id: 'ws_1',
    title: `${id} title`,
    created_at: new Date(1).toISOString(),
    updated_at: new Date(1_000).toISOString(),
    busy: false,
    pending_interaction: 'none',
    metadata: { cwd: '/home/user/project' },
    agent_config: { model: 'k2' },
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_cost_usd: 0,
      context_tokens: 0,
      context_limit: 0,
      turn_count: 0,
    },
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
    ...overrides,
  };
}

interface FakeHarness {
  harness: KimiHarness;
  listSessions: ReturnType<typeof vi.fn>;
  resumeSession: ReturnType<typeof vi.fn>;
  deleteSession: ReturnType<typeof vi.fn>;
  renameSession: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
  session: { getContext: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  createdSession: { id: string; prompt: ReturnType<typeof vi.fn> };
  wirePrompt: ReturnType<typeof vi.fn> | undefined;
  wireTrust: ReturnType<typeof vi.fn> | undefined;
  wireRows: ReturnType<typeof vi.fn> | undefined;
  emit(event: unknown): void;
  emitConnection(connected: boolean): void;
}

function makeHarness(
  homeDir: string,
  summaries: readonly SessionSummary[],
  opts: {
    wire?: boolean;
    trust?: (id: string) => Promise<boolean | undefined>;
    rows?: readonly WireSession[];
  } = {},
): FakeHarness {
  const listeners = new Set<(event: Event) => void>();
  const connectionListeners = new Set<(connected: boolean) => void>();
  const session = {
    getContext: vi.fn(async () => ({ history: [], tokenCount: 0 })),
    steer: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const createdSession = { id: 'new-session', prompt: vi.fn(async () => {}) };
  const wirePrompt = opts.wire === true ? vi.fn(async () => {}) : undefined;
  const wireTrust = opts.wire === true ? vi.fn(opts.trust ?? (async () => true)) : undefined;
  const wireRows =
    opts.wire === true
      ? vi.fn(async () => opts.rows ?? summaries.map((s) => wireRow(s.id, { title: s.title })))
      : undefined;
  // A bare prototype instance satisfies the controller's instanceof narrowing
  // without booting a real wire client.
  const wireRpc =
    wirePrompt === undefined || wireTrust === undefined || wireRows === undefined
      ? undefined
      : (Object.assign(Object.create(SDKRpcClientWire.prototype) as SDKRpcClientWire, {
          prompt: wirePrompt,
          getWorkspaceTrustForSession: wireTrust,
          listSessionRows: wireRows,
          onConnectionState: (listener: (connected: boolean) => void) => {
            connectionListeners.add(listener);
            return () => {
              connectionListeners.delete(listener);
            };
          },
        }));
  const listSessions = vi.fn(async () => summaries);
  const resumeSession = vi.fn(async () => session as unknown as Session);
  const deleteSession = vi.fn(async () => {});
  const renameSession = vi.fn(async () => {});
  const createSession = vi.fn(async () => createdSession as unknown as Session);
  const harness = {
    homeDir,
    listSessions,
    resumeSession,
    deleteSession,
    renameSession,
    createSession,
    rpc: wireRpc,
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
    createSession,
    session,
    createdSession,
    wirePrompt,
    wireTrust,
    wireRows,
    emit: (event: unknown) => {
      for (const listener of listeners) listener(event as Event);
    },
    emitConnection: (connected: boolean) => {
      for (const listener of connectionListeners) listener(connected);
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
  setAttachBadge: ReturnType<typeof vi.fn>;
  view(): AgentsViewState;
  component(): AgentsViewApp;
  render(): string;
}

const SENTINEL_A = { tag: 'sentinel-a' } as unknown as Component;
const SENTINEL_B = { tag: 'sentinel-b' } as unknown as Component;

async function boot(
  summaries: readonly SessionSummary[],
  opts: {
    onOpenSession?: (id: string) => void;
    wire?: boolean;
    trust?: (id: string) => Promise<boolean | undefined>;
    rows?: readonly WireSession[];
    currentSessionId?: string;
  } = {},
): Promise<Boot> {
  const homeDir = await mkdtemp(join(tmpdir(), 'agents-view-controller-'));
  const fake = makeHarness(homeDir, summaries, { wire: opts.wire, trust: opts.trust, rows: opts.rows });
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
    render: () => [],
    terminal: { rows: 30, columns: 120 },
  };
  const state = {
    agentsView: undefined as AgentsViewState | undefined,
    theme: currentTheme,
    terminal: fakeTerminal(30) as unknown as ProcessTerminal,
    ui: ui as unknown as TUI,
    editor: { tag: 'editor' } as unknown as CustomEditor,
    editorContainer: undefined as unknown as Container,
  };
  state.editorContainer = { children: [state.editor] } as unknown as Container;
  const showError = vi.fn();
  const showStatus = vi.fn();
  const setAttachBadge = vi.fn();
  const host: AgentsViewHost = {
    state,
    harness: fake.harness,
    showError,
    showStatus,
    setAgentsView: (value) => {
      state.agentsView = value;
    },
    agentsViewServerLabel: () => 'test-server',
    agentsViewWorkDir: () => '/home/user/project',
    setAttachBadge,
    getCurrentSessionId: () => opts.currentSessionId ?? '',
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
    setAttachBadge,
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

  it('submitPeekReply resumes, steers and detaches the session', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    await b.controller.submitPeekReply('s1', 'please continue');
    expect(b.fake.resumeSession).toHaveBeenCalledWith({ id: 's1' });
    expect(b.fake.session.steer).toHaveBeenCalledWith('please continue');
    expect(b.fake.session.close).toHaveBeenCalled();
    b.controller.close();
  });

  it('typing while peeked drafts the reply and never touches the dispatch editor', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(' ');
    await flush();
    expect(b.view().peek?.sessionId).toBe('s1');

    b.component().handleInput('h');
    b.component().handleInput('i');

    expect(b.view().peek?.replyDraft).toBe('hi');
    // The dangerous misroute (final review C2): a reply must NOT become a
    // new-session dispatch.
    expect(b.view().dispatch.editor.getText()).toBe('');
    expect(b.view().dispatchFocused).toBe(false);
    expect(b.render()).toContain('reply › hi');
  });

  it('Enter while peeked steers the peeked session and clears the draft', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(' ');
    await flush();
    b.component().handleInput('g');
    b.component().handleInput('o');
    b.component().handleInput(ENTER);
    await flush();

    expect(b.fake.resumeSession).toHaveBeenCalledWith({ id: 's1' });
    expect(b.fake.session.steer).toHaveBeenCalledWith('go');
    expect(b.fake.session.close).toHaveBeenCalled();
    expect(b.view().peek?.replyDraft).toBe('');
    expect(b.fake.createSession).not.toHaveBeenCalled();
  });

  it('Esc clears the reply draft first, a second Esc closes the peek', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(' ');
    await flush();
    b.component().handleInput('x');
    expect(b.view().peek?.replyDraft).toBe('x');

    b.component().handleInput(ESC);
    expect(b.view().peek?.replyDraft).toBe('');
    expect(b.view().peek).toBeDefined();

    b.component().handleInput(ESC);
    expect(b.view().peek).toBeUndefined();
    expect(b.controller.isOpen).toBe(true);
  });

  it('a failed reply flashes the error and keeps the peek open', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(' ');
    await flush();
    b.component().handleInput('g');
    b.component().handleInput('o');
    b.fake.session.steer.mockRejectedValueOnce(new Error('steer exploded'));
    b.component().handleInput(ENTER);
    await flush();

    expect(b.view().peek?.sessionId).toBe('s1');
    expect(b.render()).toContain('Reply failed: steer exploded');
    b.controller.close(); // clear the pending flash timer
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
    expect(b.showStatus).toHaveBeenCalledWith('Attach is not available from this host');
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

// ── Dispatch editor + whitelist autocomplete + submission parsing ──

describe('parseDispatchInput', () => {
  it('plain text passes through as-is (trimmed)', () => {
    expect(parseDispatchInput('fix the flaky test')).toEqual({ text: 'fix the flaky test' });
    expect(parseDispatchInput('  fix the flaky test  ')).toEqual({ text: 'fix the flaky test' });
  });

  it('a /model prefix stages the model and keeps the rest as text', () => {
    expect(parseDispatchInput('/model kimi-k2 fix the flaky test')).toEqual({
      text: 'fix the flaky test',
      model: 'kimi-k2',
    });
  });

  it('a /agent prefix stages the profile and keeps the rest as text', () => {
    expect(parseDispatchInput('/agent reviewer fix the flaky test')).toEqual({
      text: 'fix the flaky test',
      profile: 'reviewer',
    });
  });

  it('collapses extra whitespace around the staged argument', () => {
    expect(parseDispatchInput('/model   kimi-k2   fix the flaky test')).toEqual({
      text: 'fix the flaky test',
      model: 'kimi-k2',
    });
  });

  it('any other slash command is rejected as session-only', () => {
    expect(parseDispatchInput('/yolo fix the flaky test')).toEqual({
      error: '"/yolo" is only available inside a session',
    });
    expect(parseDispatchInput('/help')).toEqual({
      error: '"/help" is only available inside a session',
    });
    expect(parseDispatchInput('/modelx fix the flaky test')).toEqual({
      error: '"/modelx" is only available inside a session',
    });
  });

  it('a slash token mid-text is plain text, not a command', () => {
    expect(parseDispatchInput('fix /model handling')).toEqual({ text: 'fix /model handling' });
  });

  it('rejects empty and too-short input', () => {
    expect(parseDispatchInput('')).toEqual({ error: 'Too short — describe the task' });
    expect(parseDispatchInput('   ')).toEqual({ error: 'Too short — describe the task' });
    expect(parseDispatchInput('ab')).toEqual({ error: 'Too short — describe the task' });
    expect(parseDispatchInput('a b')).toEqual({ error: 'Too short — describe the task' });
  });

  it('counts non-space characters for the minimum length', () => {
    expect(parseDispatchInput('a b c')).toEqual({ text: 'a b c' });
  });

  it('a staged /model or /agent without enough task text is too short', () => {
    expect(parseDispatchInput('/model')).toEqual({ error: 'Too short — describe the task' });
    expect(parseDispatchInput('/model kimi-k2')).toEqual({ error: 'Too short — describe the task' });
    expect(parseDispatchInput('/agent')).toEqual({ error: 'Too short — describe the task' });
  });
});

describe('AgentsViewDispatch — editor wiring', () => {
  function makeDispatch(): AgentsViewDispatch {
    const tui = {
      requestRender: vi.fn(),
      render: vi.fn(() => []),
      terminal: { rows: 40, cols: 120 },
    } as unknown as TUI;
    return new AgentsViewDispatch(tui, '/home/user/project');
  }

  it('an editor submission parses and forwards the DispatchSubmission to onSubmit', () => {
    const dispatch = makeDispatch();
    const onSubmit = vi.fn();
    dispatch.onSubmit = onSubmit;
    dispatch.editor.onSubmit?.('/model kimi-k2 fix the flaky test');
    expect(onSubmit).toHaveBeenCalledWith({ text: 'fix the flaky test', model: 'kimi-k2' });
  });

  it('a parse error goes to onError and never reaches onSubmit', () => {
    const dispatch = makeDispatch();
    const onSubmit = vi.fn();
    const onError = vi.fn();
    dispatch.onSubmit = onSubmit;
    dispatch.onError = onError;
    dispatch.editor.onSubmit?.('/yolo');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('"/yolo" is only available inside a session');
  });

  it('installAutocomplete suggests only the installed commands', async () => {
    const dispatch = makeDispatch();
    dispatch.installAutocomplete(dispatchSlashCommands());
    const provider = (
      dispatch.editor as unknown as {
        autocompleteProvider: {
          getSuggestions(
            lines: string[],
            cursorLine: number,
            cursorCol: number,
            options: { signal: AbortSignal },
          ): Promise<{ items: { value: string }[] } | null>;
        };
      }
    ).autocompleteProvider;
    const suggestions = await provider.getSuggestions(['/'], 0, 1, {
      signal: new AbortController().signal,
    });
    expect(suggestions?.items.map((item) => item.value).toSorted()).toEqual([
      'agent',
      'help',
      'model',
    ]);
  });

  it('the dispatch whitelist is /model + /help from the builtins plus a local /agent', () => {
    const commands = dispatchSlashCommands();
    expect(commands.map((command) => command.name).toSorted()).toEqual(['agent', 'help', 'model']);
    const agent = commands.find((command) => command.name === 'agent');
    expect(agent?.description).toBeTruthy();
  });
});

describe('AgentsViewController — dispatch', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('a plain submission creates a session in the view workDir and prompts it', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.view().dispatch.editor.onSubmit?.('fix the flaky test');
    await flush();
    expect(b.fake.createSession).toHaveBeenCalledWith({ workDir: '/home/user/project' });
    expect(b.fake.createdSession.prompt).toHaveBeenCalledWith('fix the flaky test');
  });

  it('model/profile overrides ride the wire rpc prompt, not Session.prompt', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    b.view().dispatch.editor.onSubmit?.('/model kimi-k2 fix the flaky test');
    await flush();
    expect(b.fake.createdSession.prompt).not.toHaveBeenCalled();
    expect(b.fake.wirePrompt).toHaveBeenCalledWith({
      sessionId: 'new-session',
      input: [{ type: 'text', text: 'fix the flaky test' }],
      model: 'kimi-k2',
      profile: undefined,
    });
    b.view().dispatch.editor.onSubmit?.('/agent reviewer fix the flaky test');
    await flush();
    expect(b.fake.wirePrompt).toHaveBeenLastCalledWith({
      sessionId: 'new-session',
      input: [{ type: 'text', text: 'fix the flaky test' }],
      model: undefined,
      profile: 'reviewer',
    });
  });

  it('a plain submission still uses Session.prompt on the wire transport', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    b.view().dispatch.editor.onSubmit?.('fix the flaky test');
    await flush();
    expect(b.fake.createdSession.prompt).toHaveBeenCalledWith('fix the flaky test');
    expect(b.fake.wirePrompt).not.toHaveBeenCalled();
  });

  it('overrides without the wire transport fail before createSession (no orphan session)', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.view().dispatch.editor.onSubmit?.('/model kimi-k2 fix the flaky test');
    await flush();
    expect(b.fake.createSession).not.toHaveBeenCalled();
    expect(b.fake.createdSession.prompt).not.toHaveBeenCalled();
    expect(b.view().flashMessage).toContain('wire transport');
    b.controller.close(); // clear the pending flash timer
  });

  it('a rejected slash command flashes the error and creates nothing', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.view().dispatch.editor.onSubmit?.('/yolo fix the flaky test');
    await flush();
    expect(b.fake.createSession).not.toHaveBeenCalled();
    expect(b.render()).toContain('"/yolo" is only available inside a session');
    b.controller.close(); // clear the pending flash timer
  });

  it('too-short input flashes the Too short hint', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.view().dispatch.editor.onSubmit?.('ab');
    await flush();
    expect(b.fake.createSession).not.toHaveBeenCalled();
    expect(b.render()).toContain('Too short — describe the task');
    b.controller.close(); // clear the pending flash timer
  });

  it('a failing createSession flashes the dispatch error', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.fake.createSession.mockRejectedValueOnce(new Error('workspace rejected'));
    b.view().dispatch.editor.onSubmit?.('fix the flaky test');
    await flush();
    expect(b.render()).toContain('Dispatch failed: workspace rejected');
    b.controller.close(); // clear the pending flash timer
  });
});

// ── Workspace trust lookup on show() → roster badge ──

describe('AgentsViewController — workspace trust', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('show fetches trust per row through the wire rpc and renders the untrusted badge', async () => {
    const b = await boot([summary('s1'), summary('s2')], {
      wire: true,
      trust: async (id) => id === 's2',
    });
    dir = b.homeDir;
    await flush();
    expect(b.fake.wireTrust).toHaveBeenCalledWith('s1');
    expect(b.fake.wireTrust).toHaveBeenCalledWith('s2');
    expect(b.view().roster.get('s1')?.trusted).toBe(false);
    expect(b.view().roster.get('s2')?.trusted).toBe(true);
    expect(b.render()).toContain('untrusted');
  });

  it('a failing trust lookup leaves the row without a badge and spams no error', async () => {
    const b = await boot([summary('s1'), summary('s2')], {
      wire: true,
      trust: async (id) => {
        if (id === 's1') throw new Error('trust route exploded');
        return true;
      },
    });
    dir = b.homeDir;
    await flush();
    expect(b.view().roster.get('s1')?.trusted).toBeUndefined();
    expect(b.view().roster.get('s2')?.trusted).toBe(true);
    expect(b.render()).not.toContain('untrusted');
    expect(b.view().flashMessage).toBeUndefined();
    expect(b.showError).not.toHaveBeenCalled();
  });

  it('non-wire transports skip the trust lookup entirely', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    await flush();
    expect(b.view().roster.get('s1')?.trusted).toBeUndefined();
    expect(b.render()).not.toContain('untrusted');
  });
});

// ── Dispatch editor visual mount (focus split + key routing) ──

describe('AgentsViewController — dispatch editor mount', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('show mounts the dispatch editor into the bottom area, list-focused', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    expect(b.view().dispatchFocused).toBe(false);
    // The mounted CustomEditor renders its bordered box with the `>` prompt.
    const out = b.render();
    expect(out).toContain('─'.repeat(20));
    expect(out).toContain('>');
  });

  it('typing a printable char focuses the dispatch editor and feeds it the text', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput('d');
    expect(b.view().dispatchFocused).toBe(true);
    expect(b.view().dispatch.editor.focused).toBe(true);
    expect(b.view().dispatch.editor.getText()).toBe('d');
    b.component().handleInput('o');
    expect(b.view().dispatch.editor.getText()).toBe('do');
  });

  it('Esc returns focus to the list; a second Esc closes the view', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput('d');
    expect(b.view().dispatchFocused).toBe(true);
    b.component().handleInput(ESC);
    expect(b.view().dispatchFocused).toBe(false);
    expect(b.view().dispatch.editor.focused).toBe(false);
    expect(b.controller.isOpen).toBe(true);
    b.component().handleInput(ESC);
    expect(b.controller.isOpen).toBe(false);
  });

  it('Enter in the focused dispatch editor submits the dispatch and unfocuses', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    for (const ch of 'do stuff') b.component().handleInput(ch);
    expect(b.view().dispatchFocused).toBe(true);
    b.component().handleInput(ENTER);
    await flush();
    expect(b.fake.createSession).toHaveBeenCalledWith({ workDir: '/home/user/project' });
    expect(b.fake.createdSession.prompt).toHaveBeenCalledWith('do stuff');
    expect(b.view().dispatchFocused).toBe(false);
  });
});

// ── Attach — component detach keeps the roster subscription alive ──

describe('AgentsViewController — detach for attach', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('detachForAttach unmounts the component and restores the saved children', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.controller.detachForAttach('s1');
    expect(b.view().detached).toBe(true);
    expect(b.ui.children).toEqual([SENTINEL_A, SENTINEL_B]);
    expect(b.ui.setFocus).toHaveBeenLastCalledWith(b.host.state.editor);
    // The state (roster + subscription) survives — only the component unmounted.
    expect(b.controller.isOpen).toBe(true);
  });

  it('the roster subscription keeps reducing events while detached, without rendering', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.controller.detachForAttach('s1');
    b.ui.requestRender.mockClear();
    b.fake.emit({
      type: 'event.session.work_changed',
      sessionId: 's1',
      busy: true,
      pending_interaction: 'none',
    });
    expect(b.view().roster.counts().working).toBe(1);
    // Detached: no component to push props into — events must not re-show it.
    expect(b.ui.requestRender).not.toHaveBeenCalled();
    expect(b.ui.children).toEqual([SENTINEL_A, SENTINEL_B]);
  });

  it('close while detached is a no-op — the subscription survives the runtime reset', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.controller.detachForAttach('s1');
    b.controller.close();
    expect(b.controller.isOpen).toBe(true);
    b.fake.emit({
      type: 'event.session.work_changed',
      sessionId: 's1',
      busy: true,
      pending_interaction: 'none',
    });
    expect(b.view().roster.counts().working).toBe(1);
  });

  it('show while detached remounts the same component over the live roster', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.controller.detachForAttach('s1');
    b.fake.emit({
      type: 'event.session.work_changed',
      sessionId: 's1',
      busy: true,
      pending_interaction: 'none',
    });
    await b.controller.show();
    expect(b.view().detached).toBe(false);
    expect(b.ui.children).toEqual([b.component()]);
    // No reload — the subscription kept the roster current.
    expect(b.fake.listSessions).toHaveBeenCalledTimes(1);
    const out = b.render();
    expect(out).toContain('Working');
    expect(out).toContain('s1 title');
  });
});


// ── Attach footer badge feed + deferred-permission hint ──

describe('AgentsViewController — attach badge feed', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('detachForAttach pushes the current roster counts as the initial badge', async () => {
    const b = await boot([summary('s1'), summary('s2')]);
    dir = b.homeDir;
    b.fake.emit({
      type: 'event.session.work_changed',
      sessionId: 's1',
      busy: true,
      pending_interaction: 'none',
    });
    b.setAttachBadge.mockClear();

    // Attaching s2: the working s1 is an OTHER session and counts.
    b.controller.detachForAttach('s2');

    expect(b.setAttachBadge).toHaveBeenCalledTimes(1);
    expect(b.setAttachBadge).toHaveBeenLastCalledWith({ agents: 1, awaiting: 0 });
  });

  it('seeds the badge excluding the session being attached (no pre-seeded current id)', async () => {
    // Regression (review round 2): the harness deliberately does NOT pre-seed
    // currentSessionId — at real attach time appState.sessionId still holds
    // the previous session, so the seed must exclude the id passed into
    // detachForAttach, not the stale current one.
    const b = await boot([summary('s1'), summary('s2')]);
    dir = b.homeDir;
    // s1 (about to be attached) already awaits input; s2 is working.
    b.fake.emit({
      type: 'event.session.work_changed',
      sessionId: 's1',
      busy: false,
      pending_interaction: 'approval',
    });
    b.fake.emit({
      type: 'event.session.work_changed',
      sessionId: 's2',
      busy: true,
      pending_interaction: 'none',
    });
    b.setAttachBadge.mockClear();

    b.controller.detachForAttach('s1');

    // s1 is excluded from the seed even though the host's current id is ''.
    expect(b.setAttachBadge).toHaveBeenCalledTimes(1);
    expect(b.setAttachBadge).toHaveBeenLastCalledWith({ agents: 1, awaiting: 0 });
  });

  it('roster events while detached keep pushing live counts', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.controller.detachForAttach('s1');
    b.setAttachBadge.mockClear();

    b.fake.emit({
      type: 'event.session.work_changed',
      sessionId: 's1',
      busy: false,
      pending_interaction: 'approval',
    });

    expect(b.setAttachBadge).toHaveBeenLastCalledWith({ agents: 0, awaiting: 1 });
  });

  it('excludes the attached session itself from the badge counts', async () => {
    const b = await boot([summary('s1'), summary('s2')], { currentSessionId: 's1' });
    dir = b.homeDir;
    // s1 (the attached session) is working, s2 awaits input.
    b.fake.emit({
      type: 'event.session.work_changed',
      sessionId: 's1',
      busy: true,
      pending_interaction: 'none',
    });
    b.fake.emit({
      type: 'event.session.work_changed',
      sessionId: 's2',
      busy: false,
      pending_interaction: 'approval',
    });
    b.setAttachBadge.mockClear();

    b.controller.detachForAttach('s1');

    // Only s2 counts — the attached s1 is on screen, not badge-worthy.
    expect(b.setAttachBadge).toHaveBeenLastCalledWith({ agents: 0, awaiting: 1 });

    // s1's own state changes never move the badge at all.
    b.setAttachBadge.mockClear();
    b.fake.emit({
      type: 'event.session.work_changed',
      sessionId: 's1',
      busy: false,
      pending_interaction: 'approval',
    });
    expect(b.setAttachBadge).toHaveBeenLastCalledWith({ agents: 0, awaiting: 1 });
  });

  it('does not push the badge while the view is mounted (it renders counts itself)', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.setAttachBadge.mockClear();

    b.fake.emit({
      type: 'event.session.work_changed',
      sessionId: 's1',
      busy: true,
      pending_interaction: 'none',
    });

    expect(b.setAttachBadge).not.toHaveBeenCalled();
  });

  it('returning to the view (remount) clears the badge', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.controller.detachForAttach('s1');
    b.setAttachBadge.mockClear();

    await b.controller.show();

    expect(b.view().detached).toBe(false);
    expect(b.setAttachBadge).toHaveBeenCalledTimes(1);
    expect(b.setAttachBadge).toHaveBeenLastCalledWith(undefined);
  });
});

describe('hintDeferredPermissionOnce', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('stays silent while the view is mounted (not attached)', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;

    hintDeferredPermissionOnce(b.host);

    expect(b.showStatus).not.toHaveBeenCalled();
  });

  it('shows the hint once per attach, then never again for that attach', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.controller.detachForAttach('s1');

    hintDeferredPermissionOnce(b.host);
    hintDeferredPermissionOnce(b.host);

    expect(b.showStatus).toHaveBeenCalledTimes(1);
    expect(b.showStatus).toHaveBeenCalledWith('Permission mode applies to the next prompt.');
  });

  it('re-arms on the next attach (detachForAttach resets the flag)', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.controller.detachForAttach('s1');
    hintDeferredPermissionOnce(b.host);
    expect(b.showStatus).toHaveBeenCalledTimes(1);

    // Return to the view, then attach again.
    await b.controller.show();
    b.controller.detachForAttach('s1');
    hintDeferredPermissionOnce(b.host);

    expect(b.showStatus).toHaveBeenCalledTimes(2);
  });

  it('stays silent when there is no agents view at all', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.controller.close();

    hintDeferredPermissionOnce(b.host);

    expect(b.showStatus).not.toHaveBeenCalled();
  });
});


// ── Final review I1: cold-open seeds busy/awaiting from the rich wire rows ──

describe('AgentsViewController — wire row seeding (I1)', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('cold-open on the wire seeds busy/awaiting state from the rich session rows', async () => {
    const b = await boot([summary('s1'), summary('s2')], {
      wire: true,
      rows: [wireRow('s1', { busy: true }), wireRow('s2', { pending_interaction: 'approval' })],
    });
    dir = b.homeDir;
    // The wire path replaces listSessions entirely — one GET, no dropped facts.
    expect(b.fake.wireRows).toHaveBeenCalled();
    expect(b.fake.listSessions).not.toHaveBeenCalled();
    expect(b.view().roster.get('s1')?.busy).toBe(true);
    expect(b.view().roster.get('s2')?.pendingInteraction).toBe('approval');
    const out = b.render();
    expect(out).toContain('Awaiting input');
    expect(out).toContain('Working');
    expect(out).toContain('1 awaiting input');
    expect(out).toContain('1 working');
  });

  it('non-wire transports fall back to SessionSummary seeding (idle defaults)', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    expect(b.fake.listSessions).toHaveBeenCalled();
    const row = b.view().roster.get('s1');
    expect(row?.busy).toBe(false);
    expect(row?.pendingInteraction).toBe('none');
    expect(b.render()).toContain('Completed');
  });
});

// ── Final review I2: roster reconciliation after a WS reconnect ──

describe('AgentsViewController — reconnect reconciliation (I2)', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('a WS reconnect re-seeds the roster from a fresh session list', async () => {
    const b = await boot([summary('s1')], { wire: true, rows: [wireRow('s1', { busy: true })] });
    dir = b.homeDir;
    await flush(); // the one-shot trust load settles
    expect(b.view().roster.get('s1')?.busy).toBe(true);
    expect(b.view().roster.get('s1')?.trusted).toBe(true);

    // During the drop s1's turn finished and a new session appeared — both
    // global events were lost (no journal), so the reconnect re-list must
    // surface them.
    b.fake.wireRows?.mockResolvedValueOnce([
      wireRow('s1', { last_turn_reason: 'completed' }),
      wireRow('s2', { pending_interaction: 'question' }),
    ]);
    b.fake.emitConnection(true);
    await flush();

    const row = b.view().roster.get('s1');
    expect(row?.busy).toBe(false);
    expect(row?.lastTurnReason).toBe('completed');
    // The trust badge survives the re-seed (the wire rows carry no trust info).
    expect(row?.trusted).toBe(true);
    expect(b.view().roster.get('s2')?.pendingInteraction).toBe('question');
    const out = b.render();
    expect(out).toContain('s2 title');
    expect(out).toContain('Completed');
  });

  it('a disconnect does not re-list; a row vanished during the drop drops its selection/peek', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    b.component().handleInput(DOWN); // select s1
    b.component().handleInput(' '); // peek s1
    await flush();
    expect(b.view().peek?.sessionId).toBe('s1');
    b.fake.wireRows?.mockClear();

    b.fake.emitConnection(false);
    await flush();
    expect(b.fake.wireRows).not.toHaveBeenCalled();

    // s1 was archived elsewhere during the drop.
    b.fake.wireRows?.mockResolvedValueOnce([]);
    b.fake.emitConnection(true);
    await flush();
    expect(b.view().roster.get('s1')).toBeUndefined();
    expect(b.view().selectedId).toBeUndefined();
    expect(b.view().peek).toBeUndefined();
  });

  it('close unsubscribes the connection-state feed', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    b.controller.close();
    b.fake.wireRows?.mockClear();
    b.fake.emitConnection(true);
    await flush();
    expect(b.fake.wireRows).not.toHaveBeenCalled();
  });
});
