import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Event, KimiHarness, Session, SessionSummary, WireSession } from '@moonshot-ai/kimi-code-sdk';
import { SDKRpcClientWire } from '@moonshot-ai/kimi-code-sdk';
import type { Component, Container, ProcessTerminal, Terminal, TUI } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAgentsViewState, saveAgentsViewState } from '@/tui/agents/roster-persistence';
import type { ArgCompletionSpec } from '@/tui/commands/complete-args';
import type { AgentsViewApp } from '@/tui/components/agents-view/app';
import type { CustomEditor } from '@/tui/components/editor/custom-editor';
import {
  AgentsViewController,
  dispatchSlashCommands,
  hintDeferredPermissionOnce,
  replyRpcTimeoutMs,
  type AgentsViewHost,
  type AgentsViewState,
} from '@/tui/controllers/agents-view';
import {
  AgentsViewDispatch,
  parseDispatchInput,
  parseReplyInput,
  type DispatchActivatableCommands,
} from '@/tui/controllers/agents-view-dispatch';
import { currentTheme } from '@/tui/theme';
import { EXIT_CONFIRM_WINDOW_MS } from '#/tui/constant/kimi-tui';

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
  createdSession: {
    id: string;
    prompt: ReturnType<typeof vi.fn>;
    activateSkill: ReturnType<typeof vi.fn>;
    activatePluginCommand: ReturnType<typeof vi.fn>;
  };
  // Explicitly Promise-returning (not the bare `ReturnType<typeof vi.fn>`
  // other fields use): several tests below feed `mockImplementationOnce` a
  // `() => new Promise(...)` to control settlement timing by hand, and the
  // untyped default resolves `mockImplementationOnce`'s parameter to a
  // void-returning signature, which no-misused-promises then flags as a
  // Promise where a void return was expected.
  wirePrompt: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<void>>> | undefined;
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
  const createdSession = {
    id: 'new-session',
    prompt: vi.fn(async () => {}),
    activateSkill: vi.fn(async () => {}),
    activatePluginCommand: vi.fn(async () => {}),
  };
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
    /** Stubbed `/model` argument-completion candidates; defaults to a small fixed pair. */
    modelCompletions?: readonly ArgCompletionSpec[];
    /** Stubbed skill/plugin-command menu entries + activation maps; defaults to empty (cold-start). */
    activatableCommands?: DispatchActivatableCommands;
    /**
     * What `agentsViewActivatableCommands()` returns AFTER
     * `warmAgentsViewSkillMenu()` resolves — simulates the real
     * `KimiTUI`'s cache mutating in place once `listWorkspaceSkills`
     * lands. `undefined` (the default) simulates a warm that finds
     * nothing new: `activatableCommands` stays in effect, matching the
     * real host's no-op-on-failure/no-op-if-already-warmed behavior.
     */
    warmedActivatableCommands?: DispatchActivatableCommands;
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
  let currentActivatable = opts.activatableCommands ?? EMPTY_ACTIVATABLE;
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
    agentsViewModelCompletions: () =>
      opts.modelCompletions ?? [
        { value: 'kimi-latest', description: 'Kimi Latest' },
        { value: 'kimi-thinking', description: 'Kimi Thinking' },
      ],
    agentsViewActivatableCommands: () => currentActivatable,
    warmAgentsViewSkillMenu: async () => {
      if (opts.warmedActivatableCommands !== undefined) currentActivatable = opts.warmedActivatableCommands;
    },
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
const CTRL_C = '\u0003';
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

