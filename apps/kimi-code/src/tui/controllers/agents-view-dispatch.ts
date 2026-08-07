/**
 * AgentsViewDispatch — the dispatch editor assembly for the agents view: a
 * CustomEditor instance with a whitelist slash-command autocomplete, plus the
 * submission parser that turns the raw input into a `DispatchSubmission`.
 *
 * The whitelist itself is built controller-side (see `dispatchSlashCommands`
 * in `./agents-view`); this module only accepts the final command array.
 * Model/profile selections are staged on the parsed submission and ride the
 * first prompt's submission body (the wire create route drops
 * per-session agent config, so createSession never sees them). Skill/plugin-
 * command selections stage a `DispatchActivation` instead — applied via
 * `session.activateSkill`/`activatePluginCommand` in place of the first
 * `prompt` call (see `AgentsViewController.handleDispatch`), since neither
 * is literal prompt text the model should see verbatim.
 */

import type { TUI } from '@moonshot-ai/pi-tui';

import { resolveSkillCommand } from '../commands/resolve';
import type { KimiSlashCommand } from '../commands/types';
import { CustomEditor } from '../components/editor/custom-editor';
import {
  FileMentionProvider,
  type SlashAutocompleteCommand,
} from '../components/editor/file-mention-provider';

/**
 * A staged skill or plugin-command activation: resolved at parse time from
 * the same command names / lookup rules the main chat's own dispatcher uses
 * (`commands/resolve.ts`'s `resolveSkillCommand` and plugin-map lookup),
 * applied on the first RPC call after `createSession()` — `session.
 * activateSkill`/`activatePluginCommand` instead of `session.prompt` — the
 * same "stage the choice, apply on first RPC" shape `/model`/`/agent` use.
 */
export type DispatchActivation =
  | { readonly kind: 'skill'; readonly skillName: string; readonly args: string }
  | {
      readonly kind: 'plugin-command';
      readonly pluginId: string;
      readonly commandName: string;
      readonly args: string;
    };

/** Skill/plugin-command menu entries plus their activation-lookup maps —
 *  the exact fields `KimiTUI` already caches for the main chat's own `/`
 *  menu (`skillCommands`/`pluginCommands`/`skillCommandMap`/
 *  `pluginCommandMap`), threaded through unchanged. */
export interface DispatchActivatableCommands {
  readonly commands: readonly KimiSlashCommand[];
  readonly skillCommandMap: ReadonlyMap<string, string>;
  readonly pluginCommandMap: ReadonlyMap<string, string>;
}

export interface DispatchSubmission {
  readonly text: string;
  readonly model?: string;
  readonly profile?: string;
  readonly activation?: DispatchActivation;
}

export type DispatchParseResult = DispatchSubmission | { readonly error: string };

/** `Too short` floor: at least this many non-space characters. */
const MIN_NON_SPACE_CHARS = 3;

/**
 * Default composer placeholder — the dispatch target is "a new session".
 * The reply panel (agents-view controller) swaps this to the fixed literal
 * `'reply'` via `CustomEditor.setPlaceholder` and restores this exact string
 * on submit/Esc/close, so the two never drift out of sync.
 */
export const DISPATCH_PLACEHOLDER = 'describe a task for a new session';

/**
 * Resolves a non-`/model`/`/agent` command name against the skill/plugin
 * activation maps, mirroring `commands/resolve.ts`'s `resolveSlashCommandInput`
 * skill and plugin-command branches exactly (same double-lookup for skills —
 * bare name or `skill:`-prefixed — same `pluginId:commandName` split), so a
 * name that resolves in the main chat resolves here too. Returns `undefined`
 * for anything that isn't a known skill or plugin command.
 */
function resolveDispatchActivation(
  commandName: string,
  args: string,
  { skillCommandMap, pluginCommandMap }: DispatchActivatableCommands,
): DispatchActivation | undefined {
  const skillName = resolveSkillCommand(skillCommandMap, commandName);
  if (skillName !== undefined) return { kind: 'skill', skillName, args };
  if (pluginCommandMap.has(commandName)) {
    const separator = commandName.indexOf(':');
    const pluginId = separator === -1 ? commandName : commandName.slice(0, separator);
    const cmdName = separator === -1 ? '' : commandName.slice(separator + 1);
    return { kind: 'plugin-command', pluginId, commandName: cmdName, args };
  }
  return undefined;
}

/**
 * Parses raw dispatch input. Plain text becomes the first prompt of a new
 * session; a leading `/model <name>` or `/agent <profile>` stages that
 * override for the first prompt; a leading skill or plugin-command name
 * (resolved against `activatable`, the same maps the main chat's own
 * dispatcher uses) stages a skill/plugin activation instead — see
 * `DispatchActivation`. Any other leading slash command only exists inside a
 * session and is rejected, as is empty / near-empty input. `/model` or
 * `/agent` with no argument is rejected with a command-specific usage hint
 * rather than falling through to the generic too-short message. Skill/
 * plugin-command args carry no minimum length (matching the main chat, which
 * applies none either — many skills take no arguments at all).
 */
