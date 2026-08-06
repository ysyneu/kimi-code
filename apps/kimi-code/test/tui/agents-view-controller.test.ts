import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Event, KimiHarness, Session, SessionSummary, WireSession } from '@moonshot-ai/kimi-code-sdk';
import { SDKRpcClientWire } from '@moonshot-ai/kimi-code-sdk';
import type { Component, Container, ProcessTerminal, Terminal, TUI } from '@moonshot-ai/pi-tui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAgentsViewState, saveAgentsViewState } from '@/tui/agents/roster-persistence';
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
    wireRpc: () => wireRpc,
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
    /**
     * Pre-seeded view registry (the sessions this view "owns"). Defaults to
     * every boot summary, mirroring a view that dispatched them all — the
     * roster only lists registered sessions, so an empty registry boots an
     * empty view.
     */
    registered?: readonly string[];
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
    agentsViewModelLabel: () => 'test-model',
    setAttachBadge,
    getCurrentSessionId: () => opts.currentSessionId ?? '',
    onOpenSession: opts.onOpenSession,
  };
  const controller = new AgentsViewController(host);
  // Pre-seed the view registry BEFORE show(): the roster only lists sessions
  // the view owns, so the persisted file must already name the boot sessions.
  await saveAgentsViewState(homeDir, {
    pins: new Set(),
    sessions: new Set(opts.registered ?? summaries.map((s) => s.id)),
    seenAt: new Map(),
  });
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

/** saveAgentsViewState does real fs I/O (mkdir + write + rename), which needs
 *  several event-loop turns — poll the file instead of guessing a delay. */
async function waitForViewState(
  homeDir: string,
  expected: { pins: Set<string>; sessions: Set<string> },
): Promise<void> {
  await vi.waitFor(async () => {
    const state = await loadAgentsViewState(homeDir);
    expect(state.pins).toEqual(expected.pins);
    expect(state.sessions).toEqual(expected.sessions);
  });
}

const ESC = '\u001B';
const CTRL_X = '\u0018';
const CTRL_R = '\u0012';
const CTRL_T = '\u0014';
const DOWN = '\u001B[B';
const LEFT = '\u001B[D';
const RIGHT = '\u001B[C';
const ENTER = '\r';
const UP = '\u001B[A';
const SPACE = ' ';
const SHIFT_UP = '\u001B[a';
const SHIFT_DOWN = '\u001B[b';
const ALT_1 = '\u001B1';
const ALT_3 = '\u001B3';

describe('AgentsViewController — mount / unmount', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) {
      // maxRetries: a fire-and-forget persistState can still be mid-write
      // (ENOTEMPTY on rmdir) when the test body returns.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
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
    expect(out).toContain('test-model');
  });

  it('show lists only sessions in the view registry', async () => {
    // s2 exists on the server but this view never dispatched or attached it —
    // the server-wide list must stay out of the roster.
    const b = await boot([summary('s1'), summary('s2')], { registered: ['s1'] });
    dir = b.homeDir;
    const out = b.render();
    expect(out).toContain('s1 title');
    expect(out).not.toContain('s2 title');
    expect(b.view().roster.get('s2')).toBeUndefined();
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
    if (dir !== undefined) {
      // maxRetries: a fire-and-forget persistState can still be mid-write
      // (ENOTEMPTY on rmdir) when the test body returns.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
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

  it('event.session.created only lands for sessions the view registered', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    // A session created by another client (kimi-web, another terminal) never
    // enters the view — the registry gate drops the server-wide fan-out.
    b.fake.emit({
      type: 'event.session.created',
      session: {
        id: 's9',
        title: 'foreign session',
        last_prompt: 'do things',
        metadata: { cwd: '/home/user/fresh' },
        updated_at: new Date().toISOString(),
        busy: false,
        pending_interaction: 'none',
      },
    });
    expect(b.render()).not.toContain('foreign session');

    // Registered first (as dispatch does before the first prompt), the
    // created echo lands as a row.
    b.view().viewSessions.add('s8');
    b.fake.emit({
      type: 'event.session.created',
      session: {
        id: 's8',
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

  it('a busy row starts the spinner ticker; an idle roster stops it', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    expect(b.view().busyTicker).toBeUndefined();
    b.fake.emit({ type: 'event.session.work_changed', sessionId: 's1', busy: true, pending_interaction: 'none' });
    expect(b.view().busyTicker).toBeDefined();
    b.fake.emit({ type: 'event.session.work_changed', sessionId: 's1', busy: false, pending_interaction: 'none' });
    expect(b.view().busyTicker).toBeUndefined();
  });
});

describe('AgentsViewController — delete', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) {
      // maxRetries: a fire-and-forget persistState can still be mid-write
      // (ENOTEMPTY on rmdir) when the test body returns.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
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
    // Archiving also drops the session from the persisted view registry.
    await waitForViewState(b.homeDir, { pins: new Set(), sessions: new Set(['s2']) });
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
    await waitForViewState(b.homeDir, { pins: new Set(['s1']), sessions: new Set(['s1']) });
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
    // Both rows leave the persisted view registry too.
    await waitForViewState(b.homeDir, { pins: new Set(), sessions: new Set() });
  });
});

describe('AgentsViewController — pin', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) {
      // maxRetries: a fire-and-forget persistState can still be mid-write
      // (ENOTEMPTY on rmdir) when the test body returns.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    dir = undefined;
  });

  it('Ctrl+T pins the row and persists the pins file', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(CTRL_T);
    await waitForViewState(b.homeDir, { pins: new Set(['s1']), sessions: new Set(['s1']) });
    expect(b.render()).toContain('Pinned');
  });

  it('Ctrl+T on a pinned row unpins and persists', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(CTRL_T);
    await waitForViewState(b.homeDir, { pins: new Set(['s1']), sessions: new Set(['s1']) });
    b.component().handleInput(CTRL_T);
    await waitForViewState(b.homeDir, { pins: new Set(), sessions: new Set(['s1']) });
    expect(b.render()).not.toContain('Pinned');
  });
});

