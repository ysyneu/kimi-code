/**
 * `kimi agents` runner — boots a wire-harness KimiTUI straight into the
 * agents view as its home screen (no startup session is created; the view
 * mounts via the `startupAgentsView` init branch).
 *
 * Mirrors run-shell's preamble, trimmed to what this surface needs:
 * loadTuiConfig → theme palette → home-dir bootstrap → resolveAgentsServer
 * (attach to the running kap-server, or embed one in-process) → wire harness
 * → KimiTUI. No migration check, no agent-profile resolution, and no
 * telemetry sink — the module-level telemetry client is a safe no-op until
 * `initializeTelemetry` runs, and this surface has no events of its own to
 * report (sessions dispatched from the view are tracked server-side).
 */

import {
  createKimiHarnessWire,
  type KimiHarness,
  type TelemetryClient,
} from '@moonshot-ai/kimi-code-sdk';
import { setTelemetryContext, track, withTelemetryContext } from '@moonshot-ai/kimi-telemetry';

import {
  countRunningSessions,
  resolveAgentsServer,
} from '#/agents-view/server-lifecycle';
import { loadTuiConfig, TuiConfigParseError, type TuiConfig } from '#/tui/config';
import { KimiTUI } from '#/tui/index';
import { currentTheme, getColorPalette } from '#/tui/theme';

import type { CLIOptions } from '#/cli/options';
import { createCliTelemetryBootstrap } from '#/cli/telemetry';
import { createKimiCodeHostIdentity, getVersion } from '#/cli/version';

/** A neutral CLIOptions value — `kimi agents` never opens a chat session. */
const AGENTS_CLI_OPTIONS: CLIOptions = {
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
};

export async function runAgents(): Promise<void> {
  const version = getVersion();

  let tuiConfig: TuiConfig;
  let configWarning: string | undefined;
  try {
    tuiConfig = await loadTuiConfig();
  } catch (error) {
    if (!(error instanceof TuiConfigParseError)) throw error;
    tuiConfig = error.fallback;
    configWarning = error.message;
  }

  // Initialise the global Theme singleton before pi-tui grabs stdin.
  const palette = await getColorPalette(tuiConfig.theme);
  currentTheme.setPalette(palette);

  const { homeDir } = createCliTelemetryBootstrap();
  const telemetry: TelemetryClient = {
    track,
    withContext: withTelemetryContext,
    setContext: setTelemetryContext,
  };
  const identity = createKimiCodeHostIdentity(version);

  // Version-mismatched or dead instances are skipped during resolution, so a
  // failure here means the embedded server itself could not start. Report it
  // cleanly instead of crashing the TUI boot.
  let server: Awaited<ReturnType<typeof resolveAgentsServer>>;
  try {
    server = await resolveAgentsServer({ homeDir, identity, cliVersion: version });
  } catch (error) {
    process.stderr.write(
      `Failed to start kimi agents: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }

  const harness: KimiHarness = await createKimiHarnessWire({
    serverUrl: server.baseUrl,
    token: server.token,
    homeDir,
    identity,
    telemetry,
    sessionStartedProperties: { yolo: false, auto: false, plan: false, afk: false },
  });
  await harness.ensureConfigFile();

  const tui = new KimiTUI(harness, {
    cliOptions: AGENTS_CLI_OPTIONS,
    tuiConfig,
    version,
    workDir: process.cwd(),
    startupNotice: configWarning,
    startupAgentsView: true,
    agentsViewServerLabel: server.mode === 'attached' ? new URL(server.baseUrl).host : 'embedded',
    // The exit confirmation only matters when this process owns the server:
    // quitting shuts it down and interrupts its running sessions. An attached
    // server outlives the CLI — disconnecting needs no confirmation.
    agentsViewExitGuard:
      server.mode === 'embedded' ? () => countRunningSessions(server) : undefined,
  });

  tui.onExit = async (exitCode = 0) => {
    // Wire transport: close() only disconnects; an attached server keeps
    // running, an embedded one is shut down right after (any running
    // sessions were already confirmed by the stop() exit dialog).
    await harness.close();
    await server.shutdown();
    // The view's sessions run the v2 engine on the kap-server — `kimi
    // --resume` (v1 storage) can't reopen them, so the
    // re-entry point is the view itself.
    process.stderr.write(`\nTo resume your sessions: kimi agents\n`);
    process.exit(exitCode);
  };

  await tui.start();
}
