import type { Event, KimiHarness, Session, Unsubscribe } from '@moonshot-ai/kimi-code-sdk';
import { SDKRpcClientWire } from '@moonshot-ai/kimi-code-sdk';
import type { Component, ProcessTerminal, TUI } from '@moonshot-ai/pi-tui';

import { AgentsRoster, type AgentsGroup, type AgentsGroupId } from '../agents/roster';
import { loadPins, savePins } from '../agents/roster-persistence';
import { BUILTIN_SLASH_COMMANDS } from '../commands/registry';
import type { KimiSlashCommand } from '../commands/types';
import {
  AgentsViewApp,
  type AgentsViewPeek,
  type AgentsViewProps,
} from '../components/agents-view/app';
import type { CustomEditor } from '../components/editor/custom-editor';
import type { Theme } from '#/tui/theme';

import { AgentsViewDispatch, type DispatchSubmission } from './agents-view-dispatch';

export interface AgentsViewHost {
  readonly state: {
    readonly agentsView: AgentsViewState | undefined;
    readonly theme: Theme;
    readonly terminal: ProcessTerminal;
    readonly ui: TUI;
    readonly editor: CustomEditor;
  };
  readonly harness: KimiHarness;
  showError(msg: string): void;
  showStatus(msg: string): void;
  setAgentsView(value: AgentsViewState | undefined): void;
  /** Header label for the connected kap-server: "embedded" or host:port. */
  agentsViewServerLabel(): string;
  /** Dispatch target: every session created from the view opens in this cwd. */
  agentsViewWorkDir(): string;
  /** Attach seam — injected in M4; without it Enter shows a placeholder. */
  onOpenSession?(id: string): void;
}

export interface AgentsViewState {
  component: AgentsViewApp;
  savedChildren: readonly Component[];
  roster: AgentsRoster;
  /** The same Set the roster mutates in place; persisted after every setPinned. */
  pins: Set<string>;
  dispatch: AgentsViewDispatch;
  selectedId: string | undefined;
  peek: AgentsViewPeek | undefined;
  /** Stale-response guard for async peek loads. */
  peekRequestId: number;
  confirmDeleteId: string | undefined;
  renameDraft: { sessionId: string; text: string } | undefined;
  flashMessage: string | undefined;
  flashTimer: NodeJS.Timeout | undefined;
  collapsedGroups: Set<AgentsGroupId>;
  completedExpanded: boolean;
  eventUnsubscribe: Unsubscribe;
}

/** How many projected text lines a peek keeps from the context tail. */
const PEEK_LINE_LIMIT = 200;

/** The only event types the roster reduces; everything else is dropped here. */
const GLOBAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'session.meta.updated',
  'event.session.work_changed',
  'event.session.created',
]);

/**
 * Dispatch-local `/agent` item: the builtin registry has no profile command
 * (profiles are a `--agent` CLI concept, not an in-session slash command), so
 * the whitelist entry is defined here. Its parse branch lives in
 * `parseDispatchInput`.
 */
const DISPATCH_AGENT_COMMAND: KimiSlashCommand = {
  name: 'agent',
  aliases: [],
  description: 'Run the new session with an agent profile',
  priority: 90,
  argumentHint: '<profile>',
  availability: 'always',
};

/** Builtin commands that make sense outside a session (design §4.5 whitelist). */
const DISPATCH_BUILTIN_WHITELIST: ReadonlySet<string> = new Set(['model', 'help']);

/**
 * The dispatch autocomplete whitelist: `/model` + `/help` filtered out of
 * `BUILTIN_SLASH_COMMANDS` (their copy is not reinvented here) plus the
 * dispatch-local `/agent` item.
 */
export function dispatchSlashCommands(): readonly KimiSlashCommand[] {
  const builtins = BUILTIN_SLASH_COMMANDS.filter((command) =>
    DISPATCH_BUILTIN_WHITELIST.has(command.name),
  );
  return [...builtins, DISPATCH_AGENT_COMMAND];
}