describe('AgentsViewController — reorder pinned rows (shift+↑↓)', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) {
      // maxRetries: a fire-and-forget persistState can still be mid-write
      // (ENOTEMPTY on rmdir) when the test body returns.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    dir = undefined;
  });

  it('shift+↓ on the top pinned row moves it down and persists the new order; selection follows it', async () => {
    const b = await boot([summary('p1'), summary('p2')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN); // p1
    b.component().handleInput(CTRL_T); // pin p1
    b.component().handleInput(DOWN); // completed header
    b.component().handleInput(DOWN); // p2
    b.component().handleInput(CTRL_T); // pin p2
    await waitForViewState(b.homeDir, { pins: new Set(['p1', 'p2']), sessions: new Set(['p1', 'p2']) });
    b.component().handleInput(UP); // back onto p1 (top of the pinned group)
    expect(b.view().selectedId).toBe('p1');

    b.component().handleInput(SHIFT_DOWN);

    // Selection follows the row it acted on, not the position it moved to.
    expect(b.view().selectedId).toBe('p1');
    await vi.waitFor(async () => {
      const state = await loadAgentsViewState(b.homeDir);
      expect([...state.pins]).toEqual(['p2', 'p1']);
    });
    const out = b.render();
    expect(out.indexOf('p2 title')).toBeLessThan(out.indexOf('p1 title'));
  });

  it('shift+↑ at the top of the pinned order is a no-op', async () => {
    const b = await boot([summary('p1'), summary('p2')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(CTRL_T);
    b.component().handleInput(DOWN);
    b.component().handleInput(DOWN);
    b.component().handleInput(CTRL_T);
    await waitForViewState(b.homeDir, { pins: new Set(['p1', 'p2']), sessions: new Set(['p1', 'p2']) });
    b.component().handleInput(UP); // p1, already first in the pinned group

    b.component().handleInput(SHIFT_UP);

    await flush();
    const state = await loadAgentsViewState(b.homeDir);
    expect([...state.pins]).toEqual(['p1', 'p2']);
    expect(b.view().selectedId).toBe('p1');
  });

  it('shift+↑↓ on a non-pinned row is a no-op — no reorder, no persistence, selection unaffected', async () => {
    const b = await boot([summary('a'), summary('b')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN); // a
    b.component().handleInput(SHIFT_UP);
    b.component().handleInput(SHIFT_DOWN);
    expect(b.view().selectedId).toBe('a');
    await flush();
    const state = await loadAgentsViewState(b.homeDir);
    expect(state.pins).toEqual(new Set());
  });

  it('shift+↑↓ on a group header is a no-op', async () => {
    const b = await boot([summary('p1'), summary('p2')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(CTRL_T); // pin p1
    await waitForViewState(b.homeDir, { pins: new Set(['p1']), sessions: new Set(['p1', 'p2']) });
    b.component().handleInput(UP); // onto the "Pinned" group header

    b.component().handleInput(SHIFT_DOWN);

    await flush();
    const state = await loadAgentsViewState(b.homeDir);
    expect([...state.pins]).toEqual(['p1']);
  });
});

describe('AgentsViewController — rename', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) {
      // maxRetries: a fire-and-forget persistState can still be mid-write
      // (ENOTEMPTY on rmdir) when the test body returns.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
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

describe('AgentsViewController — arrow keys open the selected session', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) {
      // maxRetries: a fire-and-forget persistState can still be mid-write
      // (ENOTEMPTY on rmdir) when the test body returns.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    dir = undefined;
  });

  it('→ on a row opens the session — same effect as Enter', async () => {
    const onOpenSession = vi.fn();
    const b = await boot([summary('s1')], { onOpenSession });
    dir = b.homeDir;
    b.component().handleInput(DOWN); // onto row s1
    b.component().handleInput(RIGHT);
    expect(onOpenSession).toHaveBeenCalledWith('s1');
  });

  it('→ expands a collapsed group header, ← collapses an expanded one', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    // Selection starts on the Completed group header; Enter collapses it.
    b.component().handleInput(ENTER);
    expect(b.render()).not.toContain('s1 title');
    b.component().handleInput(RIGHT);
    expect(b.render()).toContain('s1 title');
    b.component().handleInput(LEFT);
    expect(b.render()).not.toContain('s1 title');
    expect(b.controller.isOpen).toBe(true);
  });

  it('← on a plain row is a no-op (nothing to collapse)', async () => {
    const onOpenSession = vi.fn();
    const b = await boot([summary('s1')], { onOpenSession });
    dir = b.homeDir;
    b.component().handleInput(DOWN); // onto row s1
    b.component().handleInput(LEFT);
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(b.render()).toContain('s1 title');
    expect(b.controller.isOpen).toBe(true);
  });
});

describe('AgentsViewController — open', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) {
      // maxRetries: a fire-and-forget persistState can still be mid-write
      // (ENOTEMPTY on rmdir) when the test body returns.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
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

  it('Enter on a row clears its unseen bit and persists the seen timestamp', async () => {
    const onOpenSession = vi.fn();
    const b = await boot([summary('s1', { updatedAt: 1_000 })], { onOpenSession });
    dir = b.homeDir;
    expect(b.view().roster.get('s1')?.unseen).toBe(true);

    b.component().handleInput(DOWN);
    b.component().handleInput(ENTER);

    expect(b.view().roster.get('s1')?.unseen).toBe(false);
    await vi.waitFor(async () => {
      const state = await loadAgentsViewState(b.homeDir);
      expect(state.seenAt).toEqual(new Map([['s1', 1_000]]));
    });
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

describe('AgentsViewController — quick-open (alt+1-9)', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) {
      // maxRetries: a fire-and-forget persistState can still be mid-write
      // (ENOTEMPTY on rmdir) when the test body returns.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    dir = undefined;
  });

  it('alt+1 opens the first visible session row via onOpenSession — same effect as Enter', async () => {
    const onOpenSession = vi.fn();
    const b = await boot(
      [summary('s1', { updatedAt: 300 }), summary('s2', { updatedAt: 200 })],
      { onOpenSession },
    );
    dir = b.homeDir;
    b.component().handleInput(ALT_1);
    expect(onOpenSession).toHaveBeenCalledWith('s1');
  });

  it('alt+N beyond the visible row count is a no-op', async () => {
    const onOpenSession = vi.fn();
    const b = await boot([summary('s1')], { onOpenSession });
    dir = b.homeDir;
    b.component().handleInput(ALT_3); // only 1 row exists
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it('alt+1 fires regardless of the current selection (global shortcut)', async () => {
    const onOpenSession = vi.fn();
    const b = await boot([summary('s1'), summary('s2')], { onOpenSession });
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(DOWN);
    b.component().handleInput(ALT_1);
    expect(onOpenSession).toHaveBeenCalledWith('s1');
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

describe('AgentsViewDispatch — @ mention autocomplete (functional verification)', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    dir = undefined;
  });

  async function flushAutocomplete(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  // Gap 11's open question: does `@` already trigger file-mention
  // completion in this exact composer, or does it need new wiring? This
  // constructs the dispatch composer exactly as `AgentsViewController.show`
  // does (`installAutocomplete(dispatchSlashCommands())` against a real
  // workDir) and types `@` into it — functional proof, not a code-reading
  // assumption. It already works: `CustomEditor` auto-triggers on `@`/`#`
  // (pi-tui's `DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS`) and
  // `FileMentionProvider` falls back to a real filesystem scan whenever
  // `fdPath` is `null`, which is exactly how this composer is configured.
  it('typing @ triggers file-mention suggestions in the same configuration the controller wires up', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'agents-view-dispatch-mention-'));
    dir = workDir;
    await writeFile(join(workDir, 'readme.md'), '# hi');
    const tui = {
      requestRender: vi.fn(),
      render: vi.fn(() => []),
      terminal: { rows: 40, cols: 120 },
    } as unknown as TUI;
    const dispatch = new AgentsViewDispatch(tui, workDir);
    dispatch.installAutocomplete(dispatchSlashCommands());

    dispatch.editor.handleInput('@');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flushAutocomplete();

    expect(dispatch.editor.isShowingAutocomplete()).toBe(true);
  });
});

describe('AgentsViewController — dispatch', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) {
      // maxRetries: a fire-and-forget persistState can still be mid-write
      // (ENOTEMPTY on rmdir) when the test body returns.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    dir = undefined;
  });

  it('a plain submission creates a session in the view workDir and prompts it', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.view().dispatch.editor.onSubmit?.('fix the flaky test');
    await flush();
    expect(b.fake.createSession).toHaveBeenCalledWith({ workDir: '/home/user/project' });
    expect(b.fake.createdSession.prompt).toHaveBeenCalledWith('fix the flaky test');
    // The new session is registered, persisted and pre-selected, so its
    // `event.session.created` echo passes the registry gate.
    expect(b.view().viewSessions.has('new-session')).toBe(true);
    expect(b.view().selectedId).toBe('new-session');
    await waitForViewState(b.homeDir, {
      pins: new Set(),
      sessions: new Set(['s1', 'new-session']),
    });
  });

  it('the created echo of a dispatched session lands as a selected working row', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.view().dispatch.editor.onSubmit?.('fix the flaky test');
    await flush();
    // The server's echo: the session exists, the first turn is running.
    b.fake.emit({
      type: 'event.session.created',
      session: {
        id: 'new-session',
        title: 'fix the flaky test',
        last_prompt: 'fix the flaky test',
        metadata: { cwd: '/home/user/project' },
        updated_at: new Date().toISOString(),
        busy: true,
        pending_interaction: 'none',
      },
    });
    const out = b.render();
    expect(out).toContain('fix the flaky test');
    expect(out).toContain('Working');
    expect(b.view().selectedId).toBe('new-session');
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

describe('AgentsViewController — reply mode (space)', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) {
      // maxRetries: a fire-and-forget persistState can still be mid-write
      // (ENOTEMPTY on rmdir) when the test body returns.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    dir = undefined;
  });

  it('space on a row focuses the composer on that session — placeholder and footer switch to reply mode', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(SPACE);
    expect(b.view().replyTargetId).toBe('s1');
    expect(b.view().dispatchFocused).toBe(true);
    expect(b.view().dispatch.editor.focused).toBe(true);
    expect(b.view().dispatch.editor.placeholder).toBe('reply to s1 title');
    const out = b.render();
    expect(out).toContain('enter to send');
    expect(out).toContain('esc to cancel');
  });

  it('submitting reply text prompts the EXISTING session over the wire rpc, not createSession', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(SPACE);
    b.view().dispatch.editor.onSubmit?.('here is more context');
    await flush();
    expect(b.fake.wirePrompt).toHaveBeenCalledWith({
      sessionId: 's1',
      input: [{ type: 'text', text: 'here is more context' }],
    });
    expect(b.fake.createSession).not.toHaveBeenCalled();
    // Reply mode unwinds back to the "new session" composer on submit.
    expect(b.view().replyTargetId).toBeUndefined();
    expect(b.view().dispatchFocused).toBe(false);
    expect(b.view().dispatch.editor.placeholder).toBe('describe a task for a new session');
  });

  it('a non-wire transport flashes an error and never falls back to creating a new session', async () => {
    const b = await boot([summary('s1')]); // no wire
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(SPACE);
    b.view().dispatch.editor.onSubmit?.('here is more context');
    await flush();
    expect(b.fake.createSession).not.toHaveBeenCalled();
    expect(b.render()).toContain('requires the wire transport');
    expect(b.view().replyTargetId).toBeUndefined();
    b.controller.close(); // clear the pending flash timer
  });

  it('Esc during reply mode exits back to the dispatch composer without submitting', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(SPACE);
    b.component().handleInput(ESC);
    expect(b.view().replyTargetId).toBeUndefined();
    expect(b.view().dispatchFocused).toBe(false);
    expect(b.view().dispatch.editor.placeholder).toBe('describe a task for a new session');
    expect(b.fake.wirePrompt).not.toHaveBeenCalled();
  });

  it('a parse error during reply mode also exits reply mode instead of leaving it stuck', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(SPACE);
    b.view().dispatch.editor.onSubmit?.('ab'); // too short
    await flush();
    expect(b.view().replyTargetId).toBeUndefined();
    expect(b.render()).toContain('Too short — describe the task');
    b.controller.close(); // clear the pending flash timer
  });

  it('after a reply submit, a subsequent plain submission creates a NEW session (round-trip proof)', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(SPACE);
    b.view().dispatch.editor.onSubmit?.('reply text here');
    await flush();
    b.view().dispatch.editor.onSubmit?.('a brand new task');
    await flush();
    expect(b.fake.createSession).toHaveBeenCalledWith({ workDir: '/home/user/project' });
    expect(b.fake.createdSession.prompt).toHaveBeenCalledWith('a brand new task');
  });

  it('space on a group header does not enter reply mode — falls through into the composer as a character', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    // selection starts on the Completed group header
    b.component().handleInput(SPACE);
    expect(b.view().replyTargetId).toBeUndefined();
    expect(b.view().dispatchFocused).toBe(true);
    expect(b.view().dispatch.editor.getText()).toBe(' ');
  });

  it('space on a row clears a pending delete confirm', async () => {
    const b = await boot([summary('s1'), summary('s2')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN); // s1
    b.component().handleInput(CTRL_X);
    expect(b.view().confirmDeleteId).toBe('s1');
    b.component().handleInput(SPACE);
    expect(b.view().confirmDeleteId).toBeUndefined();
  });
});

