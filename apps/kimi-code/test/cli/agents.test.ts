/**
 * `kimi agents`
 *
 * Verifies the CLI layer for the agents view: the sub-command is registered
 * beside the other sub-commands, `agents` parses and routes to its action,
 * and routing never falls through to the main command handler. The runner
 * itself is injected, so no server is started and no TUI boots.
 */

import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { createProgram } from '#/cli/commands';
import { registerAgentsCommand } from '#/cli/sub/agents';

describe('kimi agents — registration', () => {
  it('createProgram registers the agents sub-command', () => {
    const program = createProgram('0.0.0-test', () => {}, () => {});
    const names = program.commands.map((command) => command.name());
    expect(names).toContain('agents');
  });

  it('parses `agents` and routes to its action without touching main', async () => {
    const run = vi.fn(async () => {});
    const onMain = vi.fn();
    const program = new Command('kimi');
    registerAgentsCommand(program, run);
    program.argument('[args...]').action(() => {
      onMain();
    });

    await program.parseAsync(['node', 'kimi', 'agents']);

    expect(run).toHaveBeenCalledOnce();
    expect(onMain).not.toHaveBeenCalled();
  });

  it('forwards program-level --auto/--yolo/--plan to the runner', async () => {
    const run = vi.fn(async () => {});
    const program = new Command('kimi');
    program
      .option('-y, --yolo', 'yolo', false)
      .option('--auto', 'auto', false)
      .option('--plan', 'plan', false);
    registerAgentsCommand(program, run);

    await program.parseAsync(['node', 'kimi', '--auto', '--plan', 'agents']);
    expect(run).toHaveBeenCalledWith({ auto: true, yolo: false, plan: true });

    const yoloRun = vi.fn(async () => {});
    const yoloProgram = new Command('kimi');
    yoloProgram
      .option('-y, --yolo', 'yolo', false)
      .option('--auto', 'auto', false)
      .option('--plan', 'plan', false);
    registerAgentsCommand(yoloProgram, yoloRun);

    await yoloProgram.parseAsync(['node', 'kimi', '-y', 'agents']);
    expect(yoloRun).toHaveBeenCalledWith({ auto: false, yolo: true, plan: false });
  });
});
