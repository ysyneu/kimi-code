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

import { runAgents } from './agents-run';

export function registerAgentsCommand(
  parent: Command,
  run: () => Promise<void> = runAgents,
): void {
  parent
    .command('agents')
    .description('Open the agents view: dispatch new sessions and monitor running ones.')
    .action(async () => {
      await run();
    });
}