// ── Workspace trust lookup on show() → roster badge ──

describe('AgentsViewController — workspace trust', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) {
      // maxRetries: a fire-and-forget persistState can still be mid-write
      // (ENOTEMPTY on rmdir) when the test body returns.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
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
    if (dir !== undefined) {
      // maxRetries: a fire-and-forget persistState can still be mid-write
      // (ENOTEMPTY on rmdir) when the test body returns.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    dir = undefined;
  });

  it('show mounts the dispatch editor into the bottom area, list-focused', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    expect(b.view().dispatchFocused).toBe(false);
    // The mounted CustomEditor renders its rule-only frame with the `❯` prompt.
    const out = b.render();
    expect(out).toContain('─'.repeat(20));
    expect(out).toContain('❯');
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
    if (dir !== undefined) {
      // maxRetries: a fire-and-forget persistState can still be mid-write
      // (ENOTEMPTY on rmdir) when the test body returns.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
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
    if (dir !== undefined) {
      // maxRetries: a fire-and-forget persistState can still be mid-write
      // (ENOTEMPTY on rmdir) when the test body returns.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
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
    if (dir !== undefined) {
      // maxRetries: a fire-and-forget persistState can still be mid-write
      // (ENOTEMPTY on rmdir) when the test body returns.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
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
    if (dir !== undefined) {
      // maxRetries: a fire-and-forget persistState can still be mid-write
      // (ENOTEMPTY on rmdir) when the test body returns.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
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
    expect(out).toContain('Needs input');
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
    if (dir !== undefined) {
      // maxRetries: a fire-and-forget persistState can still be mid-write
      // (ENOTEMPTY on rmdir) when the test body returns.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    dir = undefined;
  });

  it('a WS reconnect re-seeds the roster from a fresh session list', async () => {
    const b = await boot([summary('s1')], { wire: true, rows: [wireRow('s1', { busy: true })] });
    dir = b.homeDir;
    await flush(); // the one-shot trust load settles
    expect(b.view().roster.get('s1')?.busy).toBe(true);
    expect(b.view().roster.get('s1')?.trusted).toBe(true);

    // During the drop s1's turn finished — the global event was lost (no
    // journal), so the reconnect re-list must surface it. s2 was created by
    // ANOTHER client during the drop: it is not in this view's registry and
    // must stay out of the roster.
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
    expect(b.view().roster.get('s2')).toBeUndefined();
    const out = b.render();
    expect(out).not.toContain('s2 title');
    expect(out).toContain('Completed');
  });

  it('a disconnect does not re-list; a row vanished during the drop drops its selection', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    b.component().handleInput(DOWN); // select s1
    expect(b.view().selectedId).toBe('s1');
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
