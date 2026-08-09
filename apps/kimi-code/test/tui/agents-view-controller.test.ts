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
import { SPINNER_FRAME_MS } from '@/tui/components/agents-view/rows';
import type { CustomEditor } from '@/tui/components/editor/custom-editor';
import {
  AgentsViewController,
  dispatchSlashCommands,
  hintDeferredPermissionOnce,
  LOAD_TRUST_CONCURRENCY,
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
import type { AgentsGroupMode } from '@/tui/controllers/agents-view-groups';
import { currentTheme } from '@/tui/theme';
import { DELETE_ARM_WINDOW_MS, EXIT_CONFIRM_WINDOW_MS } from '#/tui/constant/kimi-tui';

const ANSI_SGR = /\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

/** The single rendered line carrying the `❯` selection pointer, or
 *  `undefined` if nothing is selected (never happens once the roster has
 *  rows). Used to assert WHERE the cursor visually landed — not just what
 *  the controller's `selectedId` says — since the two can diverge (see the
 *  reorder-selection-follow tests below). */
function selectedLine(out: string): string | undefined {
  return out.split('\n').find((line) => line.trimStart().startsWith('❯'));
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
  // B1: the roster's Ctrl+X arm calls this (not `deleteSession`) to stop a
  // BUSY row's turn without archiving it. Explicitly Promise-returning —
  // same reason as `wirePrompt`/`createSession` below: the staleness-guard
  // test feeds this `mockImplementationOnce` a `() => new Promise(...)` to
  // hold the rejection open by hand, and the bare `ReturnType<typeof
  // vi.fn>` other fields use resolves that parameter to a void-returning
  // signature, which no-misused-promises then flags.
  cancelSession: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<void>>>;
  renameSession: ReturnType<typeof vi.fn>;
  // Explicitly Promise-returning — see `wirePrompt`'s own comment below: A2's
  // placeholder tests feed this `mockImplementationOnce` a
  // `() => new Promise(...)` to hold session creation open by hand.
  createSession: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<Session>>>;
  session: { getContext: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  createdSession: {
    id: string;
    // Same reason as `createSession` above — the B7 attach test holds this
    // open to prove attach fires before the first prompt call settles.
    prompt: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<void>>>;
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
  const cancelSession = vi.fn(async () => {});
  const renameSession = vi.fn(async () => {});
  const createSession = vi.fn(async () => createdSession as unknown as Session);
  const harness = {
    homeDir,
    listSessions,
    resumeSession,
    deleteSession,
    cancelSession,
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
    cancelSession,
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
  /** Every mode `saveAgentsViewGroupMode` was called with, in call order —
   *  populated only by the default (non-overridden) implementation. */
  savedGroupModes: AgentsGroupMode[];
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
    /**
     * Override for `host.warmAgentsViewSkillMenu()` itself — lets a test
     * hold the warm-up open (e.g. `() => new Promise(() => {})`, never
     * resolving) to prove `show()`'s paint doesn't wait on it. Defaults to
     * the same "apply `warmedActivatableCommands` and resolve" behavior as
     * before this option existed.
     */
    warmAgentsViewSkillMenu?: () => Promise<void>;
    /** Seeds `agentsViewGroupMode()`'s return value; defaults to `'state'`. */
    groupMode?: AgentsGroupMode;
    /** Override for `host.agentsViewGroupMode()` itself — sync, like the
     *  real `KimiTUI` getter. Defaults to returning `opts.groupMode`. */
    agentsViewGroupMode?: () => AgentsGroupMode;
    /** Override for `host.saveAgentsViewGroupMode()` — lets a test make a
     *  Ctrl+S persist reject (proving the controller flashes, not throws).
     *  Defaults to recording the call into `Boot.savedGroupModes` and resolving. */
    saveAgentsViewGroupMode?: (mode: AgentsGroupMode) => Promise<void>;
    /** Override for `host.agentsViewWorkDir()`; defaults to a fixed fake
     *  path. A real directory is needed for `@`-mention autocomplete tests —
     *  `FileMentionProvider` falls back to a real filesystem scan. */
    workDir?: string;
    /** I6: `host.agentsViewSessionsSurviveExit()`; defaults to `true` (the
     *  non-embedded, common case). Set `false` to simulate embedded mode. */
    sessionsSurviveExit?: boolean;
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
  const savedGroupModes: AgentsGroupMode[] = [];
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
    agentsViewSessionsSurviveExit: () => opts.sessionsSurviveExit ?? true,
    agentsViewWorkDir: () => opts.workDir ?? '/home/user/project',
    agentsViewGroupMode: opts.agentsViewGroupMode ?? (() => opts.groupMode ?? 'state'),
    saveAgentsViewGroupMode:
      opts.saveAgentsViewGroupMode ??
      (async (mode) => {
        savedGroupModes.push(mode);
      }),
    agentsViewModelLabel: () => 'test-model',
    agentsViewModelCompletions: () =>
      opts.modelCompletions ?? [
        { value: 'kimi-latest', description: 'Kimi Latest' },
        { value: 'kimi-thinking', description: 'Kimi Thinking' },
      ],
    agentsViewActivatableCommands: () => currentActivatable,
    warmAgentsViewSkillMenu:
      opts.warmAgentsViewSkillMenu ??
      (async () => {
        if (opts.warmedActivatableCommands !== undefined) currentActivatable = opts.warmedActivatableCommands;
      }),
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
    savedGroupModes,
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
const CTRL_S = '\u0013';
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
    expect(b.render()).toContain('Press Ctrl-C again to exit');
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

  // I5: the delete arm is not a modal for Ctrl+C's own two-stage exit — the
  // FIRST Ctrl+C clears it (same press that arms the exit hint), so by the
  // time the SECOND (confirming) press reaches quitOrCancelConfirm there is
  // nothing left to absorb: the view really closes, matching the footer's
  // own promise. Esc keeps the old absorb-as-cancel behavior (see "Esc
  // while armed cancels the arm instead of quitting" above) — only Ctrl+C
  // is exempted here.
  it('a pending row delete arm (B1) does not survive the first Ctrl+C — the second press really exits', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN); // onto row s1
    b.component().handleInput(CTRL_X); // arms the row for delete
    expect(b.view().armedDeleteId).toBe('s1');
    b.component().handleInput(CTRL_C); // clears the arm AND arms the exit hint
    expect(b.view().armedDeleteId).toBeUndefined();
    expect(b.view().pendingExitTimer).toBeDefined();
    b.component().handleInput(CTRL_C); // confirming press
    expect(b.controller.isOpen).toBe(false);
  });

  it('a pending GROUP delete confirm (header) does not survive the first Ctrl+C either', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(CTRL_X); // group header, no row selected — arms confirmDeleteId
    expect(b.view().confirmDeleteId).toBeDefined();
    b.component().handleInput(CTRL_C);
    expect(b.view().confirmDeleteId).toBeUndefined();
    b.component().handleInput(CTRL_C);
    expect(b.controller.isOpen).toBe(false);
  });
});

// A focused composer routes every key to the editor (`AgentsViewApp.
// handleInput`'s `dispatchFocused` branch), so Ctrl+C only reaches the
// exit machine above if the editor itself is wired to report it
// (`dispatch.editor.onCtrlC`, in `show()`). Without that wiring these all
// fail: `CustomEditor.handleInput` finds `onCtrlC` unset and silently
// drops the keypress.
describe('AgentsViewController — Ctrl+C reaches the focused dispatch composer (parity with the main REPL)', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    dir = undefined;
  });

  const BACKSPACE = String.fromCodePoint(127);

  it('Ctrl+C on a focused, EMPTY composer reaches the two-stage exit arm', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput('d'); // focus the composer
    b.component().handleInput(BACKSPACE); // back to empty, still focused
    expect(b.view().dispatch.editor.getText()).toBe('');
    expect(b.view().dispatchFocused).toBe(true);

    b.component().handleInput(CTRL_C);

    expect(b.view().pendingExitTimer).toBeDefined();
    expect(b.render()).toContain('Press Ctrl-C again to exit');
  });

  it('a second Ctrl+C from the focused, empty composer closes the view — same as list-focused', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput('d');
    b.component().handleInput(BACKSPACE);

    b.component().handleInput(CTRL_C);
    b.component().handleInput(CTRL_C);

    expect(b.controller.isOpen).toBe(false);
  });

  it('Ctrl+C on a focused composer WITH TEXT clears the draft and arms the exit hint (matches editor-keyboard.ts onCtrlC)', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    for (const ch of 'fix') b.component().handleInput(ch);
    expect(b.view().dispatch.editor.getText()).toBe('fix');

    b.component().handleInput(CTRL_C);

    expect(b.view().dispatch.editor.getText()).toBe('');
    expect(b.view().pendingExitTimer).toBeDefined();
  });

  it('Ctrl+C on an empty REPLY composer reaches the exit arm and leaves the panel open — only Esc closes panels', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN); // select row s1
    b.component().handleInput(SPACE); // open the reply panel on s1
    expect(b.view().replyTargetId).toBe('s1');
    expect(b.view().dispatch.editor.getText()).toBe('');

    b.component().handleInput(CTRL_C);

    expect(b.view().pendingExitTimer).toBeDefined();
    expect(b.view().replyTargetId).toBe('s1');
  });

  it('a second Ctrl+C from an open reply composer closes the view without submitting the reply', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(SPACE);

    b.component().handleInput(CTRL_C);
    b.component().handleInput(CTRL_C);

    expect(b.controller.isOpen).toBe(false);
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

  it('the spinner ticker repaints at the 120ms frame cadence, not the old 400ms sample rate (B5)', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    try {
      const b = await boot([summary('s1')]);
      dir = b.homeDir;
      b.fake.emit({ type: 'event.session.work_changed', sessionId: 's1', busy: true, pending_interaction: 'none' });
      expect(b.view().busyTicker).toBeDefined();
      const tickerCall = setIntervalSpy.mock.calls.find(([, ms]) => ms === SPINNER_FRAME_MS);
      expect(tickerCall).toBeDefined();
    } finally {
      setIntervalSpy.mockRestore();
    }
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

  it('M1: deleting a pinned row prunes it from pins and seenAt too, not just viewSessions', async () => {
    const b = await boot([summary('s1'), summary('s2')]);
    dir = b.homeDir;
    // Pin s1 first so its id lives in `pins`, and mark it seen so it lives
    // in `seenAt` too — both are separate persisted Sets/Maps `AgentsRoster
    // .remove` never touches.
    b.view().roster.setPinned('s1', true);
    b.view().seenAt.set('s1', Date.now());
    expect(b.view().pins.has('s1')).toBe(true);
    expect(b.view().seenAt.has('s1')).toBe(true);

    // Select s1 (now in the Pinned group, sorted first) and archive it.
    b.component().handleInput(DOWN);
    expect(b.view().selectedId).toBe('s1');
    b.component().handleInput(CTRL_X);
    b.component().handleInput(CTRL_X);
    await flush();

    expect(b.view().pins.has('s1')).toBe(false);
    expect(b.view().seenAt.has('s1')).toBe(false);
    // The persisted file carries no trace of the id either.
    await waitForViewState(b.homeDir, { pins: new Set(), sessions: new Set(['s2']) });
  });
});