type SessionContext = Awaited<ReturnType<Session['getContext']>>;

/**
 * Projects the context history into plain peek lines: user and assistant text
 * only, newest `maxLines` kept. Tool calls / results are not text-projected
 * this milestone.
 */
export function projectPeekLines(
  history: SessionContext['history'],
  maxLines: number,
): string[] {
  const lines: string[] = [];
  for (const message of history) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    for (const part of message.content) {
      if (part.type !== 'text') continue;
      const [first, ...rest] = part.text.split('\n');
      lines.push((message.role === 'user' ? 'you › ' : '') + (first ?? ''));
      lines.push(...rest);
    }
  }
  return lines.slice(-maxLines);
}

/**
 * Mounts the agents view as a full-screen takeover (same container-swap
 * pattern as TasksBrowserController), owns the roster data flow
 * (listSessions + global event subscription) and every action side effect —
 * the component stays SDK-free.
 *
 * Component contract obligations (see AgentsViewApp's docstring):
 * - While `confirmDeleteId` is set, ANY action callback — including `onQuit`
 *   (Esc during confirm) — clears the confirm instead of acting as a quit.
 * - Esc during rename submits the ORIGINAL title; an unchanged title is a
 *   cancel and never reaches the SDK.
 */
export class AgentsViewController {
  constructor(private readonly host: AgentsViewHost) {}

  get isOpen(): boolean {
    return this.host.state.agentsView !== undefined;
  }