describe('AgentsViewController — Ctrl+C two-stage exit confirm (fix round 1)', () => {
  // The arm/quit/auto-disarm state machine lives HERE, not on the
  // component — the component has no `state.ui` access, so only the
  // controller can force a repaint when the window elapses with no further
  // keypress. That autonomous-repaint requirement is the actual regression
  // under review (agents-view.test.ts covers the render-given-props half:
  // the component showing the right footer text for a given
  // `pendingExitArmed`/counts combination).
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    dir = undefined;
  });

  it('a first Ctrl+C arms pendingExitTimer, pushes a render, and shows the footer hint', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.ui.requestRender.mockClear();
    b.component().handleInput(CTRL_C);
    expect(b.view().pendingExitTimer).toBeDefined();
    expect(b.ui.requestRender).toHaveBeenCalled();
    expect(b.render()).toContain('Press Ctrl+C again to exit');
  });

  it('a second Ctrl+C within the window closes the view', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(CTRL_C);
    b.component().handleInput(CTRL_C);
    expect(b.controller.isOpen).toBe(false);
  });

  it('the window elapsing with zero further input still clears the timer AND triggers an autonomous repaint — the actual regression under review', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    vi.useFakeTimers();
    try {
      b.component().handleInput(CTRL_C);
      expect(b.view().pendingExitTimer).toBeDefined();
      b.ui.requestRender.mockClear();

      // No handleInput, no other action between arming and here — this is
      // exactly the "wait with no further input" scenario the spec's live
      // capture requires and the original component-local timer couldn't
      // deliver (Container.invalidate() on a childless component is a
      // no-op; nothing else in this codebase repaints without an explicit
      // requestRender call).
      vi.advanceTimersByTime(EXIT_CONFIRM_WINDOW_MS + 1);

      expect(b.view().pendingExitTimer).toBeUndefined();
      expect(b.ui.requestRender).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a later Ctrl+C after the window elapsed re-arms instead of quitting', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    vi.useFakeTimers();
    try {
      b.component().handleInput(CTRL_C);
      vi.advanceTimersByTime(EXIT_CONFIRM_WINDOW_MS + 1);
      b.component().handleInput(CTRL_C);
      expect(b.controller.isOpen).toBe(true);
      expect(b.view().pendingExitTimer).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a pending delete confirm still absorbs a confirming second Ctrl+C as a cancel, matching onQuit', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN); // onto row s1
    b.component().handleInput(CTRL_X); // arm delete-confirm on the selected row
    expect(b.view().confirmDeleteId).toBe('s1');
    b.component().handleInput(CTRL_C); // arms the exit hint
    b.component().handleInput(CTRL_C); // confirming press
    expect(b.controller.isOpen).toBe(true);
    expect(b.view().confirmDeleteId).toBeUndefined();
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

  it('deleting a row clears its pendingReplyIds/replyFailures/replyAttempts/replyBarriers entries, including group-delete', async () => {
    const b = await boot([summary('s1'), summary('s2')]);
    dir = b.homeDir;
    // Leftover bookkeeping a stuck/failed reply would have left behind.
    b.view().pendingReplyIds.add('s1');
    b.view().replyFailures.set('s1', { text: 'never sent' });
    b.view().replyAttempts.set('s1', new Promise<void>(() => {}));
    b.view().replyBarriers.set('s1', new Promise<void>(() => {}));
    b.view().pendingReplyIds.add('s2');
    b.view().replyFailures.set('s2', { text: 'also never sent' });
    b.view().replyAttempts.set('s2', new Promise<void>(() => {}));
    b.view().replyBarriers.set('s2', new Promise<void>(() => {}));

    // selection starts on the Completed group header — archives both rows.
    b.component().handleInput(CTRL_X);
    b.component().handleInput(CTRL_X);
    await flush();

    expect(b.view().pendingReplyIds.has('s1')).toBe(false);
    expect(b.view().replyFailures.has('s1')).toBe(false);
    expect(b.view().replyAttempts.has('s1')).toBe(false);
    expect(b.view().replyBarriers.has('s1')).toBe(false);
    expect(b.view().pendingReplyIds.has('s2')).toBe(false);
    expect(b.view().replyFailures.has('s2')).toBe(false);
    expect(b.view().replyAttempts.has('s2')).toBe(false);
    expect(b.view().replyBarriers.has('s2')).toBe(false);
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

  it('collapsing a group header through the real buildProps chain shows its hidden count on the same line, expanding drops it again', async () => {
    // Same round trip as above, but asserts on the count — driven through
    // the actual controller (buildProps → renderItem → renderGroupHeader),
    // not a hand-built AgentsGroup fixture like the component-level test.
    const b = await boot([summary('s1')]);
    dir = b.homeDir;

    b.component().handleInput(ENTER); // collapse
    const collapsedLines = b.render().split('\n');
    const collapsedHeaderIdx = collapsedLines.findIndex((l) => l.includes('Completed'));
    expect(collapsedLines[collapsedHeaderIdx]).toContain('Completed (1)');
    // The count must land on the header's own line, never wrapped onto the
    // next one.
    expect(collapsedLines[collapsedHeaderIdx + 1]?.trim()).not.toMatch(/^\d/);

    b.component().handleInput(ENTER); // re-expand
    const expandedLines = b.render().split('\n');
    const expandedHeaderIdx = expandedLines.findIndex((l) => l.includes('Completed'));
    expect(expandedLines[expandedHeaderIdx]).not.toContain('(1)');
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

/** No skills/plugin commands cached — the common case for tests that don't
 *  exercise staged activation. */
const EMPTY_ACTIVATABLE: DispatchActivatableCommands = {
  commands: [],
  skillCommandMap: new Map(),
  pluginCommandMap: new Map(),
};

describe('parseDispatchInput', () => {
  it('plain text passes through as-is (trimmed)', () => {
    expect(parseDispatchInput('fix the flaky test', EMPTY_ACTIVATABLE)).toEqual({
      text: 'fix the flaky test',
    });
    expect(parseDispatchInput('  fix the flaky test  ', EMPTY_ACTIVATABLE)).toEqual({
      text: 'fix the flaky test',
    });
  });

  it('a /model prefix stages the model and keeps the rest as text', () => {
    expect(parseDispatchInput('/model kimi-k2 fix the flaky test', EMPTY_ACTIVATABLE)).toEqual({
      text: 'fix the flaky test',
      model: 'kimi-k2',
    });
  });

  it('a /agent prefix stages the profile and keeps the rest as text', () => {
    expect(parseDispatchInput('/agent reviewer fix the flaky test', EMPTY_ACTIVATABLE)).toEqual({
      text: 'fix the flaky test',
      profile: 'reviewer',
    });
  });

  it('collapses extra whitespace around the staged argument', () => {
    expect(parseDispatchInput('/model   kimi-k2   fix the flaky test', EMPTY_ACTIVATABLE)).toEqual({
      text: 'fix the flaky test',
      model: 'kimi-k2',
    });
  });

  it('any other slash command that is not a known skill/plugin command is rejected as session-only', () => {
    expect(parseDispatchInput('/yolo fix the flaky test', EMPTY_ACTIVATABLE)).toEqual({
      error: '"/yolo" is only available inside a session',
    });
    expect(parseDispatchInput('/help', EMPTY_ACTIVATABLE)).toEqual({
      error: '"/help" is only available inside a session',
    });
    expect(parseDispatchInput('/modelx fix the flaky test', EMPTY_ACTIVATABLE)).toEqual({
      error: '"/modelx" is only available inside a session',
    });
  });

  it('a slash token mid-text is plain text, not a command', () => {
    expect(parseDispatchInput('fix /model handling', EMPTY_ACTIVATABLE)).toEqual({
      text: 'fix /model handling',
    });
  });

  it('rejects empty and too-short input', () => {
    expect(parseDispatchInput('', EMPTY_ACTIVATABLE)).toEqual({ error: 'Too short — describe the task' });
    expect(parseDispatchInput('   ', EMPTY_ACTIVATABLE)).toEqual({
      error: 'Too short — describe the task',
    });
    expect(parseDispatchInput('ab', EMPTY_ACTIVATABLE)).toEqual({
      error: 'Too short — describe the task',
    });
    expect(parseDispatchInput('a b', EMPTY_ACTIVATABLE)).toEqual({
      error: 'Too short — describe the task',
    });
  });

  it('counts non-space characters for the minimum length', () => {
    expect(parseDispatchInput('a b c', EMPTY_ACTIVATABLE)).toEqual({ text: 'a b c' });
  });

  it('/model or /agent alone (no argument) gets a command-specific usage hint, not the generic too-short message', () => {
    expect(parseDispatchInput('/model', EMPTY_ACTIVATABLE)).toEqual({
      error: '/model needs a model alias and a task — /model <alias> <task>',
    });
    expect(parseDispatchInput('/agent', EMPTY_ACTIVATABLE)).toEqual({
      error: '/agent needs a profile name and a task — /agent <profile> <task>',
    });
  });

  it('a staged /model or /agent WITH an argument but no task text still falls to the generic too-short message', () => {
    expect(parseDispatchInput('/model kimi-k2', EMPTY_ACTIVATABLE)).toEqual({
      error: 'Too short — describe the task',
    });
    expect(parseDispatchInput('/agent reviewer', EMPTY_ACTIVATABLE)).toEqual({
      error: 'Too short — describe the task',
    });
  });

  describe('staged skill/plugin-command activation', () => {
    const activatable: DispatchActivatableCommands = {
      commands: [],
      skillCommandMap: new Map([
        ['reviewcode', 'reviewcode'], // builtin/sub-skill: bare name is canonical
        ['skill:standup-notes', 'standup-notes'], // project/user/extra: skill:-prefixed
      ]),
      pluginCommandMap: new Map([['myplugin:mycommand', 'plugin command body']]),
    };

    it('a bare-name skill command (builtin/sub-skill) stages a skill activation', () => {
      expect(parseDispatchInput('/reviewcode', activatable)).toEqual({
        text: '',
        activation: { kind: 'skill', skillName: 'reviewcode', args: '' },
      });
    });

    it('a skill:-prefixed skill command stages a skill activation with that exact prefix, matching main-chat naming', () => {
      expect(parseDispatchInput('/skill:standup-notes yesterday and today', activatable)).toEqual({
        text: '',
        activation: { kind: 'skill', skillName: 'standup-notes', args: 'yesterday and today' },
      });
    });

    it('a skill registered under its skill:-prefixed name still resolves when typed bare, same as the main chat', () => {
      expect(parseDispatchInput('/standup-notes something', activatable)).toEqual({
        text: '',
        activation: { kind: 'skill', skillName: 'standup-notes', args: 'something' },
      });
    });

    it('a plugin command stages a plugin-command activation, splitting pluginId:commandName', () => {
      expect(parseDispatchInput('/myplugin:mycommand do the thing', activatable)).toEqual({
        text: '',
        activation: {
          kind: 'plugin-command',
          pluginId: 'myplugin',
          commandName: 'mycommand',
          args: 'do the thing',
        },
      });
    });

    it('skill/plugin activation args carry no minimum length — a bare activation with no args is valid', () => {
      expect(parseDispatchInput('/myplugin:mycommand', activatable)).toEqual({
        text: '',
        activation: {
          kind: 'plugin-command',
          pluginId: 'myplugin',
          commandName: 'mycommand',
          args: '',
        },
      });
    });

    it('an unknown command name still falls through to the session-only rejection, even with a non-empty activatable set', () => {
      expect(parseDispatchInput('/not-a-real-command fix it', activatable)).toEqual({
        error: '"/not-a-real-command" is only available inside a session',
      });
    });
  });
});

describe('parseReplyInput', () => {
  it('a leading /model or /agent is literal text, not a staged override — the bug this guards', () => {
    expect(parseReplyInput('/model foo hello there')).toEqual({ text: '/model foo hello there' });
    expect(parseReplyInput('/agent reviewer hello there')).toEqual({ text: '/agent reviewer hello there' });
  });

  it('any other leading slash is also literal text, not a session-only rejection', () => {
    expect(parseReplyInput('/yolo fix the flaky test')).toEqual({ text: '/yolo fix the flaky test' });
  });

  it('plain text passes through completely unmodified — no trim of its own', () => {
    expect(parseReplyInput('fix the flaky test')).toEqual({ text: 'fix the flaky test' });
  });

  it('still rejects empty and too-short input with the same message as dispatch mode', () => {
    expect(parseReplyInput('')).toEqual({ error: 'Too short — describe the task' });
    expect(parseReplyInput('   ')).toEqual({ error: 'Too short — describe the task' });
    expect(parseReplyInput('ab')).toEqual({ error: 'Too short — describe the task' });
  });
});

describe('AgentsViewDispatch — editor wiring', () => {
  function makeDispatch(activatable: DispatchActivatableCommands = EMPTY_ACTIVATABLE): AgentsViewDispatch {
    const tui = {
      requestRender: vi.fn(),
      render: vi.fn(() => []),
      terminal: { rows: 40, cols: 120 },
    } as unknown as TUI;
    return new AgentsViewDispatch(tui, '/home/user/project', () => activatable);
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

  it('exit or /exit in dispatch mode fires onExit instead of onSubmit/onError', () => {
    const dispatch = makeDispatch();
    const onSubmit = vi.fn();
    const onError = vi.fn();
    const onExit = vi.fn();
    dispatch.onSubmit = onSubmit;
    dispatch.onError = onError;
    dispatch.onExit = onExit;

    dispatch.editor.onSubmit?.('exit');
    expect(onExit).toHaveBeenCalledTimes(1);
    dispatch.editor.onSubmit?.('/exit');
    expect(onExit).toHaveBeenCalledTimes(2);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('exit is an exact match — surrounding text still dispatches or errors normally', () => {
    const dispatch = makeDispatch();
    const onSubmit = vi.fn();
    const onExit = vi.fn();
    dispatch.onSubmit = onSubmit;
    dispatch.onExit = onExit;

    dispatch.editor.onSubmit?.('please exit the sandbox setup task');
    expect(onExit).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledWith({ text: 'please exit the sandbox setup task' });
  });

  it('exit/Exit while replying is sent as literal reply text, not intercepted', () => {
    const dispatch = makeDispatch();
    dispatch.replying = true;
    const onSubmit = vi.fn();
    const onExit = vi.fn();
    dispatch.onSubmit = onSubmit;
    dispatch.onExit = onExit;

    dispatch.editor.onSubmit?.('exit');
    expect(onExit).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledWith({ text: 'exit' });
    dispatch.editor.onSubmit?.('/exit');
    expect(onExit).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledWith({ text: '/exit' });
  });

  it('installAutocomplete suggests only the installed commands — no /help', async () => {
    const dispatch = makeDispatch();
    dispatch.installAutocomplete(dispatchSlashCommands(() => [], () => EMPTY_ACTIVATABLE));
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
    expect(suggestions?.items.map((item) => item.value).toSorted()).toEqual(['agent', 'model']);
  });

  it('the dispatch whitelist is /model from the builtins plus a local /agent — no /help', () => {
    const commands = dispatchSlashCommands(() => [], () => EMPTY_ACTIVATABLE);
    expect(commands.map((command) => command.name).toSorted()).toEqual(['agent', 'model']);
    const agent = commands.find((command) => command.name === 'agent');
    expect(agent?.description).toBeTruthy();
  });

  it('/model argument completion surfaces the supplied model candidates', async () => {
    const dispatch = makeDispatch();
    dispatch.installAutocomplete(
      dispatchSlashCommands(
        () => [
          { value: 'kimi-latest', description: 'Kimi Latest' },
          { value: 'kimi-thinking', description: 'Kimi Thinking' },
        ],
        () => EMPTY_ACTIVATABLE,
      ),
    );
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
    const suggestions = await provider.getSuggestions(['/model kimi'], 0, 11, {
      signal: new AbortController().signal,
    });
    expect(suggestions?.items.map((item) => item.value).toSorted()).toEqual([
      'kimi-latest',
      'kimi-thinking',
    ]);
  });

  it('/agent has no argument completer — the whitelist item ships with completeArgs unset', () => {
    const commands = dispatchSlashCommands(() => [], () => EMPTY_ACTIVATABLE);
    const agent = commands.find((command) => command.name === 'agent');
    expect(agent?.completeArgs).toBeUndefined();
  });

  it('an editor submission for a known skill command forwards a skill activation to onSubmit, not a literal-text prompt', () => {
    const activatable: DispatchActivatableCommands = {
      commands: [],
      skillCommandMap: new Map([['skill:reviewcode', 'reviewcode']]),
      pluginCommandMap: new Map(),
    };
    const dispatch = makeDispatch(activatable);
    const onSubmit = vi.fn();
    dispatch.onSubmit = onSubmit;
    dispatch.editor.onSubmit?.('/skill:reviewcode check the auth module');
    expect(onSubmit).toHaveBeenCalledWith({
      text: '',
      activation: { kind: 'skill', skillName: 'reviewcode', args: 'check the auth module' },
    });
  });

  it('an editor submission for a known plugin command forwards a plugin-command activation to onSubmit', () => {
    const activatable: DispatchActivatableCommands = {
      commands: [],
      skillCommandMap: new Map(),
      pluginCommandMap: new Map([['myplugin:mycommand', 'body']]),
    };
    const dispatch = makeDispatch(activatable);
    const onSubmit = vi.fn();
    dispatch.onSubmit = onSubmit;
    dispatch.editor.onSubmit?.('/myplugin:mycommand do the thing');
    expect(onSubmit).toHaveBeenCalledWith({
      text: '',
      activation: {
        kind: 'plugin-command',
        pluginId: 'myplugin',
        commandName: 'mycommand',
        args: 'do the thing',
      },
    });
  });

  it('menu sourcing includes every skill and plugin command supplied, using the exact entries given — no relabeling', () => {
    const dispatch = makeDispatch();
    const skillEntry = { name: 'skill:reviewcode', aliases: [], description: 'Review code changes' };
    const pluginEntry = { name: 'myplugin:mycommand', aliases: [], description: 'Run my command' };
    dispatch.installAutocomplete(
      dispatchSlashCommands(
        () => [],
        () => ({
          commands: [skillEntry, pluginEntry],
          skillCommandMap: new Map(),
          pluginCommandMap: new Map(),
        }),
      ),
    );
    const provider = (
      dispatch.editor as unknown as {
        autocompleteProvider: {
          getSuggestions(
            lines: string[],
            cursorLine: number,
            cursorCol: number,
            options: { signal: AbortSignal },
          ): Promise<{ items: { value: string; description?: string }[] } | null>;
        };
      }
    ).autocompleteProvider;
    return provider.getSuggestions(['/'], 0, 1, { signal: new AbortController().signal }).then((suggestions) => {
      expect(suggestions?.items.map((item) => item.value).toSorted()).toEqual([
        'agent',
        'model',
        'myplugin:mycommand',
        'skill:reviewcode',
      ]);
    });
  });

  it('the menu never offers exit, quit, or q — those stay on the separate literal-text EXIT_COMMANDS path', async () => {
    const dispatch = makeDispatch();
    // A skill/plugin command deliberately named like the exit aliases would
    // be a pathological fixture, not a realistic one — this test instead
    // asserts against the REAL whitelist builder, which only ever draws from
    // BUILTIN_SLASH_COMMANDS (filtered to just `model`) plus the dispatch-
    // local `/agent` item plus whatever skill/plugin commands are supplied;
    // `exit` (and its aliases `quit`/`q`) are never in that builtin filter.
    dispatch.installAutocomplete(
      dispatchSlashCommands(
        () => [],
        () => ({
          commands: [{ name: 'skill:reviewcode', aliases: [], description: 'Review code' }],
          skillCommandMap: new Map(),
          pluginCommandMap: new Map(),
        }),
      ),
    );
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
    const names = suggestions?.items.map((item) => item.value) ?? [];
    expect(names).not.toContain('exit');
    expect(names).not.toContain('quit');
    expect(names).not.toContain('q');
  });

  it('empty skill/plugin caches (cold-start gap) leave the menu at exactly model + agent, no crash', async () => {
    const dispatch = makeDispatch();
    dispatch.installAutocomplete(dispatchSlashCommands(() => [], () => EMPTY_ACTIVATABLE));
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
    expect(suggestions?.items.map((item) => item.value).toSorted()).toEqual(['agent', 'model']);
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
  // does (`installAutocomplete(dispatchSlashCommands(...))` against a real
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
    const dispatch = new AgentsViewDispatch(tui, workDir, () => EMPTY_ACTIVATABLE);
    dispatch.installAutocomplete(dispatchSlashCommands(() => [], () => EMPTY_ACTIVATABLE));

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

  it('a skill command stages an activateSkill call — never a literal-text Session.prompt', async () => {
    const b = await boot([summary('s1')], {
      activatableCommands: {
        commands: [],
        skillCommandMap: new Map([['skill:reviewcode', 'reviewcode']]),
        pluginCommandMap: new Map(),
      },
    });
    dir = b.homeDir;
    b.view().dispatch.editor.onSubmit?.('/skill:reviewcode check the auth module');
    await flush();
    expect(b.fake.createSession).toHaveBeenCalledWith({ workDir: '/home/user/project' });
    expect(b.fake.createdSession.activateSkill).toHaveBeenCalledWith(
      'reviewcode',
      'check the auth module',
    );
    expect(b.fake.createdSession.prompt).not.toHaveBeenCalled();
  });

  it('a plugin command stages an activatePluginCommand call — never a literal-text Session.prompt', async () => {
    const b = await boot([summary('s1')], {
      activatableCommands: {
        commands: [],
        skillCommandMap: new Map(),
        pluginCommandMap: new Map([['myplugin:mycommand', 'body']]),
      },
    });
    dir = b.homeDir;
    b.view().dispatch.editor.onSubmit?.('/myplugin:mycommand do the thing');
    await flush();
    expect(b.fake.createSession).toHaveBeenCalledWith({ workDir: '/home/user/project' });
    expect(b.fake.createdSession.activatePluginCommand).toHaveBeenCalledWith(
      'myplugin',
      'mycommand',
      'do the thing',
    );
    expect(b.fake.createdSession.prompt).not.toHaveBeenCalled();
  });

  it('a cold view (no prior attach) offers skill commands once the host warms them — the plugin section stays empty, undisturbed by the warm', async () => {
    const b = await boot([summary('s1')], {
      // Cold-start: nothing warmed yet — matches a fresh `kimi agents`
      // launch with no session attached this run.
      activatableCommands: EMPTY_ACTIVATABLE,
      // What `KimiTUI.warmAgentsViewSkillMenu()` leaves behind once
      // `listWorkspaceSkills` lands: skills only — the plugin half of the
      // cold-start gap has no session-independent route to close it, so a
      // real warm never touches plugin fields either.
      warmedActivatableCommands: {
        commands: [{ name: 'skill:reviewcode', aliases: [], description: 'Review code changes' }],
        skillCommandMap: new Map([['skill:reviewcode', 'reviewcode']]),
        pluginCommandMap: new Map(),
      },
    });
    dir = b.homeDir;
    const editor = b.view().dispatch.editor;
    const provider = (
      editor as unknown as {
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

    await flush();

    const suggestions = await provider.getSuggestions(['/'], 0, 1, { signal: new AbortController().signal });
    const names = suggestions?.items.map((item) => item.value).toSorted() ?? [];
    expect(names).toEqual(['agent', 'model', 'skill:reviewcode']);
    // No plugin-command entry appeared — only the skill half of the gap
    // closed.
    expect(names.some((name) => name.includes(':') && !name.startsWith('skill:'))).toBe(false);
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

  it('space on a row opens the reply panel — placeholder and footer switch to the panel state (empty input)', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(SPACE);
    expect(b.view().replyTargetId).toBe('s1');
    expect(b.view().dispatchFocused).toBe(true);
    expect(b.view().dispatch.editor.focused).toBe(true);
    expect(b.view().dispatch.editor.placeholder).toBe('reply');
    const out = b.render();
    // Bordered panel chrome, plus the empty-input footer state.
    expect(out).toContain('╭');
    expect(out).toContain('╰');
    expect(out).toContain('enter to open');
    expect(out).toContain('space to close');
    expect(out).toContain('ctrl+x to delete');
  });

  it('typing in the panel switches the footer to the non-empty state', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(SPACE);
    b.view().dispatch.editor.setText('here is more context');
    const out = b.render();
    expect(out).toContain('enter to send');
    expect(out).toContain('esc to close');
    expect(out).toContain('ctrl+x to delete');
    expect(out).not.toContain('enter to open');
  });

  it("the panel shows the row's latest assistant output and a relative-age line", async () => {
    // No `wire: true`: the roster seeds from `listSessions` (plain
    // `SessionSummary`), which carries `lastAssistantText`/`updatedAt`
    // straight through — the wire-row seeding path used elsewhere in this
    // file only forwards `id`/`title` by default (see `makeHarness`), which
    // would lose the very fields this test is about.
    const b = await boot([summary('s1', { lastAssistantText: 'the answer is 42', updatedAt: Date.now() })]);
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(SPACE);
    const out = b.render();
    expect(out).toContain('the answer is 42');
    expect(out).toContain('just now');
  });

  it('the panel falls back to the initial prompt when no assistant output exists yet', async () => {
    const b = await boot([summary('s1', { lastPrompt: 'please investigate the outage' })]);
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(SPACE);
    expect(b.render()).toContain('please investigate the outage');
  });

  it('space closes the panel again with an empty input — symmetric toggle', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(SPACE); // open
    expect(b.view().replyTargetId).toBe('s1');
    b.component().handleInput(SPACE); // close (empty input)
    expect(b.view().replyTargetId).toBeUndefined();
    expect(b.view().dispatchFocused).toBe(false);
  });

  it('space with a non-empty input is an ordinary character, not a close', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(SPACE); // open
    b.view().dispatch.editor.setText('fix');
    b.component().handleInput(SPACE);
    expect(b.view().replyTargetId).toBe('s1'); // still open
    expect(b.view().dispatch.editor.getText()).toBe('fix ');
  });

  it('Esc discards an unsent draft, not just closes the panel', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(SPACE);
    b.view().dispatch.editor.setText('never sent');
    b.component().handleInput(ESC);
    expect(b.view().replyTargetId).toBeUndefined();
    expect(b.view().dispatch.editor.getText()).toBe('');
  });

  it('Enter with an empty input closes the panel and attaches to the session', async () => {
    const onOpenSession = vi.fn();
    const b = await boot([summary('s1')], { wire: true, onOpenSession });
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(SPACE);
    b.component().handleInput(ENTER);
    expect(b.view().replyTargetId).toBeUndefined();
    expect(b.view().dispatchFocused).toBe(false);
    expect(onOpenSession).toHaveBeenCalledWith('s1');
    expect(b.fake.wirePrompt).not.toHaveBeenCalled();
  });

  it('Ctrl+X closes the panel and starts the existing delete-confirm flow for that row', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(SPACE);
    b.component().handleInput(CTRL_X);
    expect(b.view().replyTargetId).toBeUndefined();
    expect(b.view().dispatchFocused).toBe(false);
    expect(b.view().confirmDeleteId).toBe('s1');
    // Second Ctrl+X (list-focused now) confirms the delete, same as the
    // ordinary row flow.
    b.component().handleInput(CTRL_X);
    await flush();
    expect(b.fake.deleteSession).toHaveBeenCalledWith('s1');
  });

  it('↑/↓ close the panel and move the roster selection instead of navigating inside it', async () => {
    const b = await boot([summary('s1'), summary('s2')], { wire: true });
    dir = b.homeDir;
    b.component().handleInput(DOWN); // s1 (only completed row visible first)
    b.component().handleInput(SPACE);
    expect(b.view().replyTargetId).toBe('s1');
    b.component().handleInput(DOWN);
    expect(b.view().replyTargetId).toBeUndefined();
    expect(b.view().dispatchFocused).toBe(false);
    expect(b.view().selectedId).toBe('s2');
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

  it('a reply shows a pending send state on the row until the RPC settles, then clears it — never the busy spinner', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    let resolvePrompt: (() => void) | undefined;
    b.fake.wirePrompt!.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        }),
    );
    b.component().handleInput(DOWN);
    b.component().handleInput(SPACE);
    b.view().dispatch.editor.onSubmit?.('here is more context');
    await flush();

    expect(b.view().pendingReplyIds.has('s1')).toBe(true);
    // The pending glyph is distinct from the busy spinner — the row is not
    // yet acknowledged, so it must not read as "the agent is responding".
    expect(b.render()).toContain('○');

    resolvePrompt?.();
    await flush();

    expect(b.view().pendingReplyIds.has('s1')).toBe(false);
    expect(b.view().replyFailures.has('s1')).toBe(false);
  });

  it('a rejected reply persists a failure state on the row, and re-entering reply mode restores the lost text', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    b.fake.wirePrompt!.mockRejectedValueOnce(new Error('network down'));
    b.component().handleInput(DOWN);
    b.component().handleInput(SPACE);
    b.view().dispatch.editor.onSubmit?.('here is more context');
    await flush();

    expect(b.view().pendingReplyIds.has('s1')).toBe(false);
    expect(b.view().replyFailures.get('s1')).toEqual({ text: 'here is more context' });
    expect(b.render()).toContain('reply failed');

    // Re-entering reply mode on the failed row (space again) restores the
    // lost text and clears the persistent failure — no retyping.
    b.component().handleInput(SPACE);
    expect(b.view().replyTargetId).toBe('s1');
    expect(b.view().dispatch.editor.getText()).toBe('here is more context');
    expect(b.view().replyFailures.has('s1')).toBe(false);

    b.controller.close(); // clear the pending flash timer
  });

  it('a reply exceeding the bounded client-side wait shows the same persistent failure state, without waiting for the underlying RPC', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    // Never resolves within the test — the resume/materialize chain hang
    // this timeout guards against.
    b.fake.wirePrompt!.mockImplementationOnce(() => new Promise<void>(() => {}));
    vi.useFakeTimers();
    try {
      b.component().handleInput(DOWN);
      b.component().handleInput(SPACE);
      b.view().dispatch.editor.onSubmit?.('here is more context');
      await vi.advanceTimersByTimeAsync(0);
      expect(b.view().pendingReplyIds.has('s1')).toBe(true);

      const bound = replyRpcTimeoutMs();
      await vi.advanceTimersByTimeAsync(bound - 1);
      expect(b.view().pendingReplyIds.has('s1')).toBe(true);
      expect(b.view().replyFailures.has('s1')).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(b.view().pendingReplyIds.has('s1')).toBe(false);
      expect(b.view().replyFailures.get('s1')).toEqual({ text: 'here is more context' });
    } finally {
      vi.useRealTimers();
      b.controller.close(); // clear the pending flash timer
    }
  });

  it('replyRpcTimeoutMs derives from KIMI_SNAPSHOT_TIMEOUT_MS as 2× the server bound plus a fixed margin', () => {
    const previousEnv = process.env['KIMI_SNAPSHOT_TIMEOUT_MS'];
    try {
      delete process.env['KIMI_SNAPSHOT_TIMEOUT_MS'];
      const defaultBound = replyRpcTimeoutMs();
      const margin = defaultBound - 2 * 4000; // 4000 = the server-side default this mirrors
      expect(margin).toBeGreaterThan(0);

      process.env['KIMI_SNAPSHOT_TIMEOUT_MS'] = '6000';
      expect(replyRpcTimeoutMs()).toBe(2 * 6000 + margin);

      // Same fallback discipline as the server-side bounds: unparsable or
      // below-floor values fall back to the default, not to zero/NaN.
      process.env['KIMI_SNAPSHOT_TIMEOUT_MS'] = 'not-a-number';
      expect(replyRpcTimeoutMs()).toBe(defaultBound);
    } finally {
      if (previousEnv === undefined) delete process.env['KIMI_SNAPSHOT_TIMEOUT_MS'];
      else process.env['KIMI_SNAPSHOT_TIMEOUT_MS'] = previousEnv;
    }
  });

  it('a reply that succeeds AFTER the client-side bound was exceeded clears the false failure and stops showing it as failed', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    let resolvePrompt: (() => void) | undefined;
    b.fake.wirePrompt!.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        }),
    );
    vi.useFakeTimers();
    try {
      b.component().handleInput(DOWN);
      b.component().handleInput(SPACE);
      b.view().dispatch.editor.onSubmit?.('here is more context');
      await vi.advanceTimersByTimeAsync(replyRpcTimeoutMs());

      // The bound already fired: the row shows a false failure while the
      // real RPC is still outstanding.
      expect(b.view().pendingReplyIds.has('s1')).toBe(false);
      expect(b.view().replyFailures.get('s1')).toEqual({ text: 'here is more context' });

      // The legitimately-slow server now succeeds, well after the client
      // gave up.
      resolvePrompt?.();
      await vi.advanceTimersByTimeAsync(0);

      expect(b.view().replyFailures.has('s1')).toBe(false);
      expect(b.view().pendingReplyIds.has('s1')).toBe(false);
    } finally {
      vi.useRealTimers();
      b.controller.close(); // clear the pending flash timer
    }
  });

  it('a reply that rejects AFTER the client-side bound was exceeded keeps the row failed with the same recoverable text', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    let rejectPrompt: ((error: Error) => void) | undefined;
    b.fake.wirePrompt!.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPrompt = reject;
        }),
    );
    vi.useFakeTimers();
    try {
      b.component().handleInput(DOWN);
      b.component().handleInput(SPACE);
      b.view().dispatch.editor.onSubmit?.('here is more context');
      await vi.advanceTimersByTimeAsync(replyRpcTimeoutMs());
      expect(b.view().replyFailures.get('s1')).toEqual({ text: 'here is more context' });

      rejectPrompt?.(new Error('network down'));
      await vi.advanceTimersByTimeAsync(0);

      // Still failed, same recoverable text — nothing regressed by the
      // late arrival, and re-entering reply mode still recovers the text.
      expect(b.view().replyFailures.get('s1')).toEqual({ text: 'here is more context' });
      expect(b.view().pendingReplyIds.has('s1')).toBe(false);
      b.component().handleInput(SPACE);
      expect(b.view().dispatch.editor.getText()).toBe('here is more context');
    } finally {
      vi.useRealTimers();
      b.controller.close(); // clear the pending flash timer
    }
  });

  it('a late settle from a SUPERSEDED attempt does not clobber a retry already in flight for the same row', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    let resolveFirst: (() => void) | undefined;
    b.fake.wirePrompt!.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    vi.useFakeTimers();
    try {
      b.component().handleInput(DOWN);
      b.component().handleInput(SPACE);
      b.view().dispatch.editor.onSubmit?.('first attempt');
      await vi.advanceTimersByTimeAsync(replyRpcTimeoutMs());
      expect(b.view().replyFailures.get('s1')).toEqual({ text: 'first attempt' });

      // User retries — a NEW attempt for the same row, still pending.
      b.component().handleInput(SPACE);
      expect(b.view().dispatch.editor.getText()).toBe('first attempt');
      let resolveSecond: (() => void) | undefined;
      b.fake.wirePrompt!.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSecond = resolve;
          }),
      );
      b.view().dispatch.editor.onSubmit?.('second attempt');
      await vi.advanceTimersByTimeAsync(0);
      expect(b.view().pendingReplyIds.has('s1')).toBe(true);

      // The ORIGINAL (superseded) attempt now settles late — must be a
      // no-op against the retry's own in-flight state.
      resolveFirst?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(b.view().pendingReplyIds.has('s1')).toBe(true);
      expect(b.view().replyFailures.has('s1')).toBe(false);

      // The retry itself then settles normally.
      resolveSecond?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(b.view().pendingReplyIds.has('s1')).toBe(false);
      expect(b.view().replyFailures.has('s1')).toBe(false);
    } finally {
      vi.useRealTimers();
      b.controller.close(); // clear the pending flash timer
    }
  });

  // ── attach barrier: awaitPendingReply (R9 Q1a) ──

  it('awaitPendingReply resolves immediately when nothing is pending for the row', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    let settled = false;
    void b.controller.awaitPendingReply('s1').then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(true);
  });

  it('awaitPendingReply resolves once a pending reply succeeds — not before', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    let resolvePrompt: (() => void) | undefined;
    b.fake.wirePrompt!.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        }),
    );
    b.component().handleInput(DOWN);
    b.component().handleInput(SPACE);
    b.view().dispatch.editor.onSubmit?.('here is more context');
    await flush();
    expect(b.view().replyBarriers.has('s1')).toBe(true);

    let settled = false;
    void b.controller.awaitPendingReply('s1').then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    resolvePrompt?.();
    await flush();
    expect(settled).toBe(true);
    // The barrier entry is cleaned up once it settles.
    expect(b.view().replyBarriers.has('s1')).toBe(false);
  });

  it('awaitPendingReply resolves once the bounded wait gives up, even if the underlying RPC never settles', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    // Never resolves — the same permanently-hung RPC replyRpcTimeoutMs
    // guards against; awaitPendingReply must not inherit that hang.
    b.fake.wirePrompt!.mockImplementationOnce(() => new Promise<void>(() => {}));
    vi.useFakeTimers();
    try {
      b.component().handleInput(DOWN);
      b.component().handleInput(SPACE);
      b.view().dispatch.editor.onSubmit?.('here is more context');
      await vi.advanceTimersByTimeAsync(0);

      let settled = false;
      void b.controller.awaitPendingReply('s1').then(() => {
        settled = true;
      });

      const bound = replyRpcTimeoutMs();
      await vi.advanceTimersByTimeAsync(bound - 1);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
      b.controller.close(); // clear the pending flash timer
    }
  });

  it('reply text starting with /model or /agent is sent verbatim, not parsed as a dispatch override', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(SPACE);
    b.view().dispatch.editor.onSubmit?.('/model foo hello there');
    await flush();
    // The full text reaches the target session unmangled — no override
    // silently applied, no prefix silently dropped.
    expect(b.fake.wirePrompt).toHaveBeenCalledWith({
      sessionId: 's1',
      input: [{ type: 'text', text: '/model foo hello there' }],
    });
    expect(b.fake.createSession).not.toHaveBeenCalled();
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

  it('typing exit and Enter in the dispatch composer closes the view — no session created', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    for (const ch of 'exit') b.component().handleInput(ch);
    b.component().handleInput(ENTER);
    await flush();
    expect(b.controller.isOpen).toBe(false);
    expect(b.fake.createSession).not.toHaveBeenCalled();
  });

  it('typing /exit and Enter in the dispatch composer also closes the view', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    for (const ch of '/exit') b.component().handleInput(ch);
    b.component().handleInput(ENTER);
    await flush();
    expect(b.controller.isOpen).toBe(false);
    expect(b.fake.createSession).not.toHaveBeenCalled();
  });

  it('exit is an exact match — a task merely mentioning "exit" still dispatches instead of closing', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    for (const ch of 'exit the retry loop cleanly') b.component().handleInput(ch);
    b.component().handleInput(ENTER);
    await flush();
    expect(b.controller.isOpen).toBe(true);
    expect(b.fake.createSession).toHaveBeenCalledWith({ workDir: '/home/user/project' });
    expect(b.fake.createdSession.prompt).toHaveBeenCalledWith('exit the retry loop cleanly');
  });

  it('typing exit while replying sends it as a literal reply — the view stays open', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(SPACE);
    for (const ch of 'exit') b.component().handleInput(ch);
    b.component().handleInput(ENTER);
    await flush();
    expect(b.controller.isOpen).toBe(true);
    expect(b.fake.wirePrompt).toHaveBeenCalledWith({
      sessionId: 's1',
      input: [{ type: 'text', text: 'exit' }],
    });
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

  it('an armed Ctrl+C timer is cleared on detach — a quick detach-then-return within the window must not leave the hint armed or misread the next Ctrl+C as a confirming second press (fix round 1)', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(CTRL_C);
    expect(b.view().pendingExitTimer).toBeDefined();
    b.controller.detachForAttach('s1');
    expect(b.view().pendingExitTimer).toBeUndefined();
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

// ── R4 parity: origin row ("session you came from") ──

describe('AgentsViewController — return-to-view origin (isOrigin)', () => {
  // Bold-vs-plain assertions below need chalk actually emitting SGR codes —
  // the test process is not a TTY, so chalk auto-detects level 0 without
  // this. Scoped to just this describe block: this file's own `strip()`
  // (used by `boot()`'s `render()` helper throughout the rest of the file)
  // doesn't strip the leading ESC byte, so forcing color file-wide would
  // leave stray ESC characters in every other describe block's substring
  // checks.
  const previousChalkLevel = chalk.level;
  beforeAll(() => {
    chalk.level = 3;
  });
  afterAll(() => {
    chalk.level = previousChalkLevel;
  });

  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) {
      // maxRetries: a fire-and-forget persistState can still be mid-write
      // (ENOTEMPTY on rmdir) when the test body returns.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    dir = undefined;
  });

  it('show(originSessionId) on a detached view remounts with that row bolded', async () => {
    const b = await boot([summary('s1'), summary('s2')]);
    dir = b.homeDir;
    b.controller.detachForAttach('s1');

    await b.controller.show('s1');

    expect(b.view().detached).toBe(false);
    expect(b.view().originSessionId).toBe('s1');
    const raw = b.host.state.agentsView?.component.render(120).join('\n') ?? '';
    expect(raw).toContain(chalk.hex(currentTheme.palette.textStrong).bold('s1 title'));
    expect(raw).not.toContain(chalk.hex(currentTheme.palette.textStrong).bold('s2 title'));
  });

  it('a fresh show() with no origin argument bolds nothing (cold open, no prior attach)', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    expect(b.view().originSessionId).toBeUndefined();
    const raw = b.component().render(120).join('\n');
    expect(raw).not.toContain(chalk.hex(currentTheme.palette.textStrong).bold('s1 title'));
  });

  it('detachForAttach (attaching TO a session) never sets or clears the origin', async () => {
    const b = await boot([summary('s1'), summary('s2')]);
    dir = b.homeDir;
    await b.controller.show('s1'); // no-op: view already mounted, not detached
    expect(b.view().originSessionId).toBeUndefined();

    b.controller.detachForAttach('s2');
    expect(b.view().originSessionId).toBeUndefined();
  });

  it('a second return overwrites the origin with the newly backed-out-of session', async () => {
    const b = await boot([summary('s1'), summary('s2')]);
    dir = b.homeDir;
    b.controller.detachForAttach('s1');
    await b.controller.show('s1');
    expect(b.view().originSessionId).toBe('s1');

    b.controller.detachForAttach('s2');
    await b.controller.show('s2');
    expect(b.view().originSessionId).toBe('s2');
  });

  it('moving the roster selection (↑↓) leaves the origin untouched', async () => {
    const b = await boot([summary('s1'), summary('s2')]);
    dir = b.homeDir;
    b.controller.detachForAttach('s1');
    await b.controller.show('s1');
    expect(b.view().originSessionId).toBe('s1');

    b.component().handleInput(DOWN);
    b.component().handleInput(DOWN);

    expect(b.view().originSessionId).toBe('s1');
  });

  it('a remount recovery call without an origin argument (e.g. failed-attach retry) preserves the existing origin', async () => {
    const b = await boot([summary('s1'), summary('s2')]);
    dir = b.homeDir;
    b.controller.detachForAttach('s1');
    await b.controller.show('s1');
    expect(b.view().originSessionId).toBe('s1');
    b.controller.detachForAttach('s2');

    await b.controller.show(); // no explicit origin, e.g. a failure-recovery remount

    expect(b.view().detached).toBe(false);
    expect(b.view().originSessionId).toBe('s1');
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
