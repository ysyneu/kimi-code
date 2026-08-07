import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  log,
  SDKRpcClientWire,
  type ApprovalHandler,
  type ApprovalRequest,
  type Event,
  type GoalSnapshot,
  type SkillSummary,
} from '@moonshot-ai/kimi-code-sdk';
import type { MigrationPlan } from '@moonshot-ai/migration-legacy';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BannerProvider } from '#/tui/banner/banner-provider';
import { readBannerDisplayState } from '#/tui/banner/state';
import { handleLoginCommand, handleLogoutCommand } from '#/tui/commands/auth';
import { promptPlatformSelection, promptLogoutProviderSelection } from '#/tui/commands/prompts';
import { AgentsExitConfirmComponent } from '#/tui/components/agents-view/exit-confirm';
import { BannerComponent } from '#/tui/components/chrome/banner';
import { WelcomeComponent } from '#/tui/components/chrome/welcome';
import { ApprovalPanelComponent } from '#/tui/components/dialogs/approval-panel';
import { KimiTUI, type KimiTUIStartupInput, type TUIState } from '#/tui/kimi-tui';
import type { ApprovalController } from '#/tui/reverse-rpc/approval/controller';
import { REPLAY_TURN_LIMIT } from '#/tui/utils/message-replay';
import { copyTextToClipboard } from '#/utils/clipboard/clipboard-text';
import { quoteShellArg } from '#/utils/shell-quote';
import {
  DISABLE_TERMINAL_THEME_REPORTING,
  ENABLE_TERMINAL_THEME_REPORTING,
  OSC11_QUERY,
  QUERY_TERMINAL_THEME,
  TERMINAL_THEME_LIGHT,
} from '#/tui/utils/terminal-theme';

vi.mock('#/tui/commands/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/tui/commands/prompts')>();
  return { ...actual, promptPlatformSelection: vi.fn(), promptLogoutProviderSelection: vi.fn() };
});
vi.mock('#/utils/clipboard/clipboard-text', () => ({
  copyTextToClipboard: vi.fn(async () => {}),
}));

const copyTextToClipboardMock = vi.mocked(copyTextToClipboard);

interface StartupDriver {
  state: TUIState;
  init(): Promise<boolean>;
  handleLoginCommand(): Promise<void>;
  handleLogoutCommand(): Promise<void>;
  stop(exitCode?: number): Promise<void>;
}

interface RuntimeStateDriver extends StartupDriver {
  closeSession(reason: string): Promise<void>;
}

interface ThemeTrackingDriver extends StartupDriver {
  refreshTerminalThemeTracking(): void;
}

interface MigrateExitDriver extends StartupDriver {
  start(): Promise<void>;
  onExit?: (code?: number) => Promise<void>;
  runMigrationScreen(plan: unknown): Promise<unknown>;
  initMainTui(): Promise<boolean>;
  terminalFocusTrackingDispose?: () => void;
}

const MIGRATION_PLAN: MigrationPlan = {
  sourceHome: '/x/.kimi',
  hasConfig: false,
  hasMcp: false,
  hasUserHistory: false,
  oauthCredentials: [],
  workdirs: [],
  detectedPlugins: [],
  detectedMcpOauthServers: [],
  totalSessions: 0,
};

