/**
 * `kimi agents` runner (agents-run) — crash-handler coverage.
 *
 * The agents runner sets `tui.onExit` itself instead of going through
 * run-shell, so it must install run-shell's crash safety net on its own:
 * without a process `unhandledRejection` listener the telemetry crash
 * handler stays the sole listener and rethrows by design, turning any
 * stray rejection during the embedded server's shutdown into a naked
 * crash dump. These tests pin the handlers' presence, their clean-exit
 * behavior, and their lifetime (up through the server shutdown, removed
 * before the final exit).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runAgents } from '#/cli/sub/agents-run';

import { captureProcessWrite, ExitCalled, mockProcessExit } from '../helpers/process';

const mocks = vi.hoisted(() => ({
  loadTuiConfig: vi.fn(async () => ({
    theme: 'dark' as const,
    editorCommand: null,
    notifications: { enabled: false, condition: 'unfocused' as const },
  })),
  getColorPalette: vi.fn(async () => ({})),
  setPalette: vi.fn(),
  resolveAgentsServer: vi.fn(async () => ({
    baseUrl: 'http://127.0.0.1:11000',
    token: 'tok',
    mode: 'embedded' as const,
    shutdown: vi.fn(async () => {}),
  })),
  countRunningSessions: vi.fn(async () => 0),
  createKimiHarnessWire: vi.fn(
    async (_input: { sessionStartedProperties?: Record<string, boolean> }) => ({
      ensureConfigFile: mocks.harnessEnsureConfigFile,
      close: mocks.harnessClose,
    }),
  ),
  harnessClose: vi.fn(async () => {}),
  harnessEnsureConfigFile: vi.fn(async () => {}),
  kimiTuiConstructor: vi.fn(),
  tuiStart: vi.fn(async () => {}),
  flushDiagnosticLogsSync: vi.fn(),
  logError: vi.fn(),
  restoreTerminalModes: vi.fn(),
}));

vi.mock('@moonshot-ai/kimi-code-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/kimi-code-sdk')>();
  return {
    ...actual,
    flushDiagnosticLogsSync: mocks.flushDiagnosticLogsSync,
    log: { error: mocks.logError },
    createKimiHarnessWire: mocks.createKimiHarnessWire,
  };
});

vi.mock('@moonshot-ai/kimi-telemetry', () => ({
  track: vi.fn(),
  setTelemetryContext: vi.fn(),
  withTelemetryContext: vi.fn(() => ({ track: vi.fn() })),
}));

vi.mock('../../src/agents-view/server-lifecycle', () => ({
  resolveAgentsServer: mocks.resolveAgentsServer,
  countRunningSessions: mocks.countRunningSessions,
}));

vi.mock('../../src/tui/config', () => ({
  loadTuiConfig: mocks.loadTuiConfig,
  TuiConfigParseError: class TuiConfigParseError extends Error {},
}));

vi.mock('../../src/tui/index', () => ({
  KimiTUI: class {
    onExit?: (exitCode?: number) => Promise<void>;

    constructor(...args: unknown[]) {
      mocks.kimiTuiConstructor(this, ...args);
    }

    start = mocks.tuiStart;
  },
}));

vi.mock('../../src/tui/theme', () => ({
  currentTheme: { setPalette: mocks.setPalette },
  getColorPalette: mocks.getColorPalette,
}));

vi.mock('../../src/utils/terminal-restore', () => ({
  restoreTerminalModes: mocks.restoreTerminalModes,
}));

const NEUTRAL_FLAGS = { auto: false, yolo: false, plan: false };

describe('runAgents crash handlers', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('exits cleanly on an unhandled rejection instead of rethrowing it', async () => {
    const processOnSpy = vi.spyOn(process, 'on');
    const processOffSpy = vi.spyOn(process, 'off');
    const stderr = captureProcessWrite('stderr');
    const exitSpy = mockProcessExit();

    try {
      await runAgents(NEUTRAL_FLAGS);

      const rejectionHandler = processOnSpy.mock.calls.find(
        ([event]) => event === 'unhandledRejection',
      )?.[1] as ((reason: unknown) => void) | undefined;
      const exceptionHandler = processOnSpy.mock.calls.find(
        ([event]) => event === 'uncaughtException',
      )?.[1] as ((error: unknown) => void) | undefined;
      expect(rejectionHandler).toBeDefined();
      expect(exceptionHandler).toBeDefined();

      // The async log sink cannot flush before process.exit() runs, so the
      // crash handler must force a synchronous flush first or the crash
      // reason is lost.
      expect(() => rejectionHandler?.(new Error('Agent loop disposed'))).toThrow(ExitCalled);
      expect(mocks.flushDiagnosticLogsSync).toHaveBeenCalledOnce();
      expect(mocks.restoreTerminalModes).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mocks.flushDiagnosticLogsSync.mock.invocationCallOrder[0]!).toBeLessThan(
        exitSpy.mock.invocationCallOrder[0]!,
      );
    } finally {
      processOnSpy.mockRestore();
      processOffSpy.mockRestore();
      exitSpy.mockRestore();
      stderr.restore();
    }
  });

  it('keeps the handlers up through the server shutdown and removes them before the final exit', async () => {
    const processOnSpy = vi.spyOn(process, 'on');
    const processOffSpy = vi.spyOn(process, 'off');
    const stderr = captureProcessWrite('stderr');
    const exitSpy = mockProcessExit();

    try {
      await runAgents(NEUTRAL_FLAGS);

      const tui = mocks.kimiTuiConstructor.mock.calls[0]![0] as {
        onExit?: (exitCode?: number) => Promise<void>;
      };
      expect(tui.onExit).toBeDefined();

      const server = await mocks.resolveAgentsServer.mock.results[0]!.value;
      // process.exit is mocked to throw ExitCalled — the exit IS the
      // expected end of onExit.
      await expect(tui.onExit!()).rejects.toThrow(ExitCalled);

      expect(mocks.harnessClose).toHaveBeenCalledOnce();
      expect(server.shutdown).toHaveBeenCalledOnce();
      // The shutdown is exactly the window a stray engine rejection needs
      // the handlers for — they come down only afterwards.
      const removedEvents = processOffSpy.mock.calls.map(([event]) => event);
      expect(removedEvents).toContain('unhandledRejection');
      expect(removedEvents).toContain('uncaughtException');
      expect(server.shutdown.mock.invocationCallOrder[0]!).toBeLessThan(
        processOffSpy.mock.invocationCallOrder[0]!,
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      processOnSpy.mockRestore();
      processOffSpy.mockRestore();
      exitSpy.mockRestore();
      stderr.restore();
    }
  });
});

describe('runAgents startup flags', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('forwards --auto/--yolo/--plan into the TUI cliOptions and the harness session-started telemetry', async () => {
    await runAgents({ auto: true, yolo: false, plan: true });

    // Without this, `kimi --auto agents` silently boots the view in manual
    // permission mode: the flags must reach both the TUI (dispatched/attached
    // sessions) and the session-started telemetry properties.
    const startupInput = mocks.kimiTuiConstructor.mock.calls[0]![2] as {
      cliOptions: { auto: boolean; yolo: boolean; plan: boolean };
    };
    expect(startupInput.cliOptions).toMatchObject({ auto: true, yolo: false, plan: true });

    expect(mocks.createKimiHarnessWire.mock.calls[0]![0].sessionStartedProperties).toEqual({
      yolo: false,
      auto: true,
      plan: true,
      afk: false,
    });
  });
});