  async show(): Promise<void> {
    const { state } = this.host;
    if (state.agentsView !== undefined) return;

    let pins: Set<string>;
    let summaries: Awaited<ReturnType<KimiHarness['listSessions']>>;
    try {
      [pins, summaries] = await Promise.all([
        loadPins(this.host.harness.homeDir),
        this.host.harness.listSessions({}),
      ]);
    } catch (error) {
      this.host.showError(
        `Failed to load sessions: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (state.agentsView !== undefined) return;

    const roster = new AgentsRoster(pins);
    roster.setAll(summaries);

    const component = new AgentsViewApp(
      this.buildProps({
        roster,
        selectedId: undefined,
        peek: undefined,
        confirmDeleteId: undefined,
        renameDraft: undefined,
        flashMessage: undefined,
        collapsedGroups: new Set(),
        completedExpanded: false,
      }),
      state.terminal,
    );

    const savedChildren = [...state.ui.children];
    state.ui.clear();
    state.ui.addChild(component);
    state.ui.setFocus(component);
    state.ui.requestRender(true);

    const dispatch = new AgentsViewDispatch(state.ui, this.host.agentsViewWorkDir());
    dispatch.installAutocomplete(dispatchSlashCommands());
    dispatch.onSubmit = (submission) => {
      void this.handleDispatch(submission);
    };
    dispatch.onError = (message) => {
      this.flash(message);
    };

    this.host.setAgentsView({
      component,
      savedChildren,
      roster,
      pins,
      dispatch,
      selectedId: undefined,
      peek: undefined,
      peekRequestId: 0,
      confirmDeleteId: undefined,
      renameDraft: undefined,
      flashMessage: undefined,
      flashTimer: undefined,
      collapsedGroups: new Set(),
      completedExpanded: false,
      eventUnsubscribe: this.host.harness.onEvent((event) => {
        this.handleGlobalEvent(event);
      }),
    });
  }

  close(): void {
    const { state } = this.host;
    const view = state.agentsView;
    if (view === undefined) return;
    view.eventUnsubscribe();
    if (view.flashTimer !== undefined) clearTimeout(view.flashTimer);

    state.ui.clear();
    for (const child of view.savedChildren) {
      state.ui.addChild(child);
    }
    this.host.setAgentsView(undefined);
    state.ui.setFocus(state.editor);
    state.ui.requestRender(true);
  }

  /**
   * Peek reply seam: re-attaches, steers and detaches. Nothing calls this yet —
   * the Task-4 dispatch/reply editor wires the peek reply box to it.
   */
  async submitPeekReply(sessionId: string, text: string): Promise<void> {
    const session = await this.host.harness.resumeSession({ id: sessionId });
    try {
      await session.steer(text);
    } finally {
      await session.close();
    }
  }

  // ---------------------------------------------------------------------------

  /**
   * Dispatch flow (design §4.5): create the session in the view's workDir,
   * then send the first prompt. Staged model/profile overrides must ride that
   * first prompt's submission body — the wire create route drops per-session
   * agent config, so they never reach `createSession`. The new roster row
   * arrives on its own via the `event.session.created` subscription.
   */
  private async handleDispatch(submission: DispatchSubmission): Promise<void> {
    const view = this.host.state.agentsView;
    if (view === undefined) return;
    try {
      const session = await this.host.harness.createSession({
        workDir: this.host.agentsViewWorkDir(),
      });
      await this.promptDispatch(session, submission);
    } catch (error) {
      if (this.host.state.agentsView !== view) return;
      this.flash(`Dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async promptDispatch(session: Session, submission: DispatchSubmission): Promise<void> {
    if (submission.model === undefined && submission.profile === undefined) {
      await session.prompt(submission.text);
      return;
    }
    // `Session.prompt` carries no overrides; the extended rpc-level prompt
    // (`WirePromptRpcInput`, M4-T1) does. Reach it through the harness's rpc
    // with an instanceof narrowing — never `any`.
    const rpc = wireRpcOf(this.host.harness);
    if (rpc === undefined) {
      throw new Error('/model and /agent overrides require the wire transport');
    }
    await rpc.prompt({
      sessionId: session.id,
      input: [{ type: 'text', text: submission.text }],
      model: submission.model,
      profile: submission.profile,
    });
  }

  private handleGlobalEvent(event: Event): void {
    const view = this.host.state.agentsView;
    if (view === undefined) return;
    if (!GLOBAL_EVENT_TYPES.has(event.type)) return;
    view.roster.applyEvent(event);
    this.pushProps();
  }

  private buildProps(view: {
    roster: AgentsRoster;
    selectedId: string | undefined;
    peek: AgentsViewPeek | undefined;
    confirmDeleteId: string | undefined;
    renameDraft: { sessionId: string; text: string } | undefined;
    flashMessage: string | undefined;
    collapsedGroups: ReadonlySet<AgentsGroupId>;
    completedExpanded: boolean;
  }): AgentsViewProps {
    const groups = view.roster
      .groups(view.completedExpanded ? Number.MAX_SAFE_INTEGER : undefined)
      .map((group): AgentsGroup => {
        if (!view.collapsedGroups.has(group.id)) return group;
        return { id: group.id, label: group.label, rows: [] };
      });
    return {
      groups,
      counts: view.roster.counts(),
      selectedId: view.selectedId,
      serverLabel: this.host.agentsViewServerLabel(),
      peek: view.peek,
      confirmDeleteId: view.confirmDeleteId,
      renameDraft: view.renameDraft,
      flashMessage: view.flashMessage,
      // The dispatch editor (view.dispatch) is fully wired for submission but
      // not yet mounted into the component's layout — the visual mount
      // (key routing + editor render into the reserved dispatch line) lands
      // with the interactive boot in Task 6. Until then nothing can focus it.
      dispatchFocused: false,
      ...this.buildCallbacks(),
    };
  }

  private pushProps(): void {
    const view = this.host.state.agentsView;
    if (view === undefined) return;
    view.component.setProps(this.buildProps(view));
    this.host.state.ui.requestRender();
  }

  /** Clears a pending delete confirm; returns true when one was pending. */
  private clearConfirm(view: AgentsViewState): boolean {
    if (view.confirmDeleteId === undefined) return false;
    view.confirmDeleteId = undefined;
    return true;
  }

  private buildCallbacks(): Pick<
    AgentsViewProps,
    | 'onSelect'
    | 'onOpen'
    | 'onPeekToggle'
    | 'onDeleteRequest'
    | 'onDeleteConfirm'
    | 'onRenameBegin'
    | 'onRenameSubmit'
    | 'onPinToggle'
    | 'onHelpToggle'
    | 'onQuit'
  > {
    return {
      onSelect: (id) => {
        const view = this.host.state.agentsView;
        if (view === undefined) return;
        view.selectedId = id === '' ? undefined : id;
        if (this.clearConfirm(view)) this.pushProps();
      },
      onOpen: (id) => {
        const view = this.host.state.agentsView;
        if (view === undefined) return;
        this.clearConfirm(view);
        if (id === 'more:completed') {
          view.completedExpanded = true;
          this.pushProps();
          return;
        }
        if (id.startsWith('group:')) {
          const groupId = id.slice('group:'.length) as AgentsGroupId;
          if (view.collapsedGroups.has(groupId)) view.collapsedGroups.delete(groupId);
          else view.collapsedGroups.add(groupId);
          this.pushProps();
          return;
        }
        if (this.host.onOpenSession !== undefined) this.host.onOpenSession(id);
        else this.host.showStatus('Attach lands in M4');
      },
      onPeekToggle: (id) => {
        const view = this.host.state.agentsView;
        if (view === undefined) return;
        this.clearConfirm(view);
        if (view.peek !== undefined && view.peek.sessionId === id) {
          // Closing is free: the wire attach was already detached on load.
          view.peek = undefined;
          view.peekRequestId += 1;
          this.pushProps();
          return;
        }
        void this.openPeek(id);
      },
      onDeleteRequest: (id) => {
        const view = this.host.state.agentsView;
        if (view === undefined) return;
        view.confirmDeleteId = id;
        this.pushProps();
      },
      onDeleteConfirm: (id) => {
        const view = this.host.state.agentsView;
        if (view === undefined) return;
        view.confirmDeleteId = undefined;
        this.pushProps();
        void this.handleDelete(id);
      },
      onRenameBegin: (id) => {
        const view = this.host.state.agentsView;
        if (view === undefined) return;
        this.clearConfirm(view);
        const row = view.roster.get(id);
        if (row === undefined) return;
        view.renameDraft = { sessionId: id, text: row.title };
        this.pushProps();
      },
      onRenameSubmit: (id, text) => {
        const view = this.host.state.agentsView;
        if (view === undefined) return;
        this.clearConfirm(view);
        view.renameDraft = undefined;
        const row = view.roster.get(id);
        // Esc-cancel resubmits the original title: unchanged = cancel.
        if (row === undefined || text === row.title || text.trim() === '') {
          this.pushProps();
          return;
        }
        void this.handleRename(id, row.title, text);
      },
      onPinToggle: (id) => {
        const view = this.host.state.agentsView;
        if (view === undefined) return;
        this.clearConfirm(view);
        void this.handlePinToggle(id);
      },
      onHelpToggle: () => {
        const view = this.host.state.agentsView;
        if (view === undefined) return;
        if (this.clearConfirm(view)) this.pushProps();
      },
      onQuit: () => {
        const view = this.host.state.agentsView;
        if (view === undefined) return;
        // Esc during delete-confirm cancels the confirm, not the view.
        if (this.clearConfirm(view)) {
          this.pushProps();
          return;
        }
        this.close();
      },
    };
  }

  private async openPeek(id: string): Promise<void> {
    const view = this.host.state.agentsView;
    if (view === undefined) return;
    const requestId = (view.peekRequestId += 1);
    view.peek = { sessionId: id, lines: [], replyDraft: '' };
    this.pushProps();

    let lines: string[];
    try {
      const session = await this.host.harness.resumeSession({ id });
      try {
        const context = await session.getContext();
        lines = projectPeekLines(context.history, PEEK_LINE_LIMIT);
      } finally {
        // wire transport: close() is a local detach — the server-side
        // session keeps running.
        await session.close();
      }
    } catch (error) {
      const current = this.host.state.agentsView;
      if (current !== view || current.peekRequestId !== requestId) return;
      current.peek = undefined;
      this.flash(`Peek failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const current = this.host.state.agentsView;
    if (current !== view || current.peekRequestId !== requestId) return;
    if (current.peek?.sessionId !== id) return;
    current.peek = { sessionId: id, lines, replyDraft: '' };
    this.pushProps();
  }

  private async handleDelete(id: string): Promise<void> {
    const view = this.host.state.agentsView;
    if (view === undefined) return;

    const ids: readonly string[] = id.startsWith('group:')
      ? (view.roster
          .groups(Number.MAX_SAFE_INTEGER)
          .find((group) => group.id === id.slice('group:'.length))
          ?.rows.map((row) => row.id) ?? [])
      : [id];
    if (ids.length === 0) return;

    let failed = 0;
    for (const sessionId of ids) {
      try {
        await this.host.harness.deleteSession(sessionId);
        view.roster.remove(sessionId);
        if (view.selectedId === sessionId) view.selectedId = undefined;
        if (view.peek?.sessionId === sessionId) view.peek = undefined;
      } catch {
        failed += 1;
      }
      if (this.host.state.agentsView !== view) return;
      this.pushProps();
    }
    if (failed > 0) {
      this.flash(`Failed to archive ${String(failed)} of ${String(ids.length)} session(s)`);
    } else if (ids.length > 1) {
      this.flash(`Archived ${String(ids.length)} sessions`);
    }
  }

  private async handleRename(id: string, previousTitle: string, title: string): Promise<void> {
    const view = this.host.state.agentsView;
    if (view === undefined) return;
    view.roster.setTitle(id, title);
    this.pushProps();
    try {
      await this.host.harness.renameSession({ id, title });
    } catch (error) {
      if (this.host.state.agentsView !== view) return;
      view.roster.setTitle(id, previousTitle);
      this.host.showError(
        `Rename failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.pushProps();
    }
  }

  private async handlePinToggle(id: string): Promise<void> {
    const view = this.host.state.agentsView;
    if (view === undefined) return;
    const row = view.roster.get(id);
    if (row === undefined) return;
    view.roster.setPinned(id, !row.pinned);
    this.pushProps();
    try {
      // The roster mutates this same Set in place; persist it as-is.
      await savePins(this.host.harness.homeDir, view.pins);
    } catch (error) {
      if (this.host.state.agentsView !== view) return;
      this.flash(
        `Failed to persist pins: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private flash(message: string, durationMs = 2500): void {
    const view = this.host.state.agentsView;
    if (view === undefined) return;
    if (view.flashTimer !== undefined) clearTimeout(view.flashTimer);
    view.flashMessage = message;
    view.flashTimer = setTimeout(() => {
      const current = this.host.state.agentsView;
      if (current !== view) return;
      current.flashMessage = undefined;
      current.flashTimer = undefined;
      this.pushProps();
    }, durationMs);
    this.pushProps();
  }
}

/**
 * Type narrowing onto the harness's rpc: the agents view only runs on the
 * wire transport, whose rpc exposes the extended prompt input (model/profile
 * overrides). Returns undefined for any other transport — callers must treat
 * that as "wire-only feature unavailable", never fall back to `any`.
 */
function wireRpcOf(harness: KimiHarness): SDKRpcClientWire | undefined {
  // The double cast pierces the private modifier only; the runtime field is
  // then checked with instanceof before any use.
  const rpc: unknown = (harness as unknown as { readonly rpc?: unknown }).rpc;
  return rpc instanceof SDKRpcClientWire ? rpc : undefined;
}
