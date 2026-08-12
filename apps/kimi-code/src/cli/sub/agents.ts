/**
 * `kimi agents` sub-command.
 *
 * CLI glue only (vis-style single-file registration): delegates to the
 * runner in `./agents-run`, which resolves the kap-server (attach or embed),
 * builds the wire harness and boots the TUI straight into the agents view.
 * The runner is injectable so tests can parse the command without booting
 * anything.
 */

import type { Command } from 'commander';

import { runAgents, type AgentsStartupFlags } from './agents-run';

export function registerAgentsCommand(
  parent: Command,
  run: (startupFlags: AgentsStartupFlags) => Promise<void> = runAgents,
): void {
  parent
    .command('agents')
    .description('Open the agents view: dispatch new sessions and monitor running ones.')
    .action(async () => {
      // `--auto`/`--yolo`/`--plan` are program-level options, so `kimi --auto
      // agents` lands them on the parent — forward them or the view would
      // silently fall back to manual permission mode. Same hidden-alias
      // folding the main command handler applies to `--yes`/`--auto-approve`.
      const opts = parent.opts<Record<string, unknown>>();
      await run({
        auto: opts['auto'] === true,
        yolo: opts['yolo'] === true || opts['yes'] === true || opts['autoApprove'] === true,
        plan: opts['plan'] === true,
      });
    });
}
