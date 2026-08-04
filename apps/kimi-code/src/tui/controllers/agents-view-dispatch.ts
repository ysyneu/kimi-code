/**
 * AgentsViewDispatch — the dispatch editor assembly for the agents view: a
 * CustomEditor instance with a whitelist slash-command autocomplete, plus the
 * submission parser that turns the raw input into a `DispatchSubmission`.
 *
 * The whitelist itself is built controller-side (see `dispatchSlashCommands`
 * in `./agents-view`); this module only accepts the final command array.
 * Model/profile selections are staged on the parsed submission and ride the
 * first prompt's submission body (design §4.5 — the wire create route drops
 * per-session agent config, so createSession never sees them).
 */

import type { TUI } from '@moonshot-ai/pi-tui';

import type { KimiSlashCommand } from '../commands/types';
import { CustomEditor } from '../components/editor/custom-editor';
import {
  FileMentionProvider,
  type SlashAutocompleteCommand,
} from '../components/editor/file-mention-provider';

export interface DispatchSubmission {
  readonly text: string;
  readonly model?: string;
  readonly profile?: string;
}

export type DispatchParseResult = DispatchSubmission | { readonly error: string };

/** Claude's `Too short` floor: at least this many non-space characters. */
const MIN_NON_SPACE_CHARS = 3;

/**
 * Parses raw dispatch input. Plain text becomes the first prompt of a new
 * session; a leading `/model <name>` or `/agent <profile>` stages that
 * override for the first prompt. Any other leading slash command only exists
 * inside a session and is rejected, as is empty / near-empty input.
 */
export function parseDispatchInput(raw: string): DispatchParseResult {
  const trimmed = raw.trim();
  let text = trimmed;
  let model: string | undefined;
  let profile: string | undefined;

  if (trimmed.startsWith('/')) {
    const spaceIndex = trimmed.search(/\s/);
    const command = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
    const rest = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex).trim();
    if (command !== '/model' && command !== '/agent') {
      return { error: `"${command}" is only available inside a session` };
    }
    const argSpaceIndex = rest.search(/\s/);
    const argument = argSpaceIndex === -1 ? rest : rest.slice(0, argSpaceIndex);
    text = argSpaceIndex === -1 ? '' : rest.slice(argSpaceIndex).trim();
    if (command === '/model') model = argument === '' ? undefined : argument;
    else profile = argument === '' ? undefined : argument;
  }

  if (text.replaceAll(/\s/g, '').length < MIN_NON_SPACE_CHARS) {
    return { error: 'Too short — describe the task' };
  }
  return { text, model, profile };
}

/**
 * Owns the dispatch CustomEditor: submits parse through `parseDispatchInput`
 * and fan out to `onSubmit` (parsed submission) or `onError` (rejection
 * message). The editor clears itself on submit (pi-tui behaviour), so every
 * dispatch starts from an empty box.
 */
export class AgentsViewDispatch {
  readonly editor: CustomEditor;
  onSubmit: ((parsed: DispatchSubmission) => void) | undefined;
  onError: ((message: string) => void) | undefined;

  constructor(
    ui: TUI,
    private readonly workDir: string,
  ) {
    // disablePasteBurst: the burst guard turns Enter-after-rapid-input into a
    // newline — right for the main editor's chat box, wrong here: the
    // dispatch box is a single-task line and scripted input must still
    // submit.
    this.editor = new CustomEditor(ui, { disablePasteBurst: true });
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
    const parsed = parseDispatchInput(raw);
    if ('error' in parsed) {
      this.onError?.(parsed.error);
      return;
    }
    this.onSubmit?.(parsed);
  }
}