describe('AgentsViewController — row delete arm (B1)', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    dir = undefined;
  });

  it('first Ctrl+X on an idle row arms in place — row summary shows the arm text, no dialog', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(CTRL_X);
    expect(b.view().armedDeleteId).toBe('s1');
    expect(b.view().confirmDeleteId).toBeUndefined();
    expect(b.view().armedDeleteStopped).toBe(false);
    expect(b.fake.cancelSession).not.toHaveBeenCalled();
    const out = b.render();
    expect(out).toContain('ctrl+x again to delete');
    expect(out).not.toContain('Archive session');
    expect(out).not.toContain('stopped');
  });

  it('first Ctrl+X on a BUSY row stops the turn immediately AND arms — summary reads "stopped · ..."', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.fake.emit({ type: 'event.session.work_changed', sessionId: 's1', busy: true, pending_interaction: 'none' });
    b.component().handleInput(DOWN); // onto s1, now in Working
    b.component().handleInput(CTRL_X);
    expect(b.view().armedDeleteId).toBe('s1');
    expect(b.view().armedDeleteStopped).toBe(true);
    expect(b.fake.cancelSession).toHaveBeenCalledWith('s1');
    expect(b.fake.deleteSession).not.toHaveBeenCalled();
    expect(b.render()).toContain('stopped · ctrl+x again to delete');
  });

  it('second Ctrl+X while armed archives the session and removes the row', async () => {
    const b = await boot([summary('s1'), summary('s2')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN); // onto s1
    b.component().handleInput(CTRL_X);
    expect(b.view().armedDeleteId).toBe('s1');
    expect(b.render()).toContain('ctrl+x again to delete');
    b.component().handleInput(CTRL_X);
    await flush();
    expect(b.fake.deleteSession).toHaveBeenCalledWith('s1');
    expect(b.view().armedDeleteId).toBeUndefined();
    expect(b.render()).not.toContain('s1 title');
    expect(b.render()).toContain('s2 title');
    // Archiving also drops the session from the persisted view registry.
    await waitForViewState(b.homeDir, { pins: new Set(), sessions: new Set(['s2']) });
  });

  it('Esc while armed cancels the arm instead of quitting', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(CTRL_X);
    expect(b.view().armedDeleteId).toBe('s1');
    b.component().handleInput(ESC);
    expect(b.controller.isOpen).toBe(true);
    expect(b.view().armedDeleteId).toBeUndefined();
    expect(b.render()).not.toContain('ctrl+x again to delete');
    expect(b.fake.deleteSession).not.toHaveBeenCalled();
  });

  it('any other action (e.g. pin) clears a pending row arm, same as it does the group confirm', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(CTRL_X);
    expect(b.view().armedDeleteId).toBe('s1');
    b.component().handleInput(CTRL_T); // pin instead
    await flush();
    expect(b.view().armedDeleteId).toBeUndefined();
    expect(b.fake.deleteSession).not.toHaveBeenCalled();
    await waitForViewState(b.homeDir, { pins: new Set(['s1']), sessions: new Set(['s1']) });
  });

  it('navigating with ↓ while armed disarms first, then still moves the selection (would fail without the disarm-then-apply order)', async () => {
    const b = await boot([summary('s1'), summary('s2')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN); // onto s1
    b.component().handleInput(CTRL_X); // arm s1
    expect(b.view().armedDeleteId).toBe('s1');
    b.component().handleInput(DOWN); // navigate away, onto s2
    expect(b.view().armedDeleteId).toBeUndefined();
    expect(b.view().selectedId).toBe('s2');
  });

  it('the arm auto-expires after DELETE_ARM_WINDOW_MS with zero further input, clearing state AND forcing a repaint', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    vi.useFakeTimers();
    try {
      b.component().handleInput(DOWN);
      b.component().handleInput(CTRL_X);
      expect(b.view().armedDeleteId).toBe('s1');
      b.ui.requestRender.mockClear();

      // No handleInput, no other action between arming and here — mirrors
      // the Ctrl+C exit-hint autonomous-repaint test above (same shape: a
      // component-local timer with no pi-tui repaint wouldn't survive this).
      vi.advanceTimersByTime(DELETE_ARM_WINDOW_MS + 1);

      expect(b.view().armedDeleteId).toBeUndefined();
      expect(b.ui.requestRender).toHaveBeenCalled();
      expect(b.fake.deleteSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a still-dispatching A2 placeholder declines Ctrl+X instead of arming (isPendingDispatchId guard)', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    let resolveCreate: (() => void) | undefined;
    b.fake.createSession.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveCreate = () => res(b.fake.createdSession as unknown as Session);
        }),
    );
    b.view().dispatch.editor.onSubmit?.('fix the flaky test');
    const placeholderId = b.view().selectedId!;
    expect(placeholderId).not.toBe('s1');

    b.component().handleInput(CTRL_X);
    expect(b.view().armedDeleteId).toBeUndefined();
    expect(b.view().flashMessage).toBe('Still dispatching — try again in a moment');
    expect(b.showStatus).not.toHaveBeenCalled();
    expect(b.fake.cancelSession).not.toHaveBeenCalled();

    resolveCreate?.();
    await flush();
  });

  it("an armed row's group/position freezes across a refresh reseed that would otherwise re-bucket it (would fail without the freeze)", async () => {
    const b = await boot([summary('s1'), summary('s2')], {
      wire: true,
      rows: [wireRow('s1', { busy: true }), wireRow('s2', { busy: false })],
    });
    dir = b.homeDir;
    await flush(); // the one-shot trust load settles
    b.component().handleInput(DOWN); // onto s1 (Working)
    expect(b.view().selectedId).toBe('s1');
    b.component().handleInput(CTRL_X); // arms + optimistically stops
    expect(b.view().armedDeleteId).toBe('s1');
    expect(b.render()).toContain('Working');

    // The stop actually lands server-side: the next reseed reflects s1 idle
    // — WITHOUT the freeze this reclassifies it into Completed and the
    // now-empty Working group disappears entirely.
    b.fake.wireRows?.mockResolvedValueOnce([wireRow('s1', { busy: false }), wireRow('s2', { busy: false })]);
    b.fake.emitConnection(true);
    await flush();

    expect(b.view().armedDeleteId).toBe('s1'); // still armed
    const out = b.render();
    expect(out).toContain('Working'); // frozen group membership survives the reseed
    expect(out).toContain('s1 title');
  });

  it('a refresh reseed that REMOVES the armed row entirely clears the arm instead of freezing a hole', async () => {
    const b = await boot([summary('s1')], { wire: true, rows: [wireRow('s1', { busy: true })] });
    dir = b.homeDir;
    await flush();
    b.component().handleInput(DOWN);
    b.component().handleInput(CTRL_X);
    expect(b.view().armedDeleteId).toBe('s1');

    // s1 was archived by another client during the drop.
    b.fake.wireRows?.mockResolvedValueOnce([]);
    b.fake.emitConnection(true);
    await flush();

    expect(b.view().armedDeleteId).toBeUndefined();
    expect(b.view().roster.get('s1')).toBeUndefined();
  });

  it('a stale cancelSession rejection landing after the view is closed and reopened produces no flash (would fail without the staleness guard)', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    let rejectCancel: ((error: Error) => void) | undefined;
    b.fake.cancelSession.mockImplementationOnce(
      () =>
        new Promise((_res, rej) => {
          rejectCancel = rej;
        }),
    );
    b.fake.emit({ type: 'event.session.work_changed', sessionId: 's1', busy: true, pending_interaction: 'none' });
    b.component().handleInput(DOWN); // onto s1, Working
    b.component().handleInput(CTRL_X); // arms + optimistically stops; cancelSession left pending
    expect(b.view().armedDeleteId).toBe('s1');

    // Close and reopen — a fresh AgentsViewState — before the rejection
    // lands, the exact race the guard exists for.
    b.controller.close();
    await b.controller.show();
    expect(b.view().armedDeleteId).toBeUndefined();

    rejectCancel?.(new Error('stop broke'));
    await flush();

    expect(b.view().flashMessage).toBeUndefined();
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

  it('re-anchors the marker onto the pinned row even when the controller selectedId was left stale by a concurrent push (would fail without the onPinToggle fix)', async () => {
    // Mirrors the onReorderPinned race tests: Ctrl+T RELOCATES the row (into
    // a brand-new `Pinned` group here), so it shares the exact same
    // "targets via the component's live cursor, re-anchors via a
    // `view.selectedId` the caller never asserted" gap reorder had.
    const b = await boot([summary('s1'), summary('s2'), summary('s3')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN); // s1
    b.component().handleInput(DOWN); // s2
    expect(b.view().selectedId).toBe('s2');

    // Corrupt the controller's copy, as a concurrent event would — the
    // component's local cursor is untouched by this.
    b.view().selectedId = undefined;

    b.component().handleInput(CTRL_T); // pin s2 -> relocates into new "Pinned" group

    await waitForViewState(b.homeDir, {
      pins: new Set(['s2']),
      sessions: new Set(['s1', 's2', 's3']),
    });
    // The fix: selection re-anchors onto s2 (the row that moved), both in
    // controller state and on screen — not left undefined or stuck on
    // whatever the stale index happened to land on.
    expect(b.view().selectedId).toBe('s2');
    expect(selectedLine(b.render())).toContain('s2 title');
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

  it('shift+↓ moves the ❯ marker onto the row at its new render position, not just the controller id', async () => {
    // Upgrades the "selection follows it" case above with a check of the
    // actually-rendered cursor, not only `view().selectedId` — the two can
    // diverge (see the next test) even though `selectedId` alone always
    // looks right (`onReorderPinned` never used to touch it).
    const b = await boot([summary('p1'), summary('p2')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN); // p1
    b.component().handleInput(CTRL_T); // pin p1
    b.component().handleInput(DOWN); // completed header
    b.component().handleInput(DOWN); // p2
    b.component().handleInput(CTRL_T); // pin p2
    await waitForViewState(b.homeDir, { pins: new Set(['p1', 'p2']), sessions: new Set(['p1', 'p2']) });
    b.component().handleInput(UP); // back onto p1 (top of the pinned group)

    b.component().handleInput(SHIFT_DOWN);

    expect(selectedLine(b.render())).toContain('p1 title');
  });

  it('re-anchors the marker onto the moved row even when the controller selectedId was left stale by a concurrent push (would fail without the onReorderPinned fix)', async () => {
    // Simulates a real-world race: something OTHER than this keypress (e.g.
    // a WS-reconnect `refreshRoster` wiping a dangling selection) pushes
    // `view.selectedId` out of sync with the component's own on-screen
    // cursor right before the reorder fires. The component still computes
    // the CORRECT row id to reorder (it reads its own local cursor), but
    // without `onReorderPinned` re-asserting `view.selectedId = id`, the
    // controller's next `pushProps()` carries the stale/undefined id and
    // `AgentsViewApp.syncSelectionFromProps` falls back to its last-known
    // raw index into the POST-reorder array — landing the ❯ marker on
    // whatever now sits at that index (a different row, or the group
    // header) instead of following the row that actually moved.
    const b = await boot([summary('p1'), summary('p2'), summary('p3')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN); // p1
    b.component().handleInput(CTRL_T); // pin p1
    b.component().handleInput(DOWN); // completed header
    b.component().handleInput(DOWN); // p2
    b.component().handleInput(CTRL_T); // pin p2
    await waitForViewState(b.homeDir, { pins: new Set(['p1', 'p2']), sessions: new Set(['p1', 'p2', 'p3']) });
    // Selection is on p2 (bottom of the pinned group) — the component's own
    // cursor is correctly there, matching what's on screen.
    expect(b.view().selectedId).toBe('p2');

    // Corrupt the controller's copy, as a concurrent event would — the
    // component's local cursor is untouched by this.
    b.view().selectedId = undefined;

    b.component().handleInput(SHIFT_UP); // reorder p2 up past p1

    // p2 is still the row that moved (the reorder read the component's own
    // cursor, not the corrupted controller field) — persistence proves the
    // swap happened on the right row regardless of the marker bug.
    await vi.waitFor(async () => {
      const state = await loadAgentsViewState(b.homeDir);
      expect([...state.pins]).toEqual(['p2', 'p1']);
    });
    // The fix: selection re-anchors onto p2 (the row that moved), both in
    // controller state and on screen — not on p1 (whatever the stale index
    // happened to land on) or the group header.
    expect(b.view().selectedId).toBe('p2');
    expect(selectedLine(b.render())).toContain('p2 title');
  });

  it('double shift+↑ moves the SAME row twice, re-anchoring correctly after each press even under a repeated selectedId desync', async () => {
    const b = await boot([summary('p1'), summary('p2'), summary('p3'), summary('p4')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN); // p1
    b.component().handleInput(CTRL_T); // pin p1
    b.component().handleInput(DOWN); // completed header
    b.component().handleInput(DOWN); // p2
    b.component().handleInput(CTRL_T); // pin p2
    b.component().handleInput(DOWN); // completed header
    b.component().handleInput(DOWN); // p3
    b.component().handleInput(CTRL_T); // pin p3
    await waitForViewState(b.homeDir, {
      pins: new Set(['p1', 'p2', 'p3']),
      sessions: new Set(['p1', 'p2', 'p3', 'p4']),
    });
    // Selection sits on p3 (bottom of the pinned group, order [p1, p2, p3]).
    expect(b.view().selectedId).toBe('p3');

    // First press: desync before it fires, same as the single-press test.
    b.view().selectedId = undefined;
    b.component().handleInput(SHIFT_UP); // p3: pos2 -> pos1 ([p1, p3, p2])
    expect(b.view().selectedId).toBe('p3');
    expect(selectedLine(b.render())).toContain('p3 title');

    // Second press: desync again — the SAME row keeps moving, not whatever
    // the stale index would otherwise land on.
    b.view().selectedId = undefined;
    b.component().handleInput(SHIFT_UP); // p3: pos1 -> pos0 ([p3, p1, p2])
    expect(b.view().selectedId).toBe('p3');
    expect(selectedLine(b.render())).toContain('p3 title');

    await vi.waitFor(async () => {
      const state = await loadAgentsViewState(b.homeDir);
      expect([...state.pins]).toEqual(['p3', 'p1', 'p2']);
    });
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

  it('a failed rename rolls the row title back and flashes the error on the mounted roster', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.fake.renameSession.mockRejectedValueOnce(new Error('rename broke'));
    b.component().handleInput(DOWN);
    b.component().handleInput(CTRL_R);
    b.component().handleInput('X');
    b.component().handleInput(ENTER);
    await flush();
    // The roster owns the screen here — the error must land on its own
    // visible flash line, not in the detached chat transcript.
    expect(b.view().flashMessage).toContain('rename broke');
    expect(b.showError).not.toHaveBeenCalled();
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

describe('AgentsViewController — → on an empty composer attaches (B8)', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) {
      // maxRetries: a fire-and-forget persistState can still be mid-write
      // (ENOTEMPTY on rmdir) when the test body returns.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    dir = undefined;
  });

  const BACKSPACE = String.fromCodePoint(127);

  it('→ on an empty, focused composer attaches to the selected row — same path as Enter', async () => {
    const onOpenSession = vi.fn();
    const b = await boot([summary('s1')], { onOpenSession });
    dir = b.homeDir;
    b.component().handleInput(DOWN); // select row s1
    b.component().handleInput('d'); // focus the composer
    b.component().handleInput(BACKSPACE); // back to empty, still focused
    expect(b.view().dispatch.editor.getText()).toBe('');
    expect(b.view().dispatchFocused).toBe(true);

    b.component().handleInput(RIGHT);

    expect(onOpenSession).toHaveBeenCalledWith('s1');
  });

  it('→ with text in the composer keeps normal cursor behavior — no attach', async () => {
    const onOpenSession = vi.fn();
    const b = await boot([summary('s1')], { onOpenSession });
    dir = b.homeDir;
    b.component().handleInput(DOWN); // select row s1
    for (const ch of 'fix') b.component().handleInput(ch);
    expect(b.view().dispatch.editor.getText()).toBe('fix');

    b.component().handleInput(RIGHT);

    expect(onOpenSession).not.toHaveBeenCalled();
    expect(b.view().dispatch.editor.getText()).toBe('fix');
  });

  it('→ on an empty, focused composer with nothing selected is a no-op', async () => {
    const onOpenSession = vi.fn();
    const b = await boot([summary('s1')], { onOpenSession });
    dir = b.homeDir;
    // Never navigated with ↑/↓ — view.selectedId is still undefined even
    // though the list visually highlights its first item.
    b.component().handleInput('d');
    b.component().handleInput(BACKSPACE);

    b.component().handleInput(RIGHT);

    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it('→ on an empty composer during a reply declines — the reply panel keeps its own empty-Enter attach path', async () => {
    const onOpenSession = vi.fn();
    const b = await boot([summary('s1')], { onOpenSession });
    dir = b.homeDir;
    b.component().handleInput(DOWN); // select row s1
    b.component().handleInput(SPACE); // open the reply panel on s1
    expect(b.view().replyTargetId).toBe('s1');
    expect(b.view().dispatch.editor.getText()).toBe('');

    b.component().handleInput(RIGHT);

    expect(onOpenSession).not.toHaveBeenCalled();
    expect(b.view().replyTargetId).toBe('s1');
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

  it('Enter on a row with no attach seam flashes on the still-mounted view, not the (invisible) host surface', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(ENTER);
    expect(b.view().flashMessage).toBe('Attach is not available from this host');
    expect(b.showStatus).not.toHaveBeenCalled();
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

  it('the footer verb flips from "enter to open" to "enter to return" after the first successful attach in this process (B2)', async () => {
    const onOpenSession = vi.fn();
    const b = await boot([summary('s1'), summary('s2')], { onOpenSession });
    dir = b.homeDir;
    b.component().handleInput(DOWN); // onto row s1
    expect(b.render()).toContain('enter to open');

    b.component().handleInput(ENTER); // attach succeeds via the onOpenSession stub
    expect(b.render()).toContain('enter to return');

    b.component().handleInput(DOWN); // onto row s2 — never attached
    expect(b.render()).toContain('enter to open');
    expect(b.render()).not.toContain('enter to return');
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

  it('B6: a slash command the registry knows but this composer cannot run gets the rejection toast', () => {
    expect(parseDispatchInput('/yolo fix the flaky test', EMPTY_ACTIVATABLE)).toEqual({
      toast: "/yolo isn't available in agent view — attach to a session to run it",
    });
    expect(parseDispatchInput('/help', EMPTY_ACTIVATABLE)).toEqual({
      toast: "/help isn't available in agent view — attach to a session to run it",
    });
  });

  it("B6: a registry command's alias also resolves to the toast, named as typed", () => {
    // 'help' registers 'h' and '?' as aliases (commands/registry.ts).
    expect(parseDispatchInput('/h', EMPTY_ACTIVATABLE)).toEqual({
      toast: "/h isn't available in agent view — attach to a session to run it",
    });
  });

  it('B6: a slash token that matches no known command, skill or plugin is plain dispatch text, not rejected', () => {
    expect(parseDispatchInput('/modelx fix the flaky test', EMPTY_ACTIVATABLE)).toEqual({
      text: '/modelx fix the flaky test',
    });
    expect(parseDispatchInput('/gibberish do the thing', EMPTY_ACTIVATABLE)).toEqual({
      text: '/gibberish do the thing',
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

    it('an unrecognized command name is plain dispatch text even with a non-empty activatable set', () => {
      expect(parseDispatchInput('/not-a-real-command fix it', activatable)).toEqual({
        text: '/not-a-real-command fix it',
      });
    });

    it('B6: a registry-known command still gets the toast, not a skill/plugin lookup miss', () => {
      expect(parseDispatchInput('/compact', activatable)).toEqual({
        toast: "/compact isn't available in agent view — attach to a session to run it",
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

  it('I3: rejects only empty/whitespace-only input — not dispatch mode\'s 3-char floor', () => {
    expect(parseReplyInput('')).toEqual({ error: 'Reply cannot be empty' });
    expect(parseReplyInput('   ')).toEqual({ error: 'Reply cannot be empty' });
    // A short confirmation is the single most common roster reply — the
    // dispatch parser's MIN_NON_SPACE_CHARS floor does not apply here.
    expect(parseReplyInput('ab')).toEqual({ text: 'ab' });
    expect(parseReplyInput('ok')).toEqual({ text: 'ok' });
    expect(parseReplyInput('y')).toEqual({ text: 'y' });
    expect(parseReplyInput('no')).toEqual({ text: 'no' });
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
    dispatch.editor.onSubmit?.('ab');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('Too short — describe the task');
  });

  it('B6: a known-but-unsuitable slash command goes to onToast (not onError — M3) with the rejection toast, restores the composer text (pi-tui already cleared it pre-submit), and never reaches onSubmit', () => {
    const dispatch = makeDispatch();
    const onSubmit = vi.fn();
    const onError = vi.fn();
    const onToast = vi.fn();
    dispatch.onSubmit = onSubmit;
    dispatch.onError = onError;
    dispatch.onToast = onToast;
    // Mirrors real submitValue(): pi-tui clears the buffer before onSubmit fires.
    dispatch.editor.setText('');
    dispatch.editor.onSubmit?.('/yolo fix the flaky test');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledWith(
      "/yolo isn't available in agent view — attach to a session to run it",
    );
    expect(dispatch.editor.getText()).toBe('/yolo fix the flaky test');
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

  it('B7: a plain shift+enter submission fires onShiftEnterSubmit and reports consumed', () => {
    const dispatch = makeDispatch();
    const onShiftEnterSubmit = vi.fn();
    dispatch.onShiftEnterSubmit = onShiftEnterSubmit;
    const consumed = dispatch.editor.onShiftEnterSubmit?.('fix the flaky test');
    expect(consumed).toBe(true);
    expect(onShiftEnterSubmit).toHaveBeenCalledWith({ text: 'fix the flaky test' });
  });

  it('B7: shift+enter on a /model dispatch declines — no attach shortcut for slash dispatches', () => {
    const dispatch = makeDispatch();
    const onShiftEnterSubmit = vi.fn();
    dispatch.onShiftEnterSubmit = onShiftEnterSubmit;
    const consumed = dispatch.editor.onShiftEnterSubmit?.('/model kimi-k2 fix the flaky test');
    expect(consumed).toBe(false);
    expect(onShiftEnterSubmit).not.toHaveBeenCalled();
  });

  it('B7: shift+enter on a skill/plugin dispatch declines', () => {
    const dispatch = makeDispatch({
      commands: [],
      skillCommandMap: new Map([['skill:reviewcode', 'reviewcode']]),
      pluginCommandMap: new Map(),
    });
    const onShiftEnterSubmit = vi.fn();
    dispatch.onShiftEnterSubmit = onShiftEnterSubmit;
    const consumed = dispatch.editor.onShiftEnterSubmit?.('/skill:reviewcode check the auth module');
    expect(consumed).toBe(false);
    expect(onShiftEnterSubmit).not.toHaveBeenCalled();
  });

  it('B7: shift+enter while replying declines — a reply stays multi-line-capable', () => {
    const dispatch = makeDispatch();
    dispatch.replying = true;
    const onShiftEnterSubmit = vi.fn();
    dispatch.onShiftEnterSubmit = onShiftEnterSubmit;
    const consumed = dispatch.editor.onShiftEnterSubmit?.('a multi-line reply in progress');
    expect(consumed).toBe(false);
    expect(onShiftEnterSubmit).not.toHaveBeenCalled();
  });

  it('B7: a parse error (too short) declines silently — no onError, no onShiftEnterSubmit', () => {
    const dispatch = makeDispatch();
    const onError = vi.fn();
    const onShiftEnterSubmit = vi.fn();
    dispatch.onError = onError;
    dispatch.onShiftEnterSubmit = onShiftEnterSubmit;
    const consumed = dispatch.editor.onShiftEnterSubmit?.('ab');
    expect(consumed).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    expect(onShiftEnterSubmit).not.toHaveBeenCalled();
  });

  it('B7: with no onShiftEnterSubmit host wired, shift+enter declines (falls through to newline)', () => {
    const dispatch = makeDispatch();
    const consumed = dispatch.editor.onShiftEnterSubmit?.('fix the flaky test');
    expect(consumed).toBe(false);
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

  it('B6: a known-but-unsuitable slash command flashes the rejection toast, restores the composer text, and creates nothing', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    // Mirrors real submitValue(): pi-tui clears the buffer before onSubmit fires.
    b.view().dispatch.editor.setText('');
    b.view().dispatch.editor.onSubmit?.('/yolo fix the flaky test');
    await flush();
    expect(b.fake.createSession).not.toHaveBeenCalled();
    expect(b.render()).toContain("/yolo isn't available in agent view — attach to a session to run it");
    expect(b.view().dispatch.editor.getText()).toBe('/yolo fix the flaky test');
    b.controller.close(); // clear the pending flash timer
  });

  it('M3: the B6 toast leaves the composer focused with its text, so Enter keeps editing instead of attaching to the selected row', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    // Composer was focused (as it would be after routeToDispatch typed the
    // command in) before the rejected submit — the bug this guards against
    // only shows up starting from a focused composer.
    b.view().dispatchFocused = true;
    b.view().dispatch.editor.focused = true;
    b.view().dispatch.editor.setText('');
    b.view().dispatch.editor.onSubmit?.('/help');
    await flush();
    expect(b.render()).toContain("/help isn't available in agent view — attach to a session to run it");
    expect(b.view().dispatch.editor.getText()).toBe('/help');
    // The composer keeps focus — Enter on the row list (dispatchFocused ===
    // false) is what attaches; staying focused is what routes Enter back
    // into the editor instead (see `AgentsViewApp.handleInput`).
    expect(b.view().dispatchFocused).toBe(true);
    expect(b.view().dispatch.editor.focused).toBe(true);
    b.controller.close(); // clear the pending flash timer
  });

  it('B6: an unrecognized /gibberish string dispatches as plain text (no toast, no rejection)', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.view().dispatch.editor.onSubmit?.('/gibberish fix the flaky test');
    await flush();
    expect(b.fake.createSession).toHaveBeenCalledTimes(1);
    expect(b.fake.createdSession.prompt).toHaveBeenCalledWith('/gibberish fix the flaky test');
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

// ── I2: the roster composer has no shell route either — `!` must not enter
// bash mode there (the main chat editor already vetoes it; the dispatch
// editor never got the same wiring). ──

describe('AgentsViewController — bash-mode veto on the roster composer (I2)', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    dir = undefined;
  });

  it('`!` on the empty roster composer vetoes bash mode with a flashed hint instead of switching', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;

    b.component().handleInput('!');

    expect(b.view().dispatch.editor.inputMode).toBe('prompt');
    // The veto swallows the keystroke — same as the main chat editor's own
    // gate (custom-editor.ts): not entered as literal text either.
    expect(b.view().dispatch.editor.getText()).toBe('');
    expect(b.view().flashMessage).toBe('Shell commands (!) are not available in agents view.');
    expect(b.fake.createSession).not.toHaveBeenCalled();
  });

  it('`!cmd` never carries the exclamation into what gets dispatched — the veto swallows only the `!` keystroke', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;

    b.component().handleInput('!');
    b.component().handleInput('cmd');

    // No bash mode was ever entered, so "cmd" landed as ordinary text —
    // never "!cmd": there is no path left from here to a shell command
    // silently running as an agent prompt.
    expect(b.view().dispatch.editor.inputMode).toBe('prompt');
    expect(b.view().dispatch.editor.getText()).toBe('cmd');

    b.view().dispatch.editor.onSubmit?.(b.view().dispatch.editor.getText());
    await flush();
    expect(b.fake.createdSession.prompt).toHaveBeenCalledWith('cmd');
  });
});

// ── A2: optimistic dispatch placeholder row (+ B7 shift+enter attach) ──

describe('AgentsViewController — A2 optimistic dispatch placeholder', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    dir = undefined;
  });

  /** Holds `createSession` open until the test lets it resolve, so the
   *  SYNCHRONOUS placeholder can be inspected before the real id exists. */
  function deferCreateSession(b: Boot): { resolve: () => void } {
    let resolve: (() => void) | undefined;
    b.fake.createSession.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolve = () => res(b.fake.createdSession as unknown as Session);
        }),
    );
    return {
      resolve: () => resolve?.(),
    };
  }

  it('Enter synchronously inserts a busy, selected placeholder row before createSession resolves', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    const deferred = deferCreateSession(b);

    b.view().dispatch.editor.onSubmit?.('fix the flaky test');
    // No `await flush()` yet — createSession is still pending, so this is
    // exactly what the user sees synchronously on Enter.
    const out = b.render();
    expect(out).toContain('fix the flaky test');
    expect(out).toContain('Working');

    const placeholderId = b.view().selectedId;
    expect(placeholderId).not.toBeUndefined();
    expect(placeholderId).not.toBe('s1');
    const row = b.view().roster.get(placeholderId!);
    expect(row?.busy).toBe(true);
    expect(row?.title).toBe('fix the flaky test');
    // Never leaks into the persisted registry/pins — it's a local id, not a
    // real session.
    expect(b.view().viewSessions.has(placeholderId!)).toBe(false);

    deferred.resolve();
    await flush();
    b.controller.close();
  });

  it('reconciles the placeholder to the real session id on success, keeping selection', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    const deferred = deferCreateSession(b);

    b.view().dispatch.editor.onSubmit?.('fix the flaky test');
    const placeholderId = b.view().selectedId!;

    deferred.resolve();
    await flush();

    // The placeholder id is gone — promoted in place, not left behind.
    expect(b.view().roster.get(placeholderId)).toBeUndefined();
    expect(b.view().selectedId).toBe('new-session');
    const realRow = b.view().roster.get('new-session');
    expect(realRow?.busy).toBe(true);
    expect(realRow?.title).toBe('fix the flaky test');
    expect(b.view().viewSessions.has('new-session')).toBe(true);
    const out = b.render();
    expect(out).toContain('fix the flaky test');
    expect(out).toContain('Working');
  });

  it('dedupes against a same-session event.session.created echo that lands while the placeholder is alive', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    const deferred = deferCreateSession(b);

    b.view().dispatch.editor.onSubmit?.('fix the flaky test');
    deferred.resolve();
    await flush();

    // The server's own echo for the same session, landing after the local
    // promotion already happened.
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

    const rowCount = b
      .view()
      .roster.groups(Number.MAX_SAFE_INTEGER)
      .flatMap((group) => group.rows)
      .filter((row) => row.id === 'new-session' || row.title === 'fix the flaky test').length;
    expect(rowCount).toBe(1);
  });

  it('a failing createSession removes the placeholder row instead of leaving it stuck', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.fake.createSession.mockRejectedValueOnce(new Error('workspace rejected'));

    b.view().dispatch.editor.onSubmit?.('fix the flaky test');
    const placeholderId = b.view().selectedId!;
    expect(b.view().roster.get(placeholderId)).not.toBeUndefined();

    await flush();

    expect(b.view().roster.get(placeholderId)).toBeUndefined();
    expect(b.view().selectedId).toBeUndefined();
    expect(b.render()).toContain('Dispatch failed: workspace rejected');
    const out = b.render();
    expect(out).not.toContain('fix the flaky test');
    b.controller.close(); // clear the pending flash timer
  });

  it('a /model dispatch (slash) gets no placeholder — pre-A2 behaviour unchanged', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    const deferred = deferCreateSession(b);

    b.view().dispatch.editor.onSubmit?.('/model kimi-k2 fix the flaky test');
    // Nothing local was inserted — selection stays whatever it was
    // (untouched), and there is no fabricated row in the roster yet.
    expect(b.view().selectedId).toBeUndefined();
    const out = b.render();
    expect(out).not.toContain('fix the flaky test');

    deferred.resolve();
    await flush();
  });

  it('a skill activation dispatch gets no placeholder either', async () => {
    const b = await boot([summary('s1')], {
      activatableCommands: {
        commands: [],
        skillCommandMap: new Map([['skill:reviewcode', 'reviewcode']]),
        pluginCommandMap: new Map(),
      },
    });
    dir = b.homeDir;
    const deferred = deferCreateSession(b);

    b.view().dispatch.editor.onSubmit?.('/skill:reviewcode check the auth module');
    expect(b.view().selectedId).toBeUndefined();

    deferred.resolve();
    await flush();
    expect(b.fake.createdSession.activateSkill).toHaveBeenCalledWith('reviewcode', 'check the auth module');
  });

  it('a placeholder row declines attach/reply/rename/pin/delete until it resolves', async () => {
    const onOpenSession = vi.fn();
    const b = await boot([summary('s1')], { onOpenSession });
    dir = b.homeDir;
    const deferred = deferCreateSession(b);

    b.view().dispatch.editor.onSubmit?.('fix the flaky test');
    const placeholderId = b.view().selectedId!;
    // The placeholder sorts to the top of Working and is pre-selected, so
    // every key below targets it via the normal list-focused routing —
    // exactly the keys a user could press during the pending window.
    expect(b.view().dispatchFocused).toBe(false);

    b.component().handleInput(ENTER); // attach
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(b.view().flashMessage).toBe('Still dispatching — try again in a moment');
    expect(b.showStatus).not.toHaveBeenCalled();

    b.component().handleInput(SPACE); // reply
    expect(b.view().replyTargetId).toBeUndefined();
    expect(b.view().flashMessage).toBe('Still dispatching — try again in a moment');

    b.component().handleInput(CTRL_R); // rename
    expect(b.view().renameDraft).toBeUndefined();
    expect(b.view().flashMessage).toBe('Still dispatching — try again in a moment');
    // The component's own inline-rename toggle can still be entered locally
    // (it doesn't ask the controller first) — typing and submitting must
    // not reach `renameSession` with the fabricated id either.
    b.component().handleInput('z');
    b.component().handleInput(ENTER);
    expect(b.fake.renameSession).not.toHaveBeenCalled();

    b.component().handleInput(CTRL_T); // pin
    expect(b.view().roster.get(placeholderId)?.pinned).toBe(false);
    expect(b.view().flashMessage).toBe('Still dispatching — try again in a moment');

    b.component().handleInput(CTRL_X); // delete (B1: must decline, not arm)
    expect(b.view().confirmDeleteId).toBeUndefined();
    expect(b.view().armedDeleteId).toBeUndefined();
    expect(b.view().flashMessage).toBe('Still dispatching — try again in a moment');
    expect(b.fake.deleteSession).not.toHaveBeenCalled();
    expect(b.fake.cancelSession).not.toHaveBeenCalled();
    expect(b.showStatus).not.toHaveBeenCalled();

    deferred.resolve();
    await flush();
  });

  it('B7: shift+enter dispatches identically, then attaches the moment the real id exists', async () => {
    const onOpenSession = vi.fn();
    const b = await boot([summary('s1')], { onOpenSession });
    dir = b.homeDir;
    // Hold the FIRST prompt call open so we can prove attach fires as soon
    // as createSession resolves — independent of whether the first turn's
    // prompt has finished.
    b.fake.createdSession.prompt.mockImplementationOnce(() => new Promise(() => {}));

    b.view().dispatch.editor.onShiftEnterSubmit?.('fix the flaky test');
    // Placeholder visible synchronously, same as plain Enter.
    const placeholderId = b.view().selectedId!;
    expect(b.view().roster.get(placeholderId)?.busy).toBe(true);
    expect(onOpenSession).not.toHaveBeenCalled();

    await flush();

    // The real id is known and attach already fired — the still-pending
    // `prompt()` call did not block it.
    expect(onOpenSession).toHaveBeenCalledWith('new-session');
    expect(b.view().viewSessions.has('new-session')).toBe(true);
    expect(b.view().roster.get('new-session')).not.toBeUndefined();
  });

  it('B7: shift+enter with no attach seam falls back to the same status hint as a manual attach', async () => {
    const b = await boot([summary('s1')]); // no onOpenSession
    dir = b.homeDir;

    b.view().dispatch.editor.onShiftEnterSubmit?.('fix the flaky test');
    await flush();

    expect(b.view().flashMessage).toBe('Attach is not available from this host');
    expect(b.showStatus).not.toHaveBeenCalled();
    // Dispatch itself still happened normally — only the attach hop declined.
    expect(b.view().viewSessions.has('new-session')).toBe(true);
    expect(b.fake.createdSession.prompt).toHaveBeenCalledWith('fix the flaky test');
  });

  // Fix round 1 (review): B7's attach hop can detach the roster view before
  // the first turn's own activateSkill/prompt call settles — a rejection
  // reaching flash()'s pushProps() then silently no-ops (view.detached),
  // unlike every other dispatch failure, which the roster view is still
  // mounted to show.
  it('B7: a first-turn failure after the attach hop reaches the host-level error surface, not the (now-unrenderable) roster flash', async () => {
    let ctrl: AgentsViewController | undefined;
    const b = await boot([summary('s1')], {
      onOpenSession: (id) => ctrl?.detachForAttach(id),
    });
    ctrl = b.controller;
    dir = b.homeDir;
    b.fake.createdSession.prompt.mockRejectedValueOnce(new Error('model unavailable'));

    b.view().dispatch.editor.onShiftEnterSubmit?.('fix the flaky test');
    await flush();

    // The attach hop already detached the roster view by the time
    // prompt() rejected — pushProps() would have silently dropped a flash
    // written to the (now-unmounted) view.
    expect(b.view().detached).toBe(true);
    expect(b.showError).toHaveBeenCalledWith(expect.stringContaining('model unavailable'));
    expect(b.view().flashMessage).toBeUndefined();
  });

  // Fix round 1 (review): `refreshRoster`'s WS-reconnect reseed
  // (`AgentsRoster.setAllRows`) fully clears the roster from the server's
  // row list only — a client-only placeholder has no server-side row to
  // survive that, and previously vanished until createSession resolved.
  it('a WS reconnect mid-dispatch re-asserts the still-in-flight placeholder instead of wiping it', async () => {
    const b = await boot([summary('s1')], { wire: true, rows: [wireRow('s1')] });
    dir = b.homeDir;
    await flush(); // the one-shot trust load settles
    const deferred = deferCreateSession(b);

    b.view().dispatch.editor.onSubmit?.('fix the flaky test');
    const placeholderId = b.view().selectedId!;
    expect(b.view().roster.get(placeholderId)).not.toBeUndefined();

    // A reconnect lands WHILE createSession is still pending — its full
    // roster reseed has no server-side row for the client-only placeholder.
    b.fake.emitConnection(true);
    await flush();

    // The placeholder must survive the reseed: same busy/title, and the
    // selection stayed on it (refreshRoster re-asserts placeholders BEFORE
    // its own dangling-selection check).
    const survivor = b.view().roster.get(placeholderId);
    expect(survivor?.busy).toBe(true);
    expect(survivor?.title).toBe('fix the flaky test');
    expect(b.view().selectedId).toBe(placeholderId);

    deferred.resolve();
    await flush();

    // Resolves normally afterward: promoted in place, no leftover
    // placeholder, no double row.
    expect(b.view().roster.get(placeholderId)).toBeUndefined();
    expect(b.view().selectedId).toBe('new-session');
    const rowCount = b
      .view()
      .roster.groups(Number.MAX_SAFE_INTEGER)
      .flatMap((group) => group.rows)
      .filter((row) => row.title === 'fix the flaky test').length;
    expect(rowCount).toBe(1);
  });
});

// ── I7: handleDispatch's success continuation, after createSession
// resolves, is the only async continuation in this controller without the
// stale-view guard every other one has. A view swap (quit-declined remount)
// or full close can land between the dispatch and the resolve. ──

describe("AgentsViewController — handleDispatch's success path survives a view swap mid-flight (I7)", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    dir = undefined;
  });

  function deferCreateSession(b: Boot): { resolve: () => void } {
    let resolve: (() => void) | undefined;
    b.fake.createSession.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolve = () => res(b.fake.createdSession as unknown as Session);
        }),
    );
    return { resolve: () => resolve?.() };
  }

  it('a view rebuilt mid-dispatch (quit declined) gets the id registered into the LIVE registry, never the dead one — and the dead write can no longer clobber it', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    const deferred = deferCreateSession(b);
    const deadView = b.view();

    b.view().dispatch.editor.onSubmit?.('fix the flaky test');
    expect(deadView.selectedId).toBeDefined(); // the A2 placeholder, on the dead view

    // Simulate "Esc during the pending dispatch → quit declined → fresh
    // view remounted": close() + show() swaps in a brand-new
    // AgentsViewState with a different identity — the same shape
    // KimiTUI.stop()'s decline path produces.
    b.controller.close();
    await b.controller.show();
    const liveView = b.view();
    expect(liveView).not.toBe(deadView);

    // The live view does something of its own BEFORE the dead dispatch
    // resolves — its persistState write lands on disk first. Without the
    // guard, the dead view's own later (unconditional) persistState call
    // would overwrite this with the dead view's stale, pin-less snapshot —
    // the exact clobber the finding documents.
    b.component().handleInput(DOWN); // onto s1
    b.component().handleInput(CTRL_T); // pin s1 on the LIVE view
    await waitForViewState(b.homeDir, { pins: new Set(['s1']), sessions: new Set(['s1']) });

    deferred.resolve();
    await flush();

    // Registered into the LIVE view's registry, not the dead one.
    expect(liveView.viewSessions.has('new-session')).toBe(true);
    expect(deadView.viewSessions.has('new-session')).toBe(false);
    // The dead view's placeholder reconcile never ran — its own local
    // (fabricated) selection is untouched, never promoted to the real id.
    expect(deadView.selectedId).not.toBe('new-session');
    // The pin survives: the dead view's write never landed, so there was
    // nothing to clobber it with.
    await waitForViewState(b.homeDir, {
      pins: new Set(['s1']),
      sessions: new Set(['s1', 'new-session']),
    });
  });

  it('a view rebuilt mid-dispatch skips the B7 auto-attach — the dispatch context is gone', async () => {
    const onOpenSession = vi.fn();
    const b = await boot([summary('s1')], { onOpenSession });
    dir = b.homeDir;
    const deferred = deferCreateSession(b);
    const deadView = b.view();

    b.view().dispatch.editor.onShiftEnterSubmit?.('fix the flaky test');
    expect(deadView.selectedId).toBeDefined();

    b.controller.close();
    await b.controller.show();
    const liveView = b.view();

    deferred.resolve();
    await flush();

    expect(onOpenSession).not.toHaveBeenCalled();
    expect(liveView.viewSessions.has('new-session')).toBe(true);
  });

  it('the view closed entirely before resolve persists the id to disk without touching the dead view or writing its stale snapshot', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    const deferred = deferCreateSession(b);
    const deadView = b.view();

    b.view().dispatch.editor.onSubmit?.('fix the flaky test');
    expect(deadView.selectedId).toBeDefined();

    // The view closes entirely (no remount) — e.g. the exit-confirm dialog
    // is accepted instead of declined.
    b.controller.close();
    expect(b.controller.isOpen).toBe(false);

    deferred.resolve();
    await flush();

    // Never re-derived from the dead view's own (placeholder-era) Sets —
    // just this one id, added to whatever is actually on disk.
    await waitForViewState(b.homeDir, {
      pins: new Set(),
      sessions: new Set(['s1', 'new-session']),
    });
    expect(deadView.viewSessions.has('new-session')).toBe(false);
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
    const b = await boot([summary('s1', { lastAssistantText: 'the answer is 42', updatedAt: Date.now() - 5_000 })]);
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(SPACE);
    const out = b.render();
    expect(out).toContain('the answer is 42');
    expect(out).toContain('5s');
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

  it('Ctrl+X closes the panel and starts the row delete arm (B1) for that row', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(SPACE);
    b.component().handleInput(CTRL_X);
    expect(b.view().replyTargetId).toBeUndefined();
    expect(b.view().dispatchFocused).toBe(false);
    expect(b.view().armedDeleteId).toBe('s1');
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
    b.view().dispatch.editor.onSubmit?.(''); // I3: reply mode rejects only empty input
    await flush();
    expect(b.view().replyTargetId).toBeUndefined();
    expect(b.render()).toContain('Reply cannot be empty');
    b.controller.close(); // clear the pending flash timer
  });

  it('I3: a short confirmation reply ("ok") sends instead of erroring', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(SPACE);
    b.view().dispatch.editor.onSubmit?.('ok');
    await flush();
    expect(b.fake.wirePrompt).toHaveBeenCalledWith({
      sessionId: 's1',
      input: [{ type: 'text', text: 'ok' }],
    });
    expect(b.view().replyTargetId).toBeUndefined();
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

  it('space on a row clears a pending row delete arm (B1)', async () => {
    const b = await boot([summary('s1'), summary('s2')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN); // s1
    b.component().handleInput(CTRL_X);
    expect(b.view().armedDeleteId).toBe('s1');
    b.component().handleInput(SPACE);
    expect(b.view().armedDeleteId).toBeUndefined();
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

  // A4: a roster accumulated over a long-lived home can hold far more rows
  // than any single boot's session count here — `loadTrust` must never fire
  // more than LOAD_TRUST_CONCURRENCY trust RPCs at once, however large `ids`
  // is, so the burst can't compete unbounded with the terminal's own
  // keypress-dispatch/render work on the same event loop.
  it('loadTrust bounds concurrent trust RPCs to LOAD_TRUST_CONCURRENCY', async () => {
    const rows = Array.from({ length: LOAD_TRUST_CONCURRENCY * 3 }, (_, i) => summary(`s${i}`));
    let inFlight = 0;
    let maxInFlight = 0;
    const pending: Array<() => void> = [];
    const b = await boot(rows, {
      wire: true,
      trust: () =>
        new Promise<boolean>((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          pending.push(() => {
            inFlight -= 1;
            resolve(true);
          });
        }),
    });
    dir = b.homeDir;
    await flush();
    // Every worker's first RPC is already in flight — the bound holds from
    // the very first tick, not just "eventually" after some backlog drains.
    expect(pending.length).toBe(LOAD_TRUST_CONCURRENCY);
    expect(maxInFlight).toBeLessThanOrEqual(LOAD_TRUST_CONCURRENCY);
    // Release them one at a time; each release immediately backfills from
    // the remaining ids, and the bound must keep holding as it does.
    while (pending.length > 0) {
      pending.shift()!();
      await flush();
      expect(maxInFlight).toBeLessThanOrEqual(LOAD_TRUST_CONCURRENCY);
    }
    expect(b.view().roster.get(`s${rows.length - 1}`)?.trusted).toBe(true);
  });

  // A4: pins the mechanism `show()`'s own doc comments already promise —
  // trust/skill warm-up "must never block or break show()". Holding both
  // warm-up calls open (never resolving) and asserting the roster still
  // painted proves `show()` doesn't await either one, and that focus lands
  // on the roster before any warm-up work could possibly have finished —
  // the exact ordering this task's brief calls out as the regression shape
  // to guard against ("input handler registered late").
  it('show() paints the roster and sets focus without waiting on trust/skill warm-up', async () => {
    const b = await boot([summary('s1'), summary('s2')], {
      wire: true,
      trust: () => new Promise<boolean>(() => {}), // never resolves
      warmAgentsViewSkillMenu: () => new Promise<void>(() => {}), // never resolves
    });
    dir = b.homeDir;
    // controller.show() has already returned inside boot() at this point —
    // both warm-up promises above are still pending (they can never
    // resolve), yet the paint must already have happened.
    expect(b.ui.setFocus).toHaveBeenCalledWith(b.component());
    expect(b.ui.requestRender).toHaveBeenCalledWith(true);
    expect(b.render()).toContain('s1 title');
    expect(b.render()).toContain('s2 title');
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

describe('AgentsViewController — Esc on the slash menu clears the composer (B11, narrowed by I4)', () => {
  let dir: string | undefined;
  let extraDir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) {
      // maxRetries: a fire-and-forget persistState can still be mid-write
      // (ENOTEMPTY on rmdir) when the test body returns.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    dir = undefined;
    if (extraDir !== undefined) {
      await rm(extraDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    extraDir = undefined;
  });

  /** Same wait shape the @-mention functional test uses: the autocomplete
   *  fetch is debounced by a real timer, then resolves over a couple of
   *  microtask turns. */
  async function waitForAutocomplete(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await Promise.resolve();
    await Promise.resolve();
  }

  it('Esc while the slash menu is open closes it AND clears the composer to its placeholder, in one keypress', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    for (const ch of '/mo') b.component().handleInput(ch);
    await waitForAutocomplete();
    expect(b.view().dispatch.editor.isShowingAutocomplete()).toBe(true);
    expect(b.view().dispatch.editor.getText()).toBe('/mo');

    b.component().handleInput(ESC);

    expect(b.view().dispatch.editor.isShowingAutocomplete()).toBe(false);
    expect(b.view().dispatch.editor.getText()).toBe('');
  });

  it('Esc with composer text but no menu open keeps its current behavior (pin-down): unfocuses, text untouched', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    for (const ch of 'do stuff') b.component().handleInput(ch);
    expect(b.view().dispatch.editor.isShowingAutocomplete()).toBe(false);

    b.component().handleInput(ESC);

    expect(b.view().dispatchFocused).toBe(false);
    expect(b.view().dispatch.editor.getText()).toBe('do stuff');
    expect(b.controller.isOpen).toBe(true);
  });

  it('a reply-panel composer declines: the menu closes but an in-progress reply is not wiped', async () => {
    const b = await boot([summary('s1')], { wire: true });
    dir = b.homeDir;
    b.component().handleInput(DOWN); // select row s1
    b.component().handleInput(SPACE); // open the reply panel on s1
    for (const ch of '/mo') b.component().handleInput(ch);
    await waitForAutocomplete();
    expect(b.view().dispatch.editor.isShowingAutocomplete()).toBe(true);

    b.component().handleInput(ESC);

    expect(b.view().dispatch.editor.isShowingAutocomplete()).toBe(false);
    expect(b.view().replyTargetId).toBe('s1');
    expect(b.view().dispatch.editor.getText()).toBe('/mo');
  });

  // I4: hasAutocompleteActivity() (the editor's own Esc-routing gate) is
  // true for an open dropdown AND for a pending debounce/abort timer — so
  // this hook also fires for a mid-sentence @-mention and for a keystroke
  // still inside the debounce window. B11's own stated scope is the slash
  // menu only ("`/` and whatever else was typed keeps sitting in the
  // composer") — a draft that isn't itself a slash command in progress
  // must survive Esc here.
  it('I4: Esc dismissing a mid-sentence @-mention dropdown closes it but preserves the whole draft', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'agents-view-i4-mention-'));
    extraDir = workDir;
    await writeFile(join(workDir, 'readme.md'), '# hi');
    const b = await boot([summary('s1')], { workDir });
    dir = b.homeDir;

    for (const ch of 'fix the bug in @') b.component().handleInput(ch);
    await waitForAutocomplete();
    expect(b.view().dispatch.editor.isShowingAutocomplete()).toBe(true);

    b.component().handleInput(ESC);

    expect(b.view().dispatch.editor.isShowingAutocomplete()).toBe(false);
    // The draft is not a slash command — B11's scope — so it survives whole.
    expect(b.view().dispatch.editor.getText()).toBe('fix the bug in @');
  });

  it('I4: Esc landing inside the debounce window (nothing shown yet) preserves the draft', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;

    // No waitForAutocomplete(): the debounce timer is armed but hasn't
    // fired yet — hasAutocompleteActivity() is already true (a pending
    // timer counts, not just a visible dropdown), so this exercises the
    // same Esc-routing gate before anything is on screen.
    for (const ch of 'fix the bug in @') b.component().handleInput(ch);
    expect(b.view().dispatch.editor.isShowingAutocomplete()).toBe(false);

    b.component().handleInput(ESC);

    expect(b.view().dispatch.editor.getText()).toBe('fix the bug in @');
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

describe('AgentsViewController — grouping mode (Ctrl+S, A6)', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    dir = undefined;
  });

  it('defaults to state grouping when the host has no persisted preference', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    expect(b.view().groupMode).toBe('state');
    expect(b.render()).toContain('Completed');
  });

  it('seeds the initial mode from host.agentsViewGroupMode() at show()', async () => {
    const b = await boot([summary('s1', { workDir: '/srv/repos/sample-repo' })], { groupMode: 'directory' });
    dir = b.homeDir;
    expect(b.view().groupMode).toBe('directory');
    const out = b.render();
    expect(out).toContain('/srv/repos/sample-repo');
    expect(out).not.toContain('Completed');
  });

  it('Ctrl+S cycles state -> directory -> state', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(CTRL_S);
    expect(b.view().groupMode).toBe('directory');
    b.component().handleInput(CTRL_S);
    expect(b.view().groupMode).toBe('state');
  });

  it('the regrouped list is on screen immediately, before persistence settles', async () => {
    const b = await boot([summary('s1', { workDir: '/srv/repos/sample-repo' })]);
    dir = b.homeDir;
    b.component().handleInput(CTRL_S);
    // No flush() — the render assertion runs before the fire-and-forget
    // saveAgentsViewGroupMode call has any chance to settle.
    expect(b.render()).toContain('/srv/repos/sample-repo');
  });

  it('persists every Ctrl+S toggle via host.saveAgentsViewGroupMode, in order', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(CTRL_S);
    await flush();
    expect(b.savedGroupModes).toEqual(['directory']);
    b.component().handleInput(CTRL_S);
    await flush();
    expect(b.savedGroupModes).toEqual(['directory', 'state']);
  });

  it('a failed persist still applies the mode in memory and flashes instead of throwing', async () => {
    const b = await boot([summary('s1')], {
      saveAgentsViewGroupMode: async () => {
        throw new Error('disk full');
      },
    });
    dir = b.homeDir;
    b.component().handleInput(CTRL_S);
    await flush();
    expect(b.view().groupMode).toBe('directory');
    expect(b.view().flashMessage).toContain('disk full');
  });

  it('any other action clears a pending row delete arm (B1), same as every other action', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput(DOWN);
    b.component().handleInput(CTRL_X);
    expect(b.view().armedDeleteId).toBe('s1');
    b.component().handleInput(CTRL_S);
    expect(b.view().armedDeleteId).toBeUndefined();
  });

  it('the help grid advertises ctrl+s to switch views', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    b.component().handleInput('?');
    const out = b.render();
    expect(out).toContain('ctrl+s');
    expect(out).toContain('to switch views');
  });

  it('directory mode buckets rows by workDir, pinned floats first, directories sort by label, Other last', async () => {
    const b = await boot([
      summary('zeta-row', { workDir: '/srv/repos/zeta-app', updatedAt: 300 }),
      summary('alpha-row', { workDir: '/srv/repos/alpha-app', updatedAt: 200 }),
      summary('homeless-row', { workDir: '', updatedAt: 100 }),
    ]);
    dir = b.homeDir;
    // Pin zeta-row directly (setup, not exercising the keyboard pin flow) —
    // same "mutate the view/roster in place for test setup" pattern the
    // reply-state tests above already use.
    b.view().roster.setPinned('zeta-row', true);

    b.component().handleInput(CTRL_S);
    const out = b.render();
    const pinnedIdx = out.indexOf('Pinned');
    const alphaIdx = out.indexOf('/srv/repos/alpha-app');
    const otherIdx = out.indexOf('Other');
    expect(pinnedIdx).toBeGreaterThan(-1);
    expect(alphaIdx).toBeGreaterThan(pinnedIdx);
    expect(otherIdx).toBeGreaterThan(alphaIdx);
    // zeta-row is pinned — it floats into Pinned, not its own directory group.
    expect(out).toContain('zeta-row title');
    expect(out).not.toContain('/srv/repos/zeta-app');
    expect(out).toContain('homeless-row title');
  });

  it('selection survives a mode switch, following the row by id (A5 contract reused)', async () => {
    const b = await boot([
      summary('s1', { workDir: '/srv/repos/alpha-app', updatedAt: 200 }),
      summary('s2', { workDir: '/srv/repos/zeta-app', updatedAt: 100 }),
    ]);
    dir = b.homeDir;
    b.component().handleInput(DOWN); // off the group header, onto s1 (most recent)
    expect(b.view().selectedId).toBe('s1');

    b.component().handleInput(CTRL_S);
    expect(b.view().selectedId).toBe('s1');
    expect(selectedLine(b.render())).toContain('s1 title');
  });

  it("collapsing Pinned in one mode does not carry into the other mode's Pinned group (review round 1, Important finding #2 — ids must actually be namespaced, not just documented as disjoint)", async () => {
    const b = await boot([summary('p1', { workDir: '/srv/repos/alpha-app' })]);
    dir = b.homeDir;
    b.view().roster.setPinned('p1', true);

    // Collapse Pinned using state mode's real group id, then switch to
    // directory mode: its Pinned group uses a different id
    // (`directory-pinned`, not `pinned`) precisely so this never collapses
    // it too.
    b.view().collapsedGroups.add('pinned');
    b.component().handleInput(CTRL_S); // -> directory mode
    let out = b.render();
    expect(out).toContain('Pinned');
    expect(out).toContain('p1 title');

    // And the reverse: collapse directory mode's Pinned, switch back to
    // state mode — its Pinned group must still be expanded.
    b.view().collapsedGroups.clear();
    b.view().collapsedGroups.add('directory-pinned');
    b.component().handleInput(CTRL_S); // -> state mode
    out = b.render();
    expect(out).toContain('Pinned');
    expect(out).toContain('p1 title');
  });

  it('Ctrl+X on a directory group header archives only that directory\'s rows (would fail without mode-aware group lookup)', async () => {
    const b = await boot([
      summary('a1', { workDir: '/srv/repos/alpha-app' }),
      summary('a2', { workDir: '/srv/repos/alpha-app' }),
      summary('z1', { workDir: '/srv/repos/zeta-app' }),
    ]);
    dir = b.homeDir;
    b.component().handleInput(CTRL_S); // directory mode; selection starts on
    // the first group header — alphabetically first is alpha-app.
    b.component().handleInput(CTRL_X);
    expect(b.view().confirmDeleteId).toBe('group:dir:/srv/repos/alpha-app');
    expect(b.render()).toContain('Archive all sessions in "/srv/repos/alpha-app"?');
    b.component().handleInput(CTRL_X);
    await flush();
    expect(b.fake.deleteSession).toHaveBeenCalledWith('a1');
    expect(b.fake.deleteSession).toHaveBeenCalledWith('a2');
    expect(b.fake.deleteSession).not.toHaveBeenCalledWith('z1');
  });

  it('an in-flight A2 dispatch placeholder buckets under its own (known) workDir, not Other', async () => {
    const b = await boot([summary('s1')]); // default workDir '/home/user/project'
    dir = b.homeDir;
    let resolveCreate: (() => void) | undefined;
    b.fake.createSession.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveCreate = () => res(b.fake.createdSession as unknown as Session);
        }),
    );

    b.view().dispatch.editor.onSubmit?.('fix the flaky test');
    // Still pending — the placeholder is on screen with its real, known
    // workDir (agentsViewWorkDir()) already, before the real session id exists.
    b.component().handleInput(CTRL_S);
    const out = b.render();
    expect(out).toContain('fix the flaky test');
    expect(out).not.toContain('Other');
    expect(out).toContain('/home/user/project');
    // Same directory as the pre-existing s1 — one group, not two.
    expect(out).toContain('s1 title');

    resolveCreate?.();
    await flush();
    b.controller.close();
  });
});