export function parseDispatchInput(
  raw: string,
  activatable: DispatchActivatableCommands,
): DispatchParseResult {
  const trimmed = raw.trim();
  let text = trimmed;
  let model: string | undefined;
  let profile: string | undefined;

  if (trimmed.startsWith('/')) {
    const spaceIndex = trimmed.search(/\s/);
    const command = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
    const rest = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex).trim();
    if (command !== '/model' && command !== '/agent') {
      const activation = resolveDispatchActivation(command.slice(1), rest, activatable);
      if (activation !== undefined) return { text: '', activation };
      return { error: `"${command}" is only available inside a session` };
    }
    const argSpaceIndex = rest.search(/\s/);
    const argument = argSpaceIndex === -1 ? rest : rest.slice(0, argSpaceIndex);
    text = argSpaceIndex === -1 ? '' : rest.slice(argSpaceIndex).trim();
    if (argument === '') {
      const placeholder = command === '/model' ? '<alias>' : '<profile>';
      const noun = command === '/model' ? 'model alias' : 'profile name';
      return { error: `${command} needs a ${noun} and a task — ${command} ${placeholder} <task>` };
    }
    if (command === '/model') model = argument;
    else profile = argument;
  }

  if (text.replaceAll(/\s/g, '').length < MIN_NON_SPACE_CHARS) {
    return { error: 'Too short — describe the task' };
  }
  return { text, model, profile };
}

/** Exact strings that close the view from the dispatch composer — dispatch
 *  mode only (see `AgentsViewDispatch.handleEditorSubmit`); reply mode has
 *  no command surface at all, so typing either of these as a reply sends it
 *  as literal text through `parseReplyInput`, same as anything else. */
const EXIT_COMMANDS = new Set(['exit', '/exit']);

/**
 * Parses raw REPLY input (an existing session, not a new one): unlike
 * `parseDispatchInput`, a leading `/` is never interpreted — there is no
 * slash-command surface to route to inside a reply, so treating one as a
 * `/model`/`/agent` override (or rejecting it as session-only) would either
 * silently swallow the user's actual text or reject text that was never a
 * command in the first place. The only check kept is the same too-short
 * floor `parseDispatchInput` already applies, so a stray Enter can't send a
 * blank prompt to the target session.
 */
export function parseReplyInput(raw: string): DispatchParseResult {
  if (raw.replaceAll(/\s/g, '').length < MIN_NON_SPACE_CHARS) {
    return { error: 'Too short — describe the task' };
  }
  return { text: raw };
}

/**
 * Owns the dispatch CustomEditor: submits parse through `parseDispatchInput`
 * (or, while `replying` is set, the no-slash-detection `parseReplyInput`) and
 * fan out to `onSubmit` (parsed submission) or `onError` (rejection message).
 * The editor clears itself on submit (pi-tui behaviour), so every submission
 * starts from an empty box.
 */
export class AgentsViewDispatch {
  readonly editor: CustomEditor;
  onSubmit: ((parsed: DispatchSubmission) => void) | undefined;
  onError: ((message: string) => void) | undefined;
  /** Fires instead of `onSubmit`/`onError` when the dispatch-mode composer
   *  is submitted with exactly `exit` or `/exit` — closes the view. Never
   *  checked in reply mode; see `EXIT_COMMANDS`. */
  onExit: (() => void) | undefined;
  /**
   * Set by the controller for the duration of reply mode (see
   * `AgentsViewController.onReplyRequest` / `exitReplyMode`). Switches
   * `handleEditorSubmit` from `parseDispatchInput` to `parseReplyInput` —
   * the composer instance is shared between dispatch and reply, so which
   * parser applies has to be a runtime flag, not two separate editors.
   */
  replying = false;

  constructor(
    ui: TUI,
    private readonly workDir: string,
    /** Live skill/plugin-command lookup source for dispatch-mode parsing —
     *  a getter (not a snapshot) so a submission always resolves against
     *  whatever the host has cached as of submit time. */
    private readonly getActivatableCommands: () => DispatchActivatableCommands,
  ) {
    // disablePasteBurst: the burst guard turns Enter-after-rapid-input into a
    // newline — right for the main editor's chat box, wrong here: the
    // dispatch box is a single-task line and scripted input must still
    // submit.
    // frameVariant/promptSymbol/placeholder: the agents-view composer opts
    // into the rule-only chrome (no side borders) — the chat editor keeps
    // its default rounded box.
    this.editor = new CustomEditor(ui, {
      disablePasteBurst: true,
      frameVariant: 'rules',
      promptSymbol: '❯',
      placeholder: DISPATCH_PLACEHOLDER,
    });
    this.editor.onSubmit = (raw) => {
      this.handleEditorSubmit(raw);
    };
  }

  /** Whitelist slash completion; the array is pre-filtered by the caller. */
  installAutocomplete(commands: readonly KimiSlashCommand[]): void {
    const slashCommands: SlashAutocompleteCommand[] = commands.map((command) => {
      const completer = command.completeArgs;
      return {
        name: command.name,
        aliases: command.aliases,
        description: command.description,
        argumentHint: command.argumentHint,
        getArgumentCompletions:
          completer === undefined ? undefined : (prefix: string) => completer(prefix),
      };
    });
    // fdPath null: `@` mentions fall back to the filesystem scanner; the slash
    // whitelist is the point of this provider, path completion rides along.
    this.editor.setAutocompleteProvider(new FileMentionProvider(slashCommands, this.workDir, null));
  }

  private handleEditorSubmit(raw: string): void {
    if (!this.replying && EXIT_COMMANDS.has(raw.trim())) {
      this.onExit?.();
      return;
    }
    const parsed = this.replying
      ? parseReplyInput(raw)
      : parseDispatchInput(raw, this.getActivatableCommands());
    if ('error' in parsed) {
      this.onError?.(parsed.error);
      return;
    }
    this.onSubmit?.(parsed);
  }
}