function makeStartupInput(
  cliOptions: Partial<KimiTUIStartupInput['cliOptions']> = {},
  tuiConfig: Partial<KimiTUIStartupInput['tuiConfig']> = {},
): KimiTUIStartupInput {
  return {
    cliOptions: {
      session: undefined,
      continue: false,
      yolo: false,
      auto: false,
      plan: false,
      model: undefined,
      outputFormat: undefined,
      prompt: undefined,
      skillsDirs: [],
      agent: undefined,
      agentFiles: [],
      ...cliOptions,
    },
    tuiConfig: {
      theme: 'dark',
      disablePasteBurst: false,
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
      statusLine: { items: null, command: null },
      ...tuiConfig,
    },
    version: '0.0.0-test',
    workDir: '/tmp/proj-a',
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ses-1',
    model: 'k2',
    summary: { title: 'Session title' },
    getStatus: vi.fn(async () => ({
      model: 'k2',
      thinkingEffort: 'off',
      permission: 'manual',
      planMode: false,
      contextTokens: 10,
      maxContextTokens: 100,
      contextUsage: 0.1,
    })),
    setApprovalHandler: vi.fn(),
    setQuestionHandler: vi.fn(),
    setModel: vi.fn(async () => {}),
    setThinking: vi.fn(async () => {}),
    setPermission: vi.fn(async () => {}),
    setPlanMode: vi.fn(async () => {}),
    getGoal: vi.fn(async () => ({ goal: null })),
    onEvent: vi.fn(() => () => {}),
    getResumeState: vi.fn(() => null),
    listSkills: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

function goalSnapshot(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    goalId: 'goal-1',
    objective: 'Ship feature X',
    status: 'paused',
    turnsUsed: 2,
    tokensUsed: 100,
    wallClockMs: 1000,
    budget: {
      tokenBudget: null,
      turnBudget: null,
      wallClockBudgetMs: null,
      remainingTokens: null,
      remainingTurns: null,
      remainingWallClockMs: null,
      tokenBudgetReached: false,
      turnBudgetReached: false,
      wallClockBudgetReached: false,
      overBudget: false,
    },
    ...overrides,
  };
}

function createResumeState(
  overrides: { permissionMode?: string; planMode?: boolean; replay?: readonly unknown[] } = {},
) {
  return {
    id: 'ses-latest',
    workDir: '/tmp/proj-a',
    sessionDir: '/tmp/proj-a/.kimi/sessions/ses-latest',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sessionMetadata: {},
    agents: {
      main: {
        type: 'main',
        config: {
          cwd: '/tmp/proj-a',
          modelCapabilities: { max_context_tokens: 100 },
          thinkingEffort: 'off',
          systemPrompt: '',
        },
        context: { history: [], tokenCount: 10 },
        replay: overrides.replay ?? [],
        permission: { mode: overrides.permissionMode ?? 'manual', rules: [] },
        plan: overrides.planMode ? { id: 'plan-1', content: '', path: '/tmp/plan.md' } : null,
        swarmMode: false,
        usage: {},
        tools: [],
        background: [],
      },
    },
  } as never;
}

function loginRequiredError(): Error & { readonly code: string } {
  return Object.assign(new Error('OAuth provider "managed:kimi-code" requires login.'), {
    code: 'auth.login_required',
  });
}

function makeHarness(session = makeSession(), overrides: Record<string, unknown> = {}) {
  return {
    getConfig: vi.fn(async () => ({
      models: {
        k2: { model: 'moonshot-v1', maxContextSize: 100 },
      },
    })),
    createSession: vi.fn(async () => session),
    resumeSession: vi.fn(async () => session),
    listSessions: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    track: vi.fn(),
    setTelemetryContext: vi.fn(),
    getExperimentalFeatures: vi.fn(async () => []),
    // No fixture here runs the wire transport — the agents view's
    // wire-only narrowing (AgentsViewController.show) must see "unavailable".
    wireRpc: vi.fn(() => undefined),
    auth: {
      status: vi.fn(async () => ({ providers: [] })),
      login: vi.fn(async () => {}),
      logout: vi.fn(),
      getManagedUsage: vi.fn(),
    },
    ...overrides,
  };
}

function makeDriver(harness: ReturnType<typeof makeHarness>, input: KimiTUIStartupInput) {
  const driver = new KimiTUI(harness as never, input) as unknown as StartupDriver;
  vi.spyOn(driver.state.ui, 'requestRender').mockImplementation(() => {});
  vi.spyOn(driver.state.terminal, 'setProgress').mockImplementation(() => {});
  return driver;
}

type InputListener = Parameters<TUIState['ui']['addInputListener']>[0];
const DARK_OSC11_REPORT = '\u001B]11;rgb:2828/2c2c/3434\u0007';
const LIGHT_OSC11_REPORT = '\u001B]11;rgb:fafa/fbfb/fcfc\u0007';

function captureInputListeners(driver: StartupDriver) {
  const listeners: InputListener[] = [];
  const removeInputListener = vi.fn<() => void>();
  const write = vi.spyOn(driver.state.terminal, 'write').mockImplementation(() => {});
  const addInputListener = vi
    .spyOn(driver.state.ui, 'addInputListener')
    .mockImplementation((listener: InputListener) => {
      listeners.push(listener);
      return removeInputListener;
    });

  return { listeners, removeInputListener, write, addInputListener };
}

describe('KimiTUI startup', () => {
  it('creates a fresh session from startup flags and syncs runtime state', async () => {
    const session = makeSession({
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'yolo',
        planMode: true,
        contextTokens: 25,
        maxContextTokens: 200,
        contextUsage: 0.125,
      })),
    });
    const harness = makeHarness(session);
    const driver = makeDriver(harness, makeStartupInput({ yolo: true, plan: true }));

    await expect(driver.init()).resolves.toBe(false);

    expect(harness.createSession).toHaveBeenCalledWith({
      workDir: '/tmp/proj-a',
      permission: 'yolo',
      planMode: true,
    });
    expect(session.setApprovalHandler).toHaveBeenCalledOnce();
    expect(session.setQuestionHandler).toHaveBeenCalledOnce();
    expect(harness.setTelemetryContext).toHaveBeenCalledWith({ sessionId: null });
    expect(harness.setTelemetryContext).toHaveBeenLastCalledWith({ sessionId: 'ses-1' });
    expect(driver.state.startupState).toBe('ready');
    expect(driver.state.appState).toMatchObject({
      sessionId: 'ses-1',
      model: 'k2',
      permissionMode: 'yolo',
      planMode: true,
      contextTokens: 25,
      maxContextTokens: 200,
      contextUsage: 0.125,
      sessionTitle: 'Session title',
    });
  });

  it('binds the resolved agent profile and agent files to the startup session', async () => {
    const session = makeSession();
    const harness = makeHarness(session);
    const driver = makeDriver(harness, {
      ...makeStartupInput({ agent: 'reviewer', agentFiles: ['reviewer.md'] }),
      agentProfile: 'reviewer',
    });

    await expect(driver.init()).resolves.toBe(false);

    expect(harness.createSession).toHaveBeenCalledWith({
      workDir: '/tmp/proj-a',
      agentProfile: 'reviewer',
      agentFiles: ['reviewer.md'],
    });
    expect(driver.state.startupState).toBe('ready');
  });

  it('resumes the latest session for --continue and marks history for replay', async () => {
    const session = makeSession({ id: 'ses-latest' });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-latest' }, { id: 'ses-old' }]),
    });
    const driver = makeDriver(harness, makeStartupInput({ continue: true }));

    await expect(driver.init()).resolves.toBe(true);

    expect(harness.resumeSession).toHaveBeenCalledWith({
      id: 'ses-latest',
      replayTurnLimit: REPLAY_TURN_LIMIT,
    });
    expect(harness.createSession).not.toHaveBeenCalled();
    expect(driver.state.startupState).toBe('ready');
    expect(driver.state.appState.sessionId).toBe('ses-latest');
  });

  it('applies --auto permission when resuming a session via --continue', async () => {
    let permission = 'manual';
    const session = makeSession({
      id: 'ses-latest',
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission,
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
      setPermission: vi.fn(async (mode: string) => {
        permission = mode;
      }),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-latest' }]),
    });
    const driver = makeDriver(harness, makeStartupInput({ continue: true, auto: true }));

    await expect(driver.init()).resolves.toBe(true);

    expect(session.setPermission).toHaveBeenCalledWith('auto');
    expect(driver.state.appState.permissionMode).toBe('auto');
  });

  it('applies --yolo permission when resuming a session via --continue', async () => {
    let permission = 'manual';
    const session = makeSession({
      id: 'ses-latest',
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission,
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
      setPermission: vi.fn(async (mode: string) => {
        permission = mode;
      }),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-latest' }]),
    });
    const driver = makeDriver(harness, makeStartupInput({ continue: true, yolo: true }));

    await expect(driver.init()).resolves.toBe(true);

    expect(session.setPermission).toHaveBeenCalledWith('yolo');
    expect(driver.state.appState.permissionMode).toBe('yolo');
  });

  it('applies --plan mode when resuming a session via --continue', async () => {
    let planMode = false;
    const session = makeSession({
      id: 'ses-latest',
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'manual',
        planMode,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
      setPlanMode: vi.fn(async (enabled: boolean) => {
        planMode = enabled;
      }),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-latest' }]),
    });
    const driver = makeDriver(harness, makeStartupInput({ continue: true, plan: true }));

    await expect(driver.init()).resolves.toBe(true);

    expect(session.setPlanMode).toHaveBeenCalledWith(true);
    expect(driver.state.appState.planMode).toBe(true);
  });

  it('skips setPlanMode when the resumed session is already in plan mode', async () => {
    const session = makeSession({
      id: 'ses-latest',
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'manual',
        planMode: true,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
      setPlanMode: vi.fn(async () => {
        throw new Error('Already in plan mode');
      }),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-latest' }]),
    });
    const driver = makeDriver(harness, makeStartupInput({ continue: true, plan: true }));

    await expect(driver.init()).resolves.toBe(true);

    expect(session.setPlanMode).not.toHaveBeenCalled();
    expect(driver.state.appState.planMode).toBe(true);
  });

  it('forces footer state to reflect --auto even if getStatus lags behind', async () => {
    const session = makeSession({
      id: 'ses-latest',
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'manual',
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
      setPermission: vi.fn(async () => {}),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-latest' }]),
    });
    const driver = makeDriver(harness, makeStartupInput({ continue: true, auto: true }));

    await expect(driver.init()).resolves.toBe(true);

    expect(session.setPermission).toHaveBeenCalledWith('auto');
    expect(driver.state.appState.permissionMode).toBe('auto');
  });

  it('forces footer state to reflect --plan even if getStatus lags behind', async () => {
    const session = makeSession({
      id: 'ses-latest',
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'manual',
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
      setPlanMode: vi.fn(async () => {}),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-latest' }]),
    });
    const driver = makeDriver(harness, makeStartupInput({ continue: true, plan: true }));

    await expect(driver.init()).resolves.toBe(true);

    expect(session.setPlanMode).toHaveBeenCalledWith(true);
    expect(driver.state.appState.planMode).toBe(true);
  });

  it('keeps --auto in the footer after session replay hydration', async () => {
    const session = makeSession({
      id: 'ses-latest',
      getResumeState: vi.fn(() => createResumeState({ permissionMode: 'manual', planMode: false })),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-latest' }]),
    });
    const driver = makeDriver(harness, makeStartupInput({ continue: true, auto: true }));

    await expect(driver.init()).resolves.toBe(true);
    await (
      driver as unknown as {
        finishStartup(shouldReplayHistory: boolean): Promise<void>;
      }
    ).finishStartup(true);

    expect(driver.state.appState.permissionMode).toBe('auto');
  });

  it('keeps --plan in the footer after session replay hydration', async () => {
    const session = makeSession({
      id: 'ses-latest',
      getResumeState: vi.fn(() => createResumeState({ permissionMode: 'manual', planMode: false })),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-latest' }]),
    });
    const driver = makeDriver(harness, makeStartupInput({ continue: true, plan: true }));

    await expect(driver.init()).resolves.toBe(true);
    await (
      driver as unknown as {
        finishStartup(shouldReplayHistory: boolean): Promise<void>;
      }
    ).finishStartup(true);

    expect(driver.state.appState.planMode).toBe(true);
  });

  it('applies --auto permission when resuming an explicit session', async () => {
    let permission = 'manual';
    const session = makeSession({
      id: 'ses-target',
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission,
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
      setPermission: vi.fn(async (mode: string) => {
        permission = mode;
      }),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-target', workDir: '/tmp/proj-a' }]),
    });
    const driver = makeDriver(harness, makeStartupInput({ session: 'ses-target', auto: true }));

    await expect(driver.init()).resolves.toBe(true);

    expect(session.setPermission).toHaveBeenCalledWith('auto');
    expect(driver.state.appState.permissionMode).toBe('auto');
  });

  it('syncs a persisted goal when resuming a session', async () => {
    const goal = goalSnapshot({ status: 'blocked', terminalReason: 'needs input' });
    const session = makeSession({
      id: 'ses-latest',
      getGoal: vi.fn(async () => ({ goal })),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-latest' }]),
      getExperimentalFeatures: vi.fn(async () => [{ id: 'micro_compaction', enabled: true }]),
    });
    const driver = makeDriver(harness, makeStartupInput({ continue: true }));

    await expect(driver.init()).resolves.toBe(true);

    expect(session.getGoal).toHaveBeenCalledOnce();
    expect(driver.state.appState.goal).toEqual(goal);
  });

  it('syncs goal state regardless of the goal flag', async () => {
    const goal = goalSnapshot();
    const session = makeSession({
      getGoal: vi.fn(async () => ({ goal })),
    });
    const harness = makeHarness(session);
    const driver = makeDriver(harness, makeStartupInput());

    await expect(driver.init()).resolves.toBe(false);

    expect(session.getGoal).toHaveBeenCalledOnce();
    expect(driver.state.appState.goal).toEqual(goal);
  });

  it('clears goal state when closing the current session', async () => {
    const goal = goalSnapshot();
    const session = makeSession({
      getGoal: vi.fn(async () => ({ goal })),
    });
    const harness = makeHarness(session, {
      getExperimentalFeatures: vi.fn(async () => [{ id: 'micro_compaction', enabled: true }]),
    });
    const driver = makeDriver(harness, makeStartupInput()) as unknown as RuntimeStateDriver;

    await expect(driver.init()).resolves.toBe(false);
    expect(driver.state.appState.goal).toEqual(goal);

    await driver.closeSession('test close');

    expect(driver.state.appState.goal).toBeNull();
  });

  it('passes the CLI model override when creating a fresh startup session', async () => {
    const harness = makeHarness();
    const driver = makeDriver(harness, makeStartupInput({ model: 'kimi-code/k2.5' }));

    await expect(driver.init()).resolves.toBe(false);

    expect(harness.createSession).toHaveBeenCalledWith({
      workDir: '/tmp/proj-a',
      model: 'kimi-code/k2.5',
      permission: undefined,
      planMode: undefined,
    });
  });

  it('applies the CLI model override when resuming a startup session', async () => {
    let model = 'k2';
    const session = makeSession({
      setModel: vi.fn(async (nextModel: string) => {
        model = nextModel;
      }),
      getStatus: vi.fn(async () => ({
        model,
        thinkingEffort: 'off',
        permission: 'manual',
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-latest' }]),
    });
    const driver = makeDriver(
      harness,
      makeStartupInput({ continue: true, model: 'kimi-code/k2.5' }),
    );

    await expect(driver.init()).resolves.toBe(true);

    expect(session.setModel).toHaveBeenCalledWith('kimi-code/k2.5');
    expect(driver.state.appState.model).toBe('kimi-code/k2.5');
  });

  it('enters picker startup for bare --session without creating a session', async () => {
    const harness = makeHarness();
    const driver = makeDriver(harness, makeStartupInput({ session: '' }));

    await expect(driver.init()).resolves.toBe(false);

    expect(harness.createSession).not.toHaveBeenCalled();
    expect(harness.resumeSession).not.toHaveBeenCalled();
    expect(driver.state.startupState).toBe('picker');
  });

  it('enters agents-view startup without creating a session and mounts the view in finishStartup', async () => {
    const harness = makeHarness();
    const driver = makeDriver(harness, { ...makeStartupInput(), startupAgentsView: true });
    const tui = driver as unknown as {
      agentsViewController: { show(): Promise<void> };
      finishStartup(shouldReplayHistory: boolean): Promise<void>;
    };
    const show = vi.spyOn(tui.agentsViewController, 'show').mockImplementation(async () => {});

    await expect(driver.init()).resolves.toBe(false);

    expect(harness.createSession).not.toHaveBeenCalled();
    expect(harness.resumeSession).not.toHaveBeenCalled();
    expect(driver.state.startupState).toBe('agents-view');

    await tui.finishStartup(false);
    expect(show).toHaveBeenCalledOnce();
  });

  it('closing the agents view during agents-view startup stops the TUI', async () => {
    const harness = makeHarness();
    const driver = makeDriver(harness, { ...makeStartupInput(), startupAgentsView: true });
    await driver.init();
    const stop = vi.spyOn(driver, 'stop').mockImplementation(async () => {});

    (driver as unknown as { setAgentsView(value: unknown): void }).setAgentsView(undefined);

    expect(stop).toHaveBeenCalledOnce();
  });

  it('closing the agents view in a normal session does not stop the TUI', async () => {
    const harness = makeHarness();
    const driver = makeDriver(harness, makeStartupInput());
    await driver.init();
    const stop = vi.spyOn(driver, 'stop').mockImplementation(async () => {});

    (driver as unknown as { setAgentsView(value: unknown): void }).setAgentsView(undefined);

    expect(stop).not.toHaveBeenCalled();
  });

  it('agentsViewServerLabel defaults to embedded and honors the startup override', () => {
    const harness = makeHarness();
    const embedded = makeDriver(harness, makeStartupInput());
    expect(
      (embedded as unknown as { agentsViewServerLabel(): string }).agentsViewServerLabel(),
    ).toBe('embedded');

    const attached = makeDriver(harness, {
      ...makeStartupInput(),
      startupAgentsView: true,
      agentsViewServerLabel: '127.0.0.1:58627',
    });
    expect(
      (attached as unknown as { agentsViewServerLabel(): string }).agentsViewServerLabel(),
    ).toBe('127.0.0.1:58627');
  });

  it('applies --auto after picking a session from bare --session', async () => {
    let permission = 'manual';
    const session = makeSession({
      id: 'ses-picked',
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission,
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
      setPermission: vi.fn(async (mode: string) => {
        permission = mode;
      }),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [
        {
          id: 'ses-picked',
          title: 'Picked session',
          workDir: '/tmp/proj-a',
          updatedAt: Date.now(),
        },
      ]),
    });
    const driver = makeDriver(harness, makeStartupInput({ session: '', auto: true }));

    await (driver as unknown as { initMainTui(): Promise<boolean> }).initMainTui();
    expect(driver.state.startupState).toBe('picker');
    await (driver as unknown as { bootstrapFromPicker(): Promise<void> }).bootstrapFromPicker();

    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\r');
    await new Promise((resolve) => setImmediate(resolve));

    expect(session.setPermission).toHaveBeenCalledWith('auto');
    expect(driver.state.appState.permissionMode).toBe('auto');
  });

  it('skips setPlanMode after picking a session already in plan mode', async () => {
    const session = makeSession({
      id: 'ses-picked',
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'manual',
        planMode: true,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
      setPlanMode: vi.fn(async () => {
        throw new Error('Already in plan mode');
      }),
    });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [
        {
          id: 'ses-picked',
          title: 'Picked session',
          workDir: '/tmp/proj-a',
          updatedAt: Date.now(),
        },
      ]),
    });
    const driver = makeDriver(harness, makeStartupInput({ session: '', plan: true }));

    await (driver as unknown as { initMainTui(): Promise<boolean> }).initMainTui();
    expect(driver.state.startupState).toBe('picker');
    await (driver as unknown as { bootstrapFromPicker(): Promise<void> }).bootstrapFromPicker();

    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\r');
    await new Promise((resolve) => setImmediate(resolve));

    expect(session.setPlanMode).not.toHaveBeenCalled();
    expect(driver.state.appState.planMode).toBe(true);
  });

  it('toggles the sessions picker from current cwd to all sessions with Ctrl+A', async () => {
    const currentWorkDirSession = {
      id: 'ses-cwd',
      title: 'Current cwd session',
      workDir: '/tmp/proj-a',
      updatedAt: Date.now(),
    };
    const otherWorkDirSession = {
      id: 'ses-other-cwd',
      title: 'Other cwd session',
      workDir: '/tmp/proj-b',
      updatedAt: Date.now() - 1000,
    };
    const listSessions = vi.fn(async (input: { workDir?: string } = {}) => {
      if (input.workDir === '/tmp/proj-a') return [currentWorkDirSession];
      return [currentWorkDirSession, otherWorkDirSession];
    });
    const harness = makeHarness(makeSession({ id: 'ses-current' }), { listSessions });
    const driver = makeDriver(harness, makeStartupInput());
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\u0001');
    await new Promise((resolve) => setImmediate(resolve));

    expect(listSessions).toHaveBeenNthCalledWith(1, { workDir: '/tmp/proj-a' });
    expect(listSessions).toHaveBeenNthCalledWith(2, {});
    expect(driver.state.sessionsScope).toBe('all');
    expect(driver.state.sessions.map((session) => session.id)).toEqual([
      'ses-cwd',
      'ses-other-cwd',
    ]);
  });

  it('toggles the sessions picker from all sessions back to current cwd with Ctrl+A', async () => {
    const currentWorkDirSession = {
      id: 'ses-cwd',
      title: 'Current cwd session',
      workDir: '/tmp/proj-a',
      updatedAt: Date.now(),
    };
    const otherWorkDirSession = {
      id: 'ses-other-cwd',
      title: 'Other cwd session',
      workDir: '/tmp/proj-b',
      updatedAt: Date.now() - 1000,
    };
    const listSessions = vi.fn(async (input: { workDir?: string } = {}) => {
      if (input.workDir === '/tmp/proj-a') return [currentWorkDirSession];
      return [currentWorkDirSession, otherWorkDirSession];
    });
    const harness = makeHarness(makeSession({ id: 'ses-current' }), { listSessions });
    const driver = makeDriver(harness, makeStartupInput());
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const firstPicker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    firstPicker.handleInput('\u0001');
    await new Promise((resolve) => setImmediate(resolve));
    const allPicker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    allPicker.handleInput('\u0001');
    await new Promise((resolve) => setImmediate(resolve));

    expect(listSessions).toHaveBeenNthCalledWith(3, { workDir: '/tmp/proj-a' });
    expect(driver.state.sessionsScope).toBe('cwd');
    expect(driver.state.sessions.map((session) => session.id)).toEqual(['ses-cwd']);
  });

  it('does not remount the session picker after it is closed while a scope toggle is pending', async () => {
    const currentWorkDirSession = {
      id: 'ses-cwd',
      title: 'Current cwd session',
      workDir: '/tmp/proj-a',
      updatedAt: Date.now(),
    };
    const otherWorkDirSession = {
      id: 'ses-other-cwd',
      title: 'Other cwd session',
      workDir: '/tmp/proj-b',
      updatedAt: Date.now() - 1000,
    };
    let resolveAllSessions: ((value: unknown[]) => void) | undefined;
    const listSessions = vi.fn((input: { workDir?: string } = {}) => {
      if (input.workDir === '/tmp/proj-a') return Promise.resolve([currentWorkDirSession]);
      return new Promise<unknown[]>((resolve) => {
        resolveAllSessions = resolve;
      });
    });
    const harness = makeHarness(makeSession({ id: 'ses-current' }), { listSessions });
    const driver = makeDriver(harness, makeStartupInput());
    const mountSessionPicker = vi.spyOn(
      driver as unknown as { mountSessionPicker(options: unknown): void },
      'mountSessionPicker',
    );
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    expect(mountSessionPicker).toHaveBeenCalledTimes(1);

    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\u0001');
    (driver as unknown as { hideSessionPicker(): void }).hideSessionPicker();
    resolveAllSessions?.([currentWorkDirSession, otherWorkDirSession]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(driver.state.activeDialog).toBeNull();
    expect(mountSessionPicker).toHaveBeenCalledTimes(1);
  });

  it('clears the sessions picker search query when toggling scope with Ctrl+A', async () => {
    const currentWorkDirSession = {
      id: 'ses-cwd',
      title: 'Current cwd session',
      workDir: '/tmp/proj-a',
      updatedAt: Date.now(),
    };
    const otherWorkDirSession = {
      id: 'ses-other-cwd',
      title: 'Other cwd session',
      workDir: '/tmp/proj-b',
      updatedAt: Date.now() - 1000,
    };
    const listSessions = vi.fn(async (input: { workDir?: string } = {}) => {
      if (input.workDir === '/tmp/proj-a') return [currentWorkDirSession];
      return [currentWorkDirSession, otherWorkDirSession];
    });
    const harness = makeHarness(makeSession({ id: 'ses-current' }), { listSessions });
    const driver = makeDriver(harness, makeStartupInput());
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const firstPicker = driver.state.editorContainer.children[0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    firstPicker.handleInput('c');
    firstPicker.handleInput('w');
    firstPicker.handleInput('d');
    expect(firstPicker.render(160).join('\n')).toContain('Search: cwd');

    firstPicker.handleInput('\u0001');
    await new Promise((resolve) => setImmediate(resolve));

    const allPicker = driver.state.editorContainer.children[0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    const output = allPicker.render(160).join('\n');

    expect(driver.state.sessionsScope).toBe('all');
    expect(output).toContain('All sessions');
    expect(output).toContain('(type to search)');
    expect(output).not.toContain('Search: cwd');
  });

  it('does not resume a session from a different cwd and shows a cd hint', async () => {
    const currentWorkDirSession = {
      id: 'ses-cwd',
      title: 'Current cwd session',
      workDir: '/tmp/proj-a',
      updatedAt: Date.now(),
    };
    const otherWorkDirSession = {
      id: 'ses-other-cwd',
      title: 'Other cwd session',
      workDir: '/tmp/proj-b',
      updatedAt: Date.now() - 1000,
    };
    const resumeSession = vi.fn(async () => makeSession({ id: 'ses-other-cwd' }));
    const harness = makeHarness(makeSession({ id: 'ses-current' }), {
      resumeSession,
      listSessions: vi.fn(async () => [currentWorkDirSession, otherWorkDirSession]),
    });
    const driver = makeDriver(harness, makeStartupInput());
    await expect(driver.init()).resolves.toBe(false);
    copyTextToClipboardMock.mockClear();

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\u001B[B');
    picker.handleInput('\r');
    await new Promise((resolve) => setImmediate(resolve));

    expect(resumeSession).not.toHaveBeenCalled();
    expect(driver.state.activeDialog).toBeNull();
    const expectedResumeCmd = `cd ${quoteShellArg('/tmp/proj-b')} && kimi --resume ${quoteShellArg('ses-other-cwd')}`;
    expect(copyTextToClipboardMock).toHaveBeenCalledWith(expectedResumeCmd);
    const transcript = driver.state.transcriptContainer.render(160).join('\n');
    expect(transcript).toContain('Current session is in a different working directory.');
    expect(transcript).toContain(`To resume, run: ${expectedResumeCmd}`);
    expect(transcript).toContain(`To resume, run: ${expectedResumeCmd}`);
    expect(transcript).toContain('Command copied to clipboard');
  });

  it('copies a shell-safe resume command for another cwd with metacharacters', async () => {
    const currentWorkDirSession = {
      id: 'ses-cwd',
      title: 'Current cwd session',
      workDir: '/tmp/proj-a',
      updatedAt: Date.now(),
    };
    const otherWorkDirSession = {
      id: 'ses-other-cwd',
      title: 'Other cwd session',
      workDir: '/tmp/proj$(touch /tmp/pwned)',
      updatedAt: Date.now() - 1000,
    };
    const resumeSession = vi.fn(async () => makeSession({ id: 'ses-other-cwd' }));
    const harness = makeHarness(makeSession({ id: 'ses-current' }), {
      resumeSession,
      listSessions: vi.fn(async () => [currentWorkDirSession, otherWorkDirSession]),
    });
    const driver = makeDriver(harness, makeStartupInput());
    await expect(driver.init()).resolves.toBe(false);
    copyTextToClipboardMock.mockClear();

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\u001B[B');
    picker.handleInput('\r');
    await new Promise((resolve) => setImmediate(resolve));

    expect(resumeSession).not.toHaveBeenCalled();
    const expectedResumeCmd = `cd ${quoteShellArg('/tmp/proj$(touch /tmp/pwned)')} && kimi --resume ${quoteShellArg('ses-other-cwd')}`;
    expect(copyTextToClipboardMock).toHaveBeenCalledWith(expectedResumeCmd);
    const transcript = driver.state.transcriptContainer.render(160).join('\n');
    expect(transcript).toContain(`To resume, run: ${expectedResumeCmd}`);
  });

  it('exits after picking another cwd from the startup picker', async () => {
    const currentWorkDirSession = {
      id: 'ses-cwd',
      title: 'Current cwd session',
      workDir: '/tmp/proj-a',
      updatedAt: Date.now(),
    };
    const otherWorkDirSession = {
      id: 'ses-other-cwd',
      title: 'Other cwd session',
      workDir: '/tmp/proj-b',
      updatedAt: Date.now() - 1000,
    };
    const resumeSession = vi.fn(async () => makeSession({ id: 'ses-other-cwd' }));
    const harness = makeHarness(makeSession({ id: 'ses-current' }), {
      resumeSession,
      listSessions: vi.fn(async () => [currentWorkDirSession, otherWorkDirSession]),
    });
    const driver = makeDriver(harness, makeStartupInput({ session: '' }));
    const stop = vi.spyOn(driver, 'stop').mockResolvedValue(undefined);
    copyTextToClipboardMock.mockClear();

    await expect((driver as unknown as MigrateExitDriver).initMainTui()).resolves.toBe(false);
    await (driver as unknown as { bootstrapFromPicker(): Promise<void> }).bootstrapFromPicker();

    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\u001B[B');
    picker.handleInput('\r');
    await new Promise((resolve) => setImmediate(resolve));

    expect(resumeSession).not.toHaveBeenCalled();
    const expectedResumeCmd = `cd ${quoteShellArg('/tmp/proj-b')} && kimi --resume ${quoteShellArg('ses-other-cwd')}`;
    expect(copyTextToClipboardMock).toHaveBeenCalledWith(expectedResumeCmd);
    expect(stop).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith(0);
  });

  it('does not apply startup flags when switching sessions via the /sessions picker', async () => {
    const initial = makeSession({ id: 'ses-1' });
    const picked = makeSession({
      id: 'ses-2',
      setPermission: vi.fn(async () => {}),
      setPlanMode: vi.fn(async () => {
        throw new Error('Already in plan mode');
      }),
    });
    const harness = makeHarness(initial, {
      resumeSession: vi.fn(async () => picked),
      listSessions: vi.fn(async () => [
        {
          id: 'ses-2',
          title: 'Other session',
          workDir: '/tmp/proj-a',
          updatedAt: Date.now(),
        },
      ]),
    });
    const driver = makeDriver(harness, makeStartupInput({ auto: true, plan: true }));
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\r');
    await new Promise((resolve) => setImmediate(resolve));

    expect(driver.state.appState.sessionId).toBe('ses-2');
    expect(picked.setPermission).not.toHaveBeenCalled();
    expect(picked.setPlanMode).not.toHaveBeenCalled();
    expect(driver.state.appState.permissionMode).toBe('manual');
    expect(driver.state.appState.planMode).toBe(false);
  });

  it('clears startup picker exit confirmation before resuming a selected session', async () => {
    const session = makeSession({ id: 'ses-picked' });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [
        {
          id: 'ses-picked',
          title: 'Picked session',
          workDir: '/tmp/proj-a',
          updatedAt: Date.now(),
        },
      ]),
    });
    const driver = makeDriver(harness, makeStartupInput({ session: '' }));
    const stop = vi.spyOn(driver, 'stop').mockResolvedValue(undefined);

    await expect((driver as unknown as MigrateExitDriver).initMainTui()).resolves.toBe(false);
    await (driver as unknown as { bootstrapFromPicker(): Promise<void> }).bootstrapFromPicker();

    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\u0003');
    picker.handleInput('\r');
    await new Promise((resolve) => setImmediate(resolve));

    driver.state.editor.onCtrlC?.();

    expect(stop).not.toHaveBeenCalled();
  });

  it('tracks terminal theme reports while auto theme is active', () => {
    const harness = makeHarness();
    const driver = makeDriver(
      harness,
      makeStartupInput({}, { theme: 'auto' }),
    ) as unknown as ThemeTrackingDriver;
    const { listeners, write, addInputListener } = captureInputListeners(driver);

    driver.refreshTerminalThemeTracking();

    expect(addInputListener).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(ENABLE_TERMINAL_THEME_REPORTING);
    expect(write).toHaveBeenCalledWith(OSC11_QUERY);
    expect(write).toHaveBeenCalledWith(QUERY_TERMINAL_THEME);
    expect(listeners).toHaveLength(1);

    write.mockClear();
    expect(listeners[0]?.(TERMINAL_THEME_LIGHT)).toEqual({ consume: true });
    expect(write).toHaveBeenCalledWith(OSC11_QUERY);
    expect(driver.state.appState.theme).toBe('auto');
    expect(driver.state.ui.requestRender).not.toHaveBeenCalled();

    expect(listeners[0]?.(DARK_OSC11_REPORT)).toEqual({ consume: true });
    expect(driver.state.appState.theme).toBe('auto');
    expect(driver.state.ui.requestRender).not.toHaveBeenCalled();

    expect(listeners[0]?.(LIGHT_OSC11_REPORT)).toEqual({ consume: true });
    expect(driver.state.appState.theme).toBe('auto');
    expect(driver.state.ui.requestRender).toHaveBeenCalled();
  });

  it('does not track terminal theme reports for explicit themes', () => {
    const harness = makeHarness();
    const driver = makeDriver(harness, makeStartupInput()) as unknown as ThemeTrackingDriver;
    const { write, addInputListener } = captureInputListeners(driver);

    driver.refreshTerminalThemeTracking();

    expect(addInputListener).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('disables terminal theme reports after leaving auto theme', () => {
    const harness = makeHarness();
    const driver = makeDriver(
      harness,
      makeStartupInput({}, { theme: 'auto' }),
    ) as unknown as ThemeTrackingDriver;
    const { write, removeInputListener } = captureInputListeners(driver);

    driver.refreshTerminalThemeTracking();
    driver.state.appState.theme = 'dark';
    driver.refreshTerminalThemeTracking();

    expect(removeInputListener).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(DISABLE_TERMINAL_THEME_REPORTING);
  });

  it("only shows provider refresh status for added models", async () => {
    const harness = makeHarness();
    const driver = makeDriver(harness, makeStartupInput());
    const showStatus = vi.spyOn(driver as any, "showStatus").mockImplementation(() => {});
    vi.spyOn((driver as any).authFlow, "refreshProviderModels").mockResolvedValue({
      changed: [
        { providerId: "new-models", providerName: "New Models", added: 2, removed: 0 },
        { providerId: "removed-models", providerName: "Removed Models", added: 0, removed: 3 },
        { providerId: "metadata-only", providerName: "Metadata Only", added: 0, removed: 0 },
      ],
      unchanged: [],
      failed: [],
    });

    await (driver as any).refreshProviderModelsInBackground();

    expect(showStatus).toHaveBeenCalledTimes(1);
    expect(showStatus).toHaveBeenCalledWith("New Models · +2 models.");
  });

  it("starts TUI without a session when fresh startup needs OAuth login", async () => {
    const harness = makeHarness(makeSession(), {
      createSession: vi.fn(async () => {
        throw loginRequiredError();
      }),
    });
    const driver = makeDriver(harness, makeStartupInput());

    await expect(driver.init()).resolves.toBe(false);

    expect(driver.state.startupState).toBe('ready');
    expect((driver as any).startupNotice).toContain('OAuth login expired');
    expect(driver.state.appState).toMatchObject({
      sessionId: '',
      model: '',
      thinkingEffort: 'off',
      contextTokens: 0,
      maxContextTokens: 0,
      contextUsage: 0,
      sessionTitle: null,
    });
  });

  it('preserves fresh startup yolo and plan intent after OAuth login', async () => {
    const session = makeSession({
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'yolo',
        planMode: true,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
    });
    const createSession = vi
      .fn()
      .mockRejectedValueOnce(loginRequiredError())
      .mockResolvedValueOnce(session);
    const harness = makeHarness(session, {
      getConfig: vi.fn(async () => ({
        defaultModel: 'k2',
        thinking: { enabled: false },
        models: {
          k2: { model: 'moonshot-v1', maxContextSize: 100 },
        },
      })),
      createSession,
    });
    const driver = makeDriver(harness, makeStartupInput({ yolo: true, plan: true }));

    await expect(driver.init()).resolves.toBe(false);

    expect(driver.state.appState).toMatchObject({
      sessionId: '',
      model: '',
      permissionMode: 'yolo',
      planMode: true,
    });

    vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
    await handleLoginCommand(driver as any);

    expect(createSession).toHaveBeenNthCalledWith(1, {
      workDir: '/tmp/proj-a',
      permission: 'yolo',
      planMode: true,
    });
    expect(createSession).toHaveBeenNthCalledWith(2, {
      workDir: '/tmp/proj-a',
      model: 'k2',
      thinking: 'off',
      permission: 'yolo',
      planMode: true,
    });
    expect(driver.state.appState).toMatchObject({
      sessionId: 'ses-1',
      model: 'k2',
      permissionMode: 'yolo',
      planMode: true,
    });
  });

  it('carries the agent binding into the post-login startup session', async () => {
    const session = makeSession();
    const createSession = vi
      .fn()
      .mockRejectedValueOnce(loginRequiredError())
      .mockResolvedValueOnce(session);
    const harness = makeHarness(session, {
      getConfig: vi.fn(async () => ({
        defaultModel: 'k2',
        thinking: { enabled: false },
        models: {
          k2: { model: 'moonshot-v1', maxContextSize: 100 },
        },
      })),
      createSession,
    });
    const driver = makeDriver(harness, {
      ...makeStartupInput({ agent: 'reviewer', agentFiles: ['reviewer.md'] }),
      agentProfile: 'reviewer',
    });

    await expect(driver.init()).resolves.toBe(false);

    vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
    await handleLoginCommand(driver as any);

    expect(createSession).toHaveBeenNthCalledWith(2, {
      workDir: '/tmp/proj-a',
      model: 'k2',
      thinking: 'off',
      permission: undefined,
      planMode: undefined,
      agentProfile: 'reviewer',
      agentFiles: ['reviewer.md'],
    });
  });

  it('does not force manual permission after OAuth login without --yolo', async () => {
    const session = makeSession({
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'auto',
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
    });
    const createSession = vi
      .fn()
      .mockRejectedValueOnce(loginRequiredError())
      .mockResolvedValueOnce(session);
    const harness = makeHarness(session, {
      getConfig: vi.fn(async () => ({
        defaultModel: 'k2',
        thinking: { enabled: false },
        models: {
          k2: { model: 'moonshot-v1', maxContextSize: 100 },
        },
      })),
      createSession,
    });
    const driver = makeDriver(harness, makeStartupInput());

    await expect(driver.init()).resolves.toBe(false);
    vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
    await handleLoginCommand(driver as any);

    expect(createSession).toHaveBeenNthCalledWith(2, {
      workDir: '/tmp/proj-a',
      model: 'k2',
      thinking: 'off',
      permission: undefined,
      planMode: undefined,
    });
    expect(driver.state.appState).toMatchObject({
      permissionMode: 'auto',
    });
  });

  it('does not override active session thinking when configured thinking is enabled after OAuth login', async () => {
    const session = makeSession();
    const harness = makeHarness(session, {
      getConfig: vi.fn(async () => ({
        defaultModel: 'k2',
        thinking: { enabled: true },
        models: {
          k2: { model: 'moonshot-v1', maxContextSize: 100 },
        },
      })),
    });
    const driver = makeDriver(harness, makeStartupInput());

    await expect(driver.init()).resolves.toBe(false);
    expect(driver.state.appState.thinkingEffort).toBe('off');

    vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
    await handleLoginCommand(driver as any);

    expect(session.setModel).toHaveBeenCalledWith('k2');
    // `thinking.enabled === true` means "leave the session's current thinking
    // level alone" — only an explicit `enabled === false` forces `'off'`.
    expect(session.setThinking).not.toHaveBeenCalled();
    expect(driver.state.appState).toMatchObject({
      model: 'k2',
      thinkingEffort: 'off',
      maxContextTokens: 100,
    });
    expect(harness.track).toHaveBeenCalledWith('login', {
      provider: 'managed:kimi-code',
      method: 'oauth',
      already_logged_in: false,
    });
  });

  it('tracks login with already_logged_in when a token already exists', async () => {
    const session = makeSession();
    const harness = makeHarness(session, {
      auth: {
        status: vi.fn(async () => ({
          providers: [{ providerName: 'managed:kimi-code', hasToken: true }],
        })),
        login: vi.fn(async () => {}),
        logout: vi.fn(),
        getManagedUsage: vi.fn(),
      },
    });
    const driver = makeDriver(harness, makeStartupInput());

    await expect(driver.init()).resolves.toBe(false);
    harness.track.mockClear();

    vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
    await handleLoginCommand(driver as any);

    expect(harness.auth.login).toHaveBeenCalledWith(
      'managed:kimi-code',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        onDeviceCode: expect.any(Function),
      }),
    );
    expect(harness.track).toHaveBeenCalledWith('login', {
      provider: 'managed:kimi-code',
      method: 'oauth',
      already_logged_in: true,
    });
  });

  it('logs login failures with session context', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const session = makeSession();
    const loginError = new Error('Failed to list Kimi Code models (HTTP 402).');
    const harness = makeHarness(session, {
      auth: {
        status: vi.fn(async () => ({ providers: [] })),
        login: vi.fn(async () => {
          throw loginError;
        }),
        logout: vi.fn(),
        getManagedUsage: vi.fn(),
      },
    });
    const driver = makeDriver(harness, makeStartupInput());

    try {
      await expect(driver.init()).resolves.toBe(false);

      vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
      await handleLoginCommand(driver as any);

      expect(harness.auth.login).toHaveBeenCalledWith(
        'managed:kimi-code',
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          onDeviceCode: expect.any(Function),
        }),
      );
      expect(warn).toHaveBeenCalledWith(
        'login failed',
        expect.objectContaining({
          providerName: 'managed:kimi-code',
          alreadyLoggedIn: false,
          sessionId: 'ses-1',
          error: expect.objectContaining({
            message: 'Failed to list Kimi Code models (HTTP 402).',
          }),
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('tracks logout after managed credentials and session state are cleared', async () => {
    const session = makeSession();
    const harness = makeHarness(session, {
      getConfig: vi.fn(async () => ({
        models: {
          k2: { provider: 'managed:kimi-code', model: 'moonshot-v1', maxContextSize: 100 },
        },
        providers: { 'managed:kimi-code': { type: 'kimi' } },
      })),
      auth: {
        status: vi.fn(async () => ({
          providers: [{ providerName: 'managed:kimi-code', hasToken: true }],
        })),
        login: vi.fn(async () => {}),
        logout: vi.fn(),
        getManagedUsage: vi.fn(),
      },
    });
    const driver = makeDriver(harness, makeStartupInput());

    await expect(driver.init()).resolves.toBe(false);
    harness.track.mockClear();

    vi.mocked(promptLogoutProviderSelection).mockResolvedValue('managed:kimi-code');
    await handleLogoutCommand(driver as any);

    expect(harness.auth.logout).toHaveBeenCalledWith('managed:kimi-code');
    expect(session.close).toHaveBeenCalledOnce();
    expect(driver.state.appState).toMatchObject({
      sessionId: '',
      model: '',
      sessionTitle: null,
    });
    expect(harness.track).toHaveBeenCalledWith('logout', { provider: 'managed:kimi-code' });
  });

  it('keeps the active session when logging out a different provider', async () => {
    const session = makeSession();
    const removeProvider = vi.fn(async () => {});
    const harness = makeHarness(session, {
      getConfig: vi.fn(async () => ({
        models: {
          k2: { provider: 'managed:kimi-code', model: 'moonshot-v1', maxContextSize: 100 },
        },
        providers: {
          'managed:kimi-code': { type: 'kimi' },
          openai: { type: 'openai', baseUrl: 'https://api.openai.com/v1' },
        },
      })),
      removeProvider,
      auth: {
        status: vi.fn(async () => ({
          providers: [{ providerName: 'managed:kimi-code', hasToken: true }],
        })),
        login: vi.fn(async () => {}),
        logout: vi.fn(),
        getManagedUsage: vi.fn(),
      },
    });
    const driver = makeDriver(harness, makeStartupInput());

    await expect(driver.init()).resolves.toBe(false);
    harness.track.mockClear();

    vi.mocked(promptLogoutProviderSelection).mockResolvedValue('openai');
    await handleLogoutCommand(driver as any);

    expect(removeProvider).toHaveBeenCalledWith('openai');
    expect(harness.auth.logout).not.toHaveBeenCalled();
    expect(session.close).not.toHaveBeenCalled();
    expect(driver.state.appState).toMatchObject({
      sessionId: 'ses-1',
      model: 'k2',
    });
    expect(harness.track).toHaveBeenCalledWith('logout', { provider: 'openai' });
  });

  it('can log out a stale managed entry even after the OAuth token is gone', async () => {
    const session = makeSession();
    const harness = makeHarness(session, {
      getConfig: vi.fn(async () => ({
        models: {
          k2: { provider: 'managed:kimi-code', model: 'moonshot-v1', maxContextSize: 100 },
        },
        providers: { 'managed:kimi-code': { type: 'kimi' } },
      })),
      auth: {
        // Token gone (e.g. credentials file deleted) but the managed entry
        // is still sitting in config.providers.
        status: vi.fn(async () => ({
          providers: [{ providerName: 'managed:kimi-code', hasToken: false }],
        })),
        login: vi.fn(async () => {}),
        logout: vi.fn(),
        getManagedUsage: vi.fn(),
      },
    });
    const driver = makeDriver(harness, makeStartupInput());

    await expect(driver.init()).resolves.toBe(false);

    vi.mocked(promptLogoutProviderSelection).mockResolvedValue('managed:kimi-code');
    await handleLogoutCommand(driver as any);

    expect(harness.auth.logout).toHaveBeenCalledWith('managed:kimi-code');
  });

  it('starts TUI without replaying when --continue needs OAuth login', async () => {
    const harness = makeHarness(makeSession(), {
      listSessions: vi.fn(async () => [{ id: 'ses-latest' }]),
      resumeSession: vi.fn(async () => {
        throw loginRequiredError();
      }),
    });
    const driver = makeDriver(harness, makeStartupInput({ continue: true }));

    await expect(driver.init()).resolves.toBe(false);

    expect(harness.resumeSession).toHaveBeenCalledWith({
      id: 'ses-latest',
      replayTurnLimit: REPLAY_TURN_LIMIT,
    });
    expect(harness.createSession).not.toHaveBeenCalled();
    expect(driver.state.startupState).toBe('ready');
    expect(driver.state.appState.sessionId).toBe('');
  });

  it('starts TUI without replaying when an explicit resume needs OAuth login', async () => {
    const harness = makeHarness(makeSession(), {
      listSessions: vi.fn(async () => [{ id: 'ses-target', workDir: '/tmp/proj-a' }]),
      resumeSession: vi.fn(async () => {
        throw loginRequiredError();
      }),
    });
    const driver = makeDriver(harness, makeStartupInput({ session: 'ses-target' }));

    await expect(driver.init()).resolves.toBe(false);

    expect(harness.resumeSession).toHaveBeenCalledWith({
      id: 'ses-target',
      replayTurnLimit: REPLAY_TURN_LIMIT,
    });
    expect(driver.state.startupState).toBe('ready');
    expect(driver.state.appState.sessionId).toBe('');
  });

  it('disposes terminal focus/theme tracking on the kimi migrate exit', async () => {
    const harness = makeHarness();
    const driver = makeDriver(harness, {
      ...makeStartupInput(),
      migrationPlan: MIGRATION_PLAN,
      migrateOnly: true,
    }) as unknown as MigrateExitDriver;
    // pi-tui start/stop and focus tracking touch the real TTY — stub the I/O.
    vi.spyOn(driver.state.ui, 'start').mockImplementation(() => {});
    vi.spyOn(driver.state.ui, 'stop').mockImplementation(() => {});
    vi.spyOn(driver.state.terminal, 'write').mockImplementation(() => {});
    // The migration screen would await user input; resolve it immediately.
    vi.spyOn(driver, 'runMigrationScreen').mockResolvedValue({ decision: 'later' });
    const onExit = vi.fn(async () => {});
    driver.onExit = onExit;

    await driver.start();

    // `kimi migrate` exits via process.exit; startEventLoop() installed focus
    // tracking, so the exit path must dispose it — otherwise the terminal
    // keeps emitting focus/OSC sequences after the command finishes.
    expect(driver.terminalFocusTrackingDispose).toBeUndefined();
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('disposes terminal tracking when post-migration startup fails', async () => {
    const harness = makeHarness();
    const driver = makeDriver(harness, {
      ...makeStartupInput(),
      migrationPlan: MIGRATION_PLAN,
      migrateOnly: false,
    }) as unknown as MigrateExitDriver;
    vi.spyOn(driver.state.ui, 'start').mockImplementation(() => {});
    vi.spyOn(driver.state.ui, 'stop').mockImplementation(() => {});
    vi.spyOn(driver.state.terminal, 'write').mockImplementation(() => {});
    // The migration screen resolves "later"; startup then continues into
    // initMainTui(), which fails (e.g. a session-resume error).
    vi.spyOn(driver, 'runMigrationScreen').mockResolvedValue({ decision: 'later' });
    vi.spyOn(driver, 'initMainTui').mockRejectedValue(new Error('resume boom'));

    await expect(driver.start()).rejects.toThrow('resume boom');

    // The focus tracking installed by startEventLoop() must be torn down
    // before the error propagates — not left active after the process exits.
    expect(driver.terminalFocusTrackingDispose).toBeUndefined();
  });

  it('keeps non-login startup session errors fatal', async () => {
    const harness = makeHarness(makeSession(), {
      createSession: vi.fn(async () => {
        throw new Error('provider config is invalid');
      }),
    });
    const driver = makeDriver(harness, makeStartupInput());

    await expect(driver.init()).rejects.toThrow('provider config is invalid');
  });

  it('does not mount the footer when resuming a missing session fails', async () => {
    // Regression: a stray pre-startEventLoop render used to paint the footer
    // (cwd/git + "context:" statusline) to the terminal before the fatal
    // error, leaving it stranded above the error message. The footer must not
    // be in the layout tree when initMainTui() throws.
    const harness = makeHarness(makeSession(), {
      listSessions: vi.fn(async () => []),
    });
    const driver = makeDriver(
      harness,
      makeStartupInput({ session: 'missing-session' }),
    ) as unknown as MigrateExitDriver;

    await expect(driver.initMainTui()).rejects.toThrow('Session "missing-session" not found.');
    expect(uiContainsFooter(driver)).toBe(false);
  });

  it('mounts the footer once startup reaches the main TUI', async () => {
    const session = makeSession({ id: 'ses-target' });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-target', workDir: '/tmp/proj-a' }]),
    });
    const driver = makeDriver(
      harness,
      makeStartupInput({ session: 'ses-target' }),
    ) as unknown as MigrateExitDriver;

    // Not mounted until init() succeeds.
    expect(uiContainsFooter(driver)).toBe(false);

    await driver.initMainTui();

    expect(uiContainsFooter(driver)).toBe(true);
  });

  it('renders the banner below the welcome message after it loads', async () => {
    const banner = {
      key: 'new-banner',
      tag: 'New',
      mainText: 'Banner main',
      subText: null,
      display: 'always' as const,
    };
    const loadSpy = vi.spyOn(BannerProvider.prototype, 'load').mockResolvedValue(banner);
    const session = makeSession({ id: 'ses-target' });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-target', workDir: '/tmp/proj-a' }]),
    });
    const driver = makeDriver(
      harness,
      makeStartupInput({ session: 'ses-target' }),
    ) as unknown as MigrateExitDriver;

    await driver.initMainTui();

    await vi.waitFor(() => {
      expect(
        driver.state.transcriptContainer.children.some((child) => child instanceof BannerComponent),
      ).toBe(true);
    });

    // The banner is rendered directly below the welcome panel so it appears
    // above later status messages such as MCP server connection summaries.
    const welcomeIndex = driver.state.transcriptContainer.children.findIndex(
      (child) => child instanceof WelcomeComponent,
    );
    const bannerIndex = driver.state.transcriptContainer.children.findIndex(
      (child) => child instanceof BannerComponent,
    );
    expect(welcomeIndex).toBeGreaterThanOrEqual(0);
    expect(bannerIndex).toBe(welcomeIndex + 1);

    loadSpy.mockRestore();
  });

  it('writes display state after rendering a once banner', async () => {
    const originalEnv = { ...process.env };
    const dir = mkdtempSync(join(tmpdir(), 'kimi-startup-banner-'));
    process.env['KIMI_CODE_HOME'] = dir;

    try {
      const banner = {
        key: 'once-banner',
        tag: null,
        mainText: 'Banner main',
        subText: null,
        display: 'once' as const,
      };
      const loadSpy = vi.spyOn(BannerProvider.prototype, 'load').mockResolvedValue(banner);
      const session = makeSession({ id: 'ses-target' });
      const harness = makeHarness(session, {
        listSessions: vi.fn(async () => [{ id: 'ses-target', workDir: '/tmp/proj-a' }]),
      });
      const driver = makeDriver(
        harness,
        makeStartupInput({ session: 'ses-target' }),
      ) as unknown as MigrateExitDriver;

      await driver.initMainTui();

      await vi.waitFor(() => {
        expect(
          driver.state.transcriptContainer.children.some((child) => child instanceof BannerComponent),
        ).toBe(true);
      });

      // writeBannerDisplayState runs after renderBanner; on Windows the atomic
      // write can lag behind the render, so wait for the state to land before
      // asserting it.
      await vi.waitFor(
        async () => {
          const state = await readBannerDisplayState();
          expect(state.shown['once-banner']?.lastShownAt).toBeDefined();
        },
        { timeout: 5000 },
      );
      await expect(readBannerDisplayState()).resolves.toMatchObject({
        version: 1,
        shown: {
          'once-banner': {
            lastShownAt: expect.any(String),
          },
        },
      });

      loadSpy.mockRestore();
    } finally {
      process.env = { ...originalEnv };
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not write display state for an always banner', async () => {
    const originalEnv = { ...process.env };
    const dir = mkdtempSync(join(tmpdir(), 'kimi-startup-banner-'));
    process.env['KIMI_CODE_HOME'] = dir;

    try {
      const banner = {
        key: 'always-banner',
        tag: null,
        mainText: 'Banner main',
        subText: null,
        display: 'always' as const,
      };
      const loadSpy = vi.spyOn(BannerProvider.prototype, 'load').mockResolvedValue(banner);
      const session = makeSession({ id: 'ses-target' });
      const harness = makeHarness(session, {
        listSessions: vi.fn(async () => [{ id: 'ses-target', workDir: '/tmp/proj-a' }]),
      });
      const driver = makeDriver(
        harness,
        makeStartupInput({ session: 'ses-target' }),
      ) as unknown as MigrateExitDriver;

      await driver.initMainTui();

      await vi.waitFor(() => {
        expect(
          driver.state.transcriptContainer.children.some((child) => child instanceof BannerComponent),
        ).toBe(true);
      });

      await expect(readBannerDisplayState()).resolves.toEqual({
        version: 1,
        shown: {},
      });

      loadSpy.mockRestore();
    } finally {
      process.env = { ...originalEnv };
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resumes a startup session when Windows workdir uses backslashes', async () => {
    const session = makeSession({ id: 'ses-target' });
    const harness = makeHarness(session, {
      listSessions: vi.fn(async () => [{ id: 'ses-target', workDir: 'C:/Users/kimi/project' }]),
    });
    const driver = makeDriver(harness, {
      ...makeStartupInput({ session: 'ses-target' }),
      workDir: String.raw`C:\Users\kimi\project`,
    });

    await expect(driver.init()).resolves.toBe(true);

    expect(harness.listSessions).toHaveBeenCalledWith({
      sessionId: 'ses-target',
      workDir: String.raw`C:\Users\kimi\project`,
    });
    expect(harness.resumeSession).toHaveBeenCalledWith({
      id: 'ses-target',
      replayTurnLimit: REPLAY_TURN_LIMIT,
    });
    expect(driver.state.appState.sessionId).toBe('ses-target');
  });
});

// ── Agents-view attach (Enter on a row → full chat UI) ──

describe('KimiTUI agents-view attach', () => {
  interface AttachDriver extends StartupDriver {
    onOpenSession(id: string): void;
    returnToAgentsView(): boolean;
    agentsViewController: { show(): Promise<void> };
    resumeSession(id: string): Promise<boolean>;
    session: { id: string } | undefined;
    showStatus(msg: string, severity?: string): void;
    showError(msg: string): void;
  }

  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeAttachSession(id: string) {
    return makeSession({
      id,
      listMcpServers: vi.fn(async () => []),
      getSessionWarnings: vi.fn(async () => []),
    });
  }

  const ATTACH_SUMMARY = {
    id: 'ses-attached',
    title: 'attached title',
    workDir: '/tmp/proj-a',
    sessionDir: '/tmp/ses-attached',
    createdAt: 1,
    updatedAt: 1_000,
  };

  function makeAgentsHarness(
    session: ReturnType<typeof makeAttachSession>,
    opts: { withWireReply?: boolean } = {},
  ) {
    const listeners = new Set<(event: Event) => void>();
    const homeDir = mkdtempSync(join(tmpdir(), 'kimi-agents-attach-'));
    dirs.push(homeDir);
    // Pre-register the attach target (and a second view-owned session used by
    // the badge test): the view's roster only lists sessions in its own
    // registry (dispatched from / attached through the view).
    writeFileSync(
      join(homeDir, 'agents-view.json'),
      JSON.stringify({ pins: [], sessions: [ATTACH_SUMMARY.id, 'ses-other'] }),
    );
    // Reply-from-roster (R9 Q1a) needs a real wire rpc — the plain
    // listSessions()-seeded roster every other attach test uses has no
    // prompt() route (handleReply requires the wire transport).
    const wirePrompt = opts.withWireReply === true ? vi.fn(async () => {}) : undefined;
    const wireRpc =
      wirePrompt === undefined
        ? undefined
        : Object.assign(Object.create(SDKRpcClientWire.prototype) as SDKRpcClientWire, {
            prompt: wirePrompt,
            listSessionRows: vi.fn(async () => [
              {
                id: ATTACH_SUMMARY.id,
                workspace_id: 'ws_1',
                title: ATTACH_SUMMARY.title,
                created_at: new Date(ATTACH_SUMMARY.createdAt).toISOString(),
                updated_at: new Date(ATTACH_SUMMARY.updatedAt).toISOString(),
                busy: false,
                pending_interaction: 'none',
                metadata: { cwd: ATTACH_SUMMARY.workDir },
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
              },
            ]),
            getWorkspaceTrustForSession: vi.fn(async () => true),
            onConnectionState: () => () => {},
          });
    const harness = makeHarness(session, {
      homeDir,
      listSessions: vi.fn(async () => [ATTACH_SUMMARY]),
      onEvent: (listener: (event: Event) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      ...(wireRpc === undefined ? {} : { wireRpc: vi.fn(() => wireRpc) }),
    });
    return {
      harness,
      wirePrompt,
      emit: (event: Event) => {
        for (const listener of listeners) listener(event);
      },
    };
  }

  async function bootAgentsView(
    harness: ReturnType<typeof makeAgentsHarness>['harness'],
  ): Promise<AttachDriver> {
    const driver = makeDriver(harness, {
      ...makeStartupInput(),
      startupAgentsView: true,
    }) as unknown as AttachDriver;
    await driver.init();
    expect(driver.state.startupState).toBe('agents-view');
    await driver.agentsViewController.show();
    expect(driver.state.agentsView).toBeDefined();
    return driver;
  }

  it('attach resumes the session, detaches the view and switches into its chat UI', async () => {
    const session = makeAttachSession('ses-attached');
    const { harness, emit } = makeAgentsHarness(session);
    const driver = await bootAgentsView(harness);
    const showStatus = vi.spyOn(driver, 'showStatus').mockImplementation(() => {});

    driver.onOpenSession('ses-attached');

    await vi.waitFor(() => {
      expect(driver.state.appState.sessionId).toBe('ses-attached');
    });
    expect(harness.resumeSession).toHaveBeenCalledWith({
      id: 'ses-attached',
      replayTurnLimit: REPLAY_TURN_LIMIT,
    });
    expect(driver.session?.id).toBe('ses-attached');
    expect(showStatus).toHaveBeenCalledWith('Attached to session (ses-attached).');
    // The view unmounted (detached) but its roster subscription survived
    // switchToSession's runtime reset — the footer badge needs live counts.
    const view = driver.state.agentsView;
    expect(view?.detached).toBe(true);
    emit({
      type: 'event.session.work_changed',
      sessionId: 'ses-attached',
      busy: true,
      pending_interaction: 'none',
    } as Event);
    expect(view?.roster.counts().working).toBe(1);
  });

  it('a failed attach leaves the view mounted and shows the error', async () => {
    const session = makeAttachSession('ses-attached');
    const { harness } = makeAgentsHarness(session);
    const driver = await bootAgentsView(harness);
    const showError = vi.spyOn(driver, 'showError').mockImplementation(() => {});
    harness.resumeSession.mockRejectedValueOnce(new Error('server exploded'));

    driver.onOpenSession('ses-attached');

    await vi.waitFor(() => {
      expect(showError).toHaveBeenCalled();
    });
    expect(showError).toHaveBeenCalledWith(expect.stringContaining('server exploded'));
    expect(driver.state.agentsView?.detached).toBe(false);
    expect(driver.session).toBeUndefined();
    expect(driver.state.appState.sessionId).toBe('');
  });

  it('a failed switchToSession after a successful resume remounts the agents view', async () => {
    // I2: syncRuntimeState's getStatus()/getGoal() are live HTTP calls that
    // can reject (server restart, network blip) after resumeSession already
    // succeeded and the view detached for the attach — the view must
    // remount instead of leaving a half-attached state (appState.model
    // stuck at '', "LLM not set" gate on the next Enter) behind.
    const session = makeAttachSession('ses-attached');
    session.getStatus.mockRejectedValueOnce(new Error('status fetch failed'));
    const { harness } = makeAgentsHarness(session);
    const driver = await bootAgentsView(harness);
    const showError = vi.spyOn(driver, 'showError').mockImplementation(() => {});

    driver.onOpenSession('ses-attached');

    await vi.waitFor(() => {
      expect(showError).toHaveBeenCalledWith(expect.stringContaining('status fetch failed'));
    });
    expect(driver.state.agentsView?.detached).toBe(false);
  });

  it('re-entering the current session resurfaces its chat without resuming again', async () => {
    // Regression (final review C1): attach → ← → Enter on the SAME row must
    // re-enter the still-live chat — the T3-era "Already on this session."
    // guard made the core loop work exactly once and stranded approvals that
    // arrived for the attached session while the roster was up.
    const session = makeAttachSession('ses-attached');
    const { harness } = makeAgentsHarness(session);
    const driver = await bootAgentsView(harness);
    const showStatus = vi.spyOn(driver, 'showStatus').mockImplementation(() => {});
    driver.onOpenSession('ses-attached');
    await vi.waitFor(() => {
      expect(driver.state.appState.sessionId).toBe('ses-attached');
    });

    // ← back to the roster, then Enter on the same session's row.
    expect(driver.returnToAgentsView()).toBe(true);
    await vi.waitFor(() => {
      expect(driver.state.agentsView?.detached).toBe(false);
    });
    driver.onOpenSession('ses-attached');

    // The view unmounts again (the chat resurfaces) with no second resume and
    // no same-session guard error.
    await vi.waitFor(() => {
      expect(driver.state.agentsView?.detached).toBe(true);
    });
    expect(harness.resumeSession).toHaveBeenCalledTimes(1);
    expect(showStatus).not.toHaveBeenCalledWith('Already on this session.');
    expect(driver.state.appState.sessionId).toBe('ses-attached');
    expect(driver.state.ui.children).not.toContain(driver.state.agentsView?.component);
  });

  // ── Approval-while-view-open focus seam (final re-review C1 compound) ──

  function makeApprovalRequest(toolCallId: string): ApprovalRequest {
    return {
      toolCallId,
      toolName: 'Bash',
      action: 'run',
      display: {
        kind: 'generic',
        summary: 'run',
        detail: { command: 'ls /tmp' },
      },
    };
  }

  /** The approval handler the TUI registered on the attached session mock. */
  function approvalHandlerOf(session: ReturnType<typeof makeAttachSession>): ApprovalHandler {
    const handler = vi.mocked(session.setApprovalHandler).mock.calls.at(-1)?.[0] as
      | ApprovalHandler
      | undefined;
    if (handler === undefined) throw new Error('no approval handler registered');
    return handler;
  }

  function approvalControllerOf(driver: AttachDriver): ApprovalController {
    return (driver as unknown as { approvalController: ApprovalController }).approvalController;
  }

  /** Attach ses-attached, then ← back to the roster with the chat live underneath. */
  async function bootRosterOverAttachedSession(
    session: ReturnType<typeof makeAttachSession>,
  ): Promise<AttachDriver> {
    const { harness } = makeAgentsHarness(session);
    const driver = await bootAgentsView(harness);
    // initMainTui mounts the editor into its container; init() alone does not.
    driver.state.editorContainer.addChild(driver.state.editor);
    driver.onOpenSession('ses-attached');
    await vi.waitFor(() => {
      expect(driver.state.appState.sessionId).toBe('ses-attached');
    });
    expect(driver.returnToAgentsView()).toBe(true);
    await vi.waitFor(() => {
      expect(driver.state.agentsView?.detached).toBe(false);
    });
    return driver;
  }

  it('an approval arriving while the view is open neither mounts nor steals focus', async () => {
    const session = makeAttachSession('ses-attached');
    const driver = await bootRosterOverAttachedSession(session);
    const setFocus = vi.spyOn(driver.state.ui, 'setFocus');

    const pending = approvalHandlerOf(session)(makeApprovalRequest('tc-1'));

    // The request stays pending in the controller; nothing mounts into the
    // (off-tree) editor container, and the roster keeps keyboard focus.
    const view = driver.state.agentsView;
    expect(driver.state.editorContainer.children[0]).toBe(driver.state.editor);
    expect(view?.component.focused).toBe(true);
    expect(
      setFocus.mock.calls.some(([target]) => target instanceof ApprovalPanelComponent),
    ).toBe(false);

    // Teardown with a queued panel: cancel resolves the request and still
    // does not touch the roster's focus or the editor container.
    approvalControllerOf(driver).cancelAll('test teardown');
    await expect(pending).resolves.toMatchObject({ decision: 'cancelled' });
    expect(driver.state.editorContainer.children[0]).toBe(driver.state.editor);
    expect(view?.component.focused).toBe(true);
  });

  it('attaching into the session mounts the queued approval visible and focused', async () => {
    const session = makeAttachSession('ses-attached');
    const driver = await bootRosterOverAttachedSession(session);
    const pending = approvalHandlerOf(session)(makeApprovalRequest('tc-1'));
    expect(driver.state.editorContainer.children[0]).toBe(driver.state.editor);

    driver.onOpenSession('ses-attached');

    await vi.waitFor(() => {
      expect(driver.state.agentsView?.detached).toBe(true);
    });
    const mounted = driver.state.editorContainer.children[0];
    expect(mounted).toBeInstanceOf(ApprovalPanelComponent);
    expect(driver.state.ui.children).toContain(driver.state.editorContainer);
    expect((mounted as ApprovalPanelComponent).focused).toBe(true);

    // The full answer cycle works: respond resolves the request and the
    // editor slot returns to the editor.
    approvalControllerOf(driver).respond({ decision: 'approved' });
    await expect(pending).resolves.toEqual({ decision: 'approved' });
    expect(driver.state.editorContainer.children[0]).toBe(driver.state.editor);
  });

  it('attaching into a DIFFERENT session never pops the pending panel into its chat', async () => {
    const sessionA = makeAttachSession('ses-attached');
    const sessionB = makeAttachSession('ses-other');
    const { harness } = makeAgentsHarness(sessionA);
    harness.resumeSession = vi.fn(async (input: { id: string }) =>
      input.id === 'ses-other' ? sessionB : sessionA,
    ) as unknown as typeof harness.resumeSession;
    const driver = await bootAgentsView(harness);
    // initMainTui mounts the editor into its container; init() alone does not.
    driver.state.editorContainer.addChild(driver.state.editor);
    driver.onOpenSession('ses-attached');
    await vi.waitFor(() => {
      expect(driver.state.appState.sessionId).toBe('ses-attached');
    });
    expect(driver.returnToAgentsView()).toBe(true);
    await vi.waitFor(() => {
      expect(driver.state.agentsView?.detached).toBe(false);
    });
    const pending = approvalHandlerOf(sessionA)(makeApprovalRequest('tc-1'));
    const setFocus = vi.spyOn(driver.state.ui, 'setFocus');

    driver.onOpenSession('ses-other');

    await vi.waitFor(() => {
      expect(driver.state.appState.sessionId).toBe('ses-other');
    });
    // Session A's panel never mounted into B's chat and never took focus.
    // The pending request is resolved by the session switch's cancel — the
    // same semantics as any switch with a pending approval — rather than
    // surfacing in the wrong chat.
    await expect(pending).resolves.toMatchObject({ decision: 'cancelled' });
    expect(driver.state.editorContainer.children[0]).toBe(driver.state.editor);
    expect(
      setFocus.mock.calls.some(([target]) => target instanceof ApprovalPanelComponent),
    ).toBe(false);
    expect(driver.session?.id).toBe('ses-other');
  });

  it('agents mode relaxes the streaming switch guard (wire detach never kills a turn)', async () => {
    const session = makeAttachSession('ses-attached');
    const { harness } = makeAgentsHarness(session);
    const driver = await bootAgentsView(harness);
    driver.state.appState.streamingPhase = 'waiting';

    driver.onOpenSession('ses-attached');

    await vi.waitFor(() => {
      expect(driver.state.appState.sessionId).toBe('ses-attached');
    });

    // The picker resume path is relaxed in agents mode too.
    const other = makeAttachSession('ses-other');
    harness.resumeSession.mockResolvedValueOnce(other);
    driver.state.appState.streamingPhase = 'waiting';
    await expect(driver.resumeSession('ses-other')).resolves.toBe(true);
    expect(driver.state.appState.sessionId).toBe('ses-other');
  });

  it('attach resets a stuck streamingPhase back to idle (R9 Q1b) — a missed turn.ended can no longer wedge the status permanently', async () => {
    const session = makeAttachSession('ses-attached');
    const { harness } = makeAgentsHarness(session);
    const driver = await bootAgentsView(harness);
    vi.spyOn(driver, 'showStatus').mockImplementation(() => {});
    // Simulate the R9 repro: a `turn.ended` for a previous session's short
    // turn never reached this client (no event backlog on the live
    // subscription), leaving the phase wedged non-idle.
    driver.state.appState.streamingPhase = 'thinking';

    driver.onOpenSession('ses-attached');

    await vi.waitFor(() => {
      expect(driver.state.appState.sessionId).toBe('ses-attached');
    });
    expect(driver.state.appState.streamingPhase).toBe('idle');
  });

  it('attach with a pending roster reply to the same row awaits its settlement before resuming, then renders the reply bubble (R9 Q1a)', async () => {
    const session = makeAttachSession('ses-attached');
    session.getResumeState.mockReturnValue(
      createResumeState({
        replay: [
          {
            time: Date.now(),
            type: 'message',
            message: {
              role: 'user',
              content: [{ type: 'text', text: 'reply from roster' }],
              toolCalls: [],
            },
          },
        ],
      }),
    );
    const { harness, wirePrompt } = makeAgentsHarness(session, { withWireReply: true });
    const driver = await bootAgentsView(harness);
    vi.spyOn(driver, 'showStatus').mockImplementation(() => {});

    let resolvePrompt: (() => void) | undefined;
    wirePrompt!.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        }),
    );

    vi.useFakeTimers();
    try {
      const component = driver.state.agentsView!.component;
      component.handleInput('[B'); // down: select the only row
      component.handleInput(' '); // space: enter reply mode
      driver.state.agentsView!.dispatch.editor.onSubmit?.('reply from roster');
      await vi.advanceTimersByTimeAsync(0);
      expect(driver.state.agentsView?.pendingReplyIds.has('ses-attached')).toBe(true);

      // Enter attaches immediately, before the reply RPC has settled — this
      // must not race ahead of the reply's own durability.
      driver.onOpenSession('ses-attached');
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.resumeSession).not.toHaveBeenCalled();

      resolvePrompt?.();
      await vi.advanceTimersByTimeAsync(0);

      expect(harness.resumeSession).toHaveBeenCalledWith({
        id: 'ses-attached',
        replayTurnLimit: REPLAY_TURN_LIMIT,
      });
      expect(driver.state.appState.sessionId).toBe('ses-attached');
      // The reply's own bubble is present on the FIRST hydrate pass — no
      // second attach needed to see it.
      expect(
        driver.state.transcriptEntries.some(
          (entry) => entry.kind === 'user' && entry.content === 'reply from roster',
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('normal mode keeps the streaming switch guard', async () => {
    const session = makeSession();
    const harness = makeHarness(session);
    const driver = makeDriver(harness, makeStartupInput()) as unknown as AttachDriver;
    await driver.init();
    driver.state.appState.streamingPhase = 'waiting';
    const showError = vi.spyOn(driver, 'showError').mockImplementation(() => {});

    await expect(driver.resumeSession('ses-other')).resolves.toBe(false);

    expect(showError).toHaveBeenCalledWith(
      'Cannot switch sessions while streaming — press Esc or Ctrl-C first.',
    );
    expect(harness.resumeSession).not.toHaveBeenCalled();
    expect(driver.state.appState.sessionId).toBe('ses-1');
  });

  // ── ← return-to-view + attach footer badge ──

  it('returnToAgentsView remounts the view over the live roster and clears the badge', async () => {
    const session = makeAttachSession('ses-attached');
    const { harness, emit } = makeAgentsHarness(session);
    const driver = await bootAgentsView(harness);
    vi.spyOn(driver, 'showStatus').mockImplementation(() => {});
    driver.onOpenSession('ses-attached');
    await vi.waitFor(() => {
      expect(driver.state.appState.sessionId).toBe('ses-attached');
    });
    const view = driver.state.agentsView;
    expect(view?.detached).toBe(true);

    // The attached session's own work never enters the badge — it is on
    // screen, not "other agents" news.
    emit({
      type: 'event.session.work_changed',
      sessionId: 'ses-attached',
      busy: true,
      pending_interaction: 'none',
    } as Event);
    expect(driver.state.footer.render(120)[0]).not.toContain('←');

    // Another VIEW-OWNED session working DOES reach the badge while attached.
    // (A session created by another client is not in the registry — its
    // created event is gated out and never moves the badge.)
    emit({
      type: 'event.session.created',
      session: {
        id: 'ses-other',
        title: 'other title',
        metadata: { cwd: '/tmp/proj-b' },
        updated_at: new Date(2_000).toISOString(),
        busy: true,
        pending_interaction: 'none',
      },
    } as Event);
    expect(driver.state.footer.render(120)[0]).toContain('[← 1 agent]');

    expect(driver.returnToAgentsView()).toBe(true);

    // Same component remounted, roster state survived, badge cleared.
    expect(view?.detached).toBe(false);
    expect(driver.state.ui.children).toContain(view?.component);
    expect(view?.roster.counts().working).toBe(2);
    expect(driver.state.footer.render(120)[0]).not.toContain('←');
  });

  it('returnToAgentsView is a no-op outside attach (view mounted or normal mode)', async () => {
    const session = makeAttachSession('ses-attached');
    const { harness } = makeAgentsHarness(session);
    const driver = await bootAgentsView(harness);

    // View mounted (not attached): the key must fall through.
    expect(driver.returnToAgentsView()).toBe(false);
    expect(driver.state.agentsView?.detached).toBe(false);

    // Normal mode: zero behavior change.
    const plainSession = makeSession();
    const plainDriver = makeDriver(makeHarness(plainSession), makeStartupInput()) as unknown as AttachDriver;
    await plainDriver.init();
    expect(plainDriver.returnToAgentsView()).toBe(false);
  });

  // ── R4 parity: ← return sets the origin row ("session you came from") ──

  it('returnToAgentsView passes the just-left session as the origin', async () => {
    const session = makeAttachSession('ses-attached');
    const { harness } = makeAgentsHarness(session);
    const driver = await bootAgentsView(harness);
    vi.spyOn(driver, 'showStatus').mockImplementation(() => {});
    driver.onOpenSession('ses-attached');
    await vi.waitFor(() => {
      expect(driver.state.appState.sessionId).toBe('ses-attached');
    });
    expect(driver.state.agentsView?.originSessionId).toBeUndefined();

    expect(driver.returnToAgentsView()).toBe(true);

    await vi.waitFor(() => {
      expect(driver.state.agentsView?.detached).toBe(false);
    });
    expect(driver.state.agentsView?.originSessionId).toBe('ses-attached');
  });

  it('cold open (never attached) has no origin', async () => {
    const session = makeAttachSession('ses-attached');
    const { harness } = makeAgentsHarness(session);
    const driver = await bootAgentsView(harness);
    expect(driver.state.agentsView?.originSessionId).toBeUndefined();
  });

  it('seeds the badge excluding the session being attached (already-awaiting attach)', async () => {
    // Regression (review round 2): the seed runs before switchToSession sets
    // appState.sessionId, so it must exclude the TARGET id — an attach target
    // that already awaits input must not appear in its own badge.
    const session = makeAttachSession('ses-attached');
    const { harness, emit } = makeAgentsHarness(session);
    const driver = await bootAgentsView(harness);
    vi.spyOn(driver, 'showStatus').mockImplementation(() => {});
    emit({
      type: 'event.session.work_changed',
      sessionId: 'ses-attached',
      busy: false,
      pending_interaction: 'approval',
    } as Event);

    driver.onOpenSession('ses-attached');
    await vi.waitFor(() => {
      expect(driver.state.appState.sessionId).toBe('ses-attached');
    });

    expect(driver.state.footer.render(120)[0]).not.toContain('←');
  });
});

function uiContainsFooter(driver: StartupDriver): boolean {
  const target: unknown = driver.state.footer;
  const visit = (node: unknown): boolean => {
    if (node === target) return true;
    const children = (node as { children?: unknown[] }).children;
    return Array.isArray(children) && children.some(visit);
  };
  return visit(driver.state.ui);
}

// ── Agents-view dispatch skill-menu warm-up (R6 review fix) ──
//
// The dispatch composer's skill menu is normally sourced from
// `skillCommands`, populated only once a session has attached this run
// (`refreshSkillCommands(session)`). `warmAgentsViewSkillMenu` closes that
// gap via `KimiHarness.listWorkspaceSkills` — the one session-independent
// skill route the SDK has — so the menu offers skills on a completely cold
// `kimi agents` launch too. These drive the real `KimiTUI`, not a fake
// `AgentsViewHost`, to prove the actual wiring (not just the contract).

describe('KimiTUI agents-view dispatch skill warm-up', () => {
  interface WarmDriver extends StartupDriver {
    agentsViewController: { show(): Promise<void> };
    session: { id: string } | undefined;
  }

  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function skillSummary(name: string): SkillSummary {
    return {
      name,
      description: `${name} description`,
      path: `/tmp/proj-a/.kimi/skills/${name}/SKILL.md`,
      source: 'project',
    };
  }

  async function bootColdAgentsView(listWorkspaceSkills: ReturnType<typeof vi.fn>): Promise<WarmDriver> {
    const homeDir = mkdtempSync(join(tmpdir(), 'kimi-agents-warm-'));
    dirs.push(homeDir);
    // Empty view registry: a cold `kimi agents` launch has never dispatched
    // or attached to anything yet.
    writeFileSync(join(homeDir, 'agents-view.json'), JSON.stringify({ pins: [], sessions: [] }));
    const harness = makeHarness(makeSession(), {
      homeDir,
      listSessions: vi.fn(async () => []),
      listWorkspaceSkills,
      onEvent: () => () => {},
    });
    const driver = makeDriver(harness, {
      ...makeStartupInput(),
      startupAgentsView: true,
    }) as unknown as WarmDriver;
    await driver.init();
    expect(driver.state.startupState).toBe('agents-view');
    await driver.agentsViewController.show();
    expect(driver.state.agentsView).toBeDefined();
    return driver;
  }

  async function slashMenuItems(driver: StartupDriver): Promise<string[]> {
    const provider = (
      driver.state.agentsView?.dispatch.editor as unknown as
        | {
            autocompleteProvider: {
              getSuggestions(
                lines: string[],
                cursorLine: number,
                cursorCol: number,
                options: { signal: AbortSignal },
              ): Promise<{ items: { value: string }[] } | null>;
            };
          }
        | undefined
    )?.autocompleteProvider;
    if (provider === undefined) return [];
    const suggestions = await provider.getSuggestions(['/'], 0, 1, { signal: new AbortController().signal });
    return suggestions?.items.map((item) => item.value).toSorted() ?? [];
  }

  it('warms the dispatch composer skill menu via listWorkspaceSkills before any session attaches', async () => {
    const listWorkspaceSkills = vi.fn(async () => [skillSummary('reviewcode')]);
    const driver = await bootColdAgentsView(listWorkspaceSkills);

    await vi.waitFor(async () => {
      expect(await slashMenuItems(driver)).toContain('skill:reviewcode');
    });

    expect(listWorkspaceSkills).toHaveBeenCalledWith('/tmp/proj-a');
    // The menu populated without ever creating or attaching a session —
    // the whole point of a session-independent warm route.
    expect(driver.session).toBeUndefined();
  });

  it('leaves the plugin section empty pre-attach — the skill warm never touches plugin state', async () => {
    const listWorkspaceSkills = vi.fn(async () => [skillSummary('reviewcode')]);
    const driver = await bootColdAgentsView(listWorkspaceSkills);

    await vi.waitFor(async () => {
      expect(await slashMenuItems(driver)).toContain('skill:reviewcode');
    });

    const names = await slashMenuItems(driver);
    expect(names.some((name) => name.includes(':') && !name.startsWith('skill:'))).toBe(false);
  });
});

// ── Agents-view exit confirmation (embedded server) ──

describe('KimiTUI agents-view exit confirmation', () => {
  interface ExitConfirmDriver extends StartupDriver {
    setAgentsView(value: unknown): void;
    agentsViewController: { show(): Promise<void>; close(): void };
    onExit?: (code?: number) => Promise<void>;
  }

  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeExitHarness() {
    const homeDir = mkdtempSync(join(tmpdir(), 'kimi-agents-exit-'));
    dirs.push(homeDir);
    return makeHarness(makeSession(), {
      homeDir,
      onEvent: () => () => {},
    });
  }

  function findConfirm(driver: StartupDriver): AgentsExitConfirmComponent | undefined {
    return driver.state.ui.children.find(
      (child): child is AgentsExitConfirmComponent =>
        child instanceof AgentsExitConfirmComponent,
    );
  }

  /** Boots into the agents view with the stop()-shutdown I/O stubbed. */
  async function bootAgentsView(guard: (() => Promise<number>) | undefined) {
    const harness = makeExitHarness();
    const driver = makeDriver(harness, {
      ...makeStartupInput(),
      startupAgentsView: true,
      agentsViewExitGuard: guard,
    }) as unknown as ExitConfirmDriver;
    await driver.init();
    expect(driver.state.startupState).toBe('agents-view');
    // pi-tui stop/drain touch the real TTY — stub the shutdown I/O.
    vi.spyOn(driver.state.ui, 'stop').mockImplementation(() => {});
    vi.spyOn(driver.state.terminal, 'drainInput').mockImplementation(async () => {});
    driver.onExit = vi.fn(async () => {});
    await driver.agentsViewController.show();
    expect(driver.state.agentsView).toBeDefined();
    return { harness, driver };
  }

  it('embedded + running sessions: y confirms the interruption and shutdown proceeds', async () => {
    const guard = vi.fn(async () => 3);
    const { harness, driver } = await bootAgentsView(guard);

    const stopPromise = driver.stop(0);
    await vi.waitFor(() => {
      expect(findConfirm(driver)).toBeDefined();
    });

    findConfirm(driver)?.handleInput('y');
    await stopPromise;

    expect(guard).toHaveBeenCalledOnce();
    expect(harness.close).toHaveBeenCalledOnce();
    expect(driver.onExit).toHaveBeenCalledWith(0);
  });

  it('declining keeps the TUI alive and the view mounted; a later stop re-asks', async () => {
    const guard = vi.fn(async () => 2);
    const { harness, driver } = await bootAgentsView(guard);
    const view = driver.state.agentsView;
    // Spied after the boot mount: a decline must not rebuild anything.
    const show = vi.spyOn(driver.agentsViewController, 'show');

    const first = driver.stop(0);
    await vi.waitFor(() => {
      expect(findConfirm(driver)).toBeDefined();
    });
    findConfirm(driver)?.handleInput('n');
    await first;

    expect(harness.close).not.toHaveBeenCalled();
    expect(driver.onExit).not.toHaveBeenCalled();
    expect(driver.state.agentsView).toBe(view);
    expect(driver.state.ui.children).toContain(view?.component);
    expect(view?.component.focused).toBe(true);
    expect(show).not.toHaveBeenCalled();

    // Fully reversible: quitting again re-asks from scratch.
    const second = driver.stop(0);
    await vi.waitFor(() => {
      expect(findConfirm(driver)).toBeDefined();
    });
    findConfirm(driver)?.handleInput('y');
    await second;
    expect(harness.close).toHaveBeenCalledOnce();
    expect(driver.onExit).toHaveBeenCalledWith(0);
  });

  it('declining on the Esc/q quit path (view already closed) rebuilds the view', async () => {
    const guard = vi.fn(async () => 1);
    const { harness, driver } = await bootAgentsView(guard);
    const show = vi.spyOn(driver.agentsViewController, 'show');

    // The production quit path: controller.close() → setAgentsView(undefined)
    // → stop(). The confirm must gate BEFORE the shutdown sequence, and a
    // decline puts the user back in the view.
    driver.agentsViewController.close();
    await vi.waitFor(() => {
      expect(findConfirm(driver)).toBeDefined();
    });
    expect(driver.state.agentsView).toBeUndefined();

    findConfirm(driver)?.handleInput('n');

    await vi.waitFor(() => {
      expect(driver.state.agentsView).toBeDefined();
    });
    expect(show).toHaveBeenCalledOnce();
    expect(harness.close).not.toHaveBeenCalled();
    expect(driver.onExit).not.toHaveBeenCalled();
  });

  it('embedded + no running sessions: no dialog, shutdown proceeds', async () => {
    const guard = vi.fn(async () => 0);
    const { harness, driver } = await bootAgentsView(guard);

    // A mounted dialog would await key input forever — resolving proves none.
    await driver.stop(0);

    expect(guard).toHaveBeenCalledOnce();
    expect(findConfirm(driver)).toBeUndefined();
    expect(harness.close).toHaveBeenCalledOnce();
    expect(driver.onExit).toHaveBeenCalledWith(0);
  });

  it('attached mode wires no exit guard: no dialog, sessions keep running server-side', async () => {
    const { harness, driver } = await bootAgentsView(undefined);

    await driver.stop(0);

    expect(findConfirm(driver)).toBeUndefined();
    expect(harness.close).toHaveBeenCalledOnce();
    expect(driver.onExit).toHaveBeenCalledWith(0);
  });

  it('signal-driven stop (SIGTERM, exit 143) skips the dialog and shuts down straight away', async () => {
    // Folded review item: there is no user to answer an interactive confirm
    // on the signal path — stop(143) must not mount one, and the graceful
    // shutdown below settles sessions (state is on disk). User quit in the
    // same state (stop(0) above) still shows the dialog.
    const guard = vi.fn(async () => 3);
    const { harness, driver } = await bootAgentsView(guard);

    // A mounted dialog would await key input forever — resolving proves none.
    await driver.stop(143);

    expect(guard).not.toHaveBeenCalled();
    expect(findConfirm(driver)).toBeUndefined();
    expect(harness.close).toHaveBeenCalledOnce();
    expect(driver.onExit).toHaveBeenCalledWith(143);
  });

  it('a failed session count never traps the user — shutdown proceeds without the dialog', async () => {
    const guard = vi.fn(async (): Promise<number> => {
      throw new Error('server unreachable');
    });
    const { harness, driver } = await bootAgentsView(guard);

    await driver.stop(0);

    expect(harness.close).toHaveBeenCalledOnce();
    expect(driver.onExit).toHaveBeenCalledWith(0);
  });

  it('normal mode never consults the guard, even if one was wired', async () => {
    const guard = vi.fn(async () => 5);
    const harness = makeHarness(makeSession());
    const driver = makeDriver(harness, {
      ...makeStartupInput(),
      agentsViewExitGuard: guard,
    }) as unknown as ExitConfirmDriver;
    await driver.init();
    expect(driver.state.startupState).toBe('ready');
    vi.spyOn(driver.state.ui, 'stop').mockImplementation(() => {});
    vi.spyOn(driver.state.terminal, 'drainInput').mockImplementation(async () => {});
    driver.onExit = vi.fn(async () => {});

    await driver.stop(0);

    expect(guard).not.toHaveBeenCalled();
    expect(harness.close).toHaveBeenCalledOnce();
    expect(driver.onExit).toHaveBeenCalledWith(0);
  });
});