describe('AgentsViewController — empty-fleet skeleton (B10)', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    dir = undefined;
  });

  it('zero rows in state mode: every band header renders with its description line', async () => {
    const b = await boot([]);
    dir = b.homeDir;
    expect(b.view().groupMode).toBe('state');
    const out = b.render();
    expect(out).toContain('Needs input');
    expect(out).toContain('Sessions that have a question or need your decision land here');
    expect(out).toContain('Working');
    expect(out).toContain('Sessions Kimi is actively working on — they keep running even if you close the terminal');
    expect(out).toContain('Completed');
    expect(out).toContain('Finished sessions wait here for you to review');
  });

  it('zero rows in directory mode: a plain line, no band headers', async () => {
    const b = await boot([], { groupMode: 'directory' });
    dir = b.homeDir;
    const out = b.render();
    expect(out).toContain('no sessions yet');
    expect(out).not.toContain('Needs input');
    expect(out).not.toContain('Working');
    expect(out).not.toContain('Completed');
  });

  it('one real row: descriptions are absent', async () => {
    const b = await boot([summary('s1')]);
    dir = b.homeDir;
    const out = b.render();
    expect(out).toContain('s1 title');
    expect(out).not.toContain('Sessions that have a question or need your decision land here');
    expect(out).not.toContain('Sessions Kimi is actively working on');
    expect(out).not.toContain('Finished sessions wait here for you to review');
  });

  it('switching Ctrl+S from empty state mode to empty directory mode swaps the skeleton for the plain line', async () => {
    const b = await boot([]);
    dir = b.homeDir;
    expect(b.render()).toContain('Needs input');
    b.component().handleInput(CTRL_S);
    expect(b.view().groupMode).toBe('directory');
    const out = b.render();
    expect(out).toContain('no sessions yet');
    expect(out).not.toContain('Needs input');
  });
});
