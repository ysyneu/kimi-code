import type { Event, KimiHarness, Unsubscribe, WireSession } from '@moonshot-ai/kimi-code-sdk';
import type { Component, Container, ProcessTerminal, TUI } from '@moonshot-ai/pi-tui';

import { AgentsRoster, type AgentsGroup, type AgentsGroupId } from '../agents/roster';
import { loadAgentsViewState, saveAgentsViewState } from '../agents/roster-persistence';
import { BUILTIN_SLASH_COMMANDS } from '../commands/registry';
import type { KimiSlashCommand } from '../commands/types';
import { AgentsViewApp, type AgentsViewProps } from '../components/agents-view/app';
import { rosterRowName } from '../components/agents-view/rows';
import type { CustomEditor } from '../components/editor/custom-editor';
import type { Theme } from '#/tui/theme';

import { AgentsViewDispatch, DISPATCH_PLACEHOLDER, type DispatchSubmission } from './agents-view-dispatch';

export interface AgentsViewHost {
  readonly state: {
    readonly agentsView: AgentsViewState | undefined;
    readonly theme: Theme;
    readonly terminal: ProcessTerminal;
    readonly ui: TUI;
    readonly editor: CustomEditor;
    readonly editorContainer: Container;
  };
  readonly harness: KimiHarness;
  showError(msg: string): void;
  showStatus(msg: string): void;
  setAgentsView(value: AgentsViewState | undefined): void;
  /** Header label for the connected kap-server: "embedded" or host:port. */
  agentsViewServerLabel(): string;
  /** Dispatch target: every session created from the view opens in this cwd. */
  agentsViewWorkDir(): string;
  /** Header label for the model new sessions dispatch with by default. */
  agentsViewModelLabel(): string;
  /**
   * Attach-mode footer badge feed: live roster counts while
   * detached; `undefined` clears the badge (return / close).
   */
  setAttachBadge(counts: { agents: number; awaiting: number } | undefined): void;
  /**
   * The currently attached session id ('' when none). The attach badge
   * excludes it — the session on screen is not "other agents" news.
   */
  getCurrentSessionId(): string;
  /** Attach seam: the host implements it; without it Enter shows a status hint. */
  onOpenSession?(id: string): void;
  /**
   * Mounts any reverse-RPC panels (approval/question) deferred while the
   * view takeover was on screen. The controller calls it when the user
   * leaves the view for the chat that owns the pending interaction —
   * detachForAttach (only when the attached session IS the current one) and
   * close(). Without it deferred panels never surface.
   */
  flushDeferredPanels?(): void;
}

export interface AgentsViewState {
  component: AgentsViewApp;
  savedChildren: readonly Component[];
  roster: AgentsRoster;
  /** The same Set the roster mutates in place; persisted after every setPinned. */
  pins: Set<string>;
  /**
   * The view's roster scope: only sessions the view created (dispatch) or
   * attached to (Enter on a row) are listed — the server-wide session list
   * from other clients (kimi-web, other terminals) is filtered out at seed,
   * refresh and `event.session.created`. Persisted with the pins after
   * every mutation.
   */
  viewSessions: Set<string>;
  /** The same Map the roster mutates in place via `markSeen`; persisted alongside pins. */
  seenAt: Map<string, number>;
  dispatch: AgentsViewDispatch;
  /**
   * True while the user is attached to a session: the component is unmounted
   * but the roster and its event subscription stay alive — the attached-mode
   * footer badge reads live counts, and show() remounts the same
   * component without a reload.
   */
  detached: boolean;
  /**
   * One-time-per-attach flag for the deferred-permission hint: the
   * wire transport carries a stashed setPermission on the NEXT prompt, so the
   * first user-initiated mode change per attach earns a status hint. Reset by
   * detachForAttach. Read via {@link hintDeferredPermissionOnce}.
   */
  permissionHintShown: boolean;
  /** Focus split between the roster list and the dispatch editor. */
  dispatchFocused: boolean;
  /**
   * Set while the composer targets an EXISTING session (space on a row)
   * instead of a new one. Always paired with `dispatchFocused === true` —
   * entering and leaving reply mode toggles both together (see
   * `onReplyRequest` and `exitReplyMode`) so the component never has to
   * reconcile a composer that's "replying" but unfocused.
   */
  replyTargetId: string | undefined;
  selectedId: string | undefined;
  confirmDeleteId: string | undefined;
  renameDraft: { sessionId: string; text: string } | undefined;
  flashMessage: string | undefined;
  flashTimer: NodeJS.Timeout | undefined;
  /**
   * Render ticker while any row is busy: roster events are rare (busy on /
   * busy off), so without a periodic re-render the working spinner freezes
   * on one frame for the whole turn. Runs only while the component is
   * mounted (stopped on detach / close / when nothing is busy).
   */
  busyTicker: NodeJS.Timeout | undefined;
  collapsedGroups: Set<AgentsGroupId>;
  completedExpanded: boolean;
  eventUnsubscribe: Unsubscribe;
  /** WS connection-state subscription (wire transport only) — drives the
   *  post-reconnect roster reconciliation. Dies with the view on close(). */
  connectionUnsubscribe: Unsubscribe | undefined;
}

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

/** Builtin commands that make sense outside a session. */
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
    const existing = state.agentsView;
    if (existing !== undefined) {
      // Return from attach: remount the same component over the live roster —
      // the subscription kept it current, so there is nothing to reload.
      if (existing.detached) this.remount(existing);
      return;
    }

    // The wire transport seeds from the full session rows — busy /
    // pending_interaction survive the mapping (I1). Any other transport
    // falls back to the plain SessionSummary list. Both are then narrowed to
    // the view's own registry: sessions dispatched from or attached through
    // this view, never the whole server-wide list.
    const rpc = this.host.harness.wireRpc();
    let persisted: Awaited<ReturnType<typeof loadAgentsViewState>>;
    let summaries: Awaited<ReturnType<KimiHarness['listSessions']>> | undefined;
    let wireRows: readonly WireSession[] | undefined;
    try {
      [persisted, summaries, wireRows] = await Promise.all([
        loadAgentsViewState(this.host.harness.homeDir),
        rpc === undefined ? this.host.harness.listSessions({}) : Promise.resolve(undefined),
        rpc?.listSessionRows() ?? Promise.resolve(undefined),
      ]);
    } catch (error) {
      this.host.showError(
        `Failed to load sessions: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (state.agentsView !== undefined) return;
    const { pins, sessions: viewSessions, seenAt } = persisted;

    const roster = new AgentsRoster(pins, seenAt);
    if (wireRows !== undefined) roster.setAllRows(wireRows.filter((row) => viewSessions.has(row.id)));
    else if (summaries !== undefined) roster.setAll(summaries.filter((row) => viewSessions.has(row.id)));

    // The dispatch editor is built before the component: it renders into the
    // component's bottom box, so the initial props already reference it.
    const dispatch = new AgentsViewDispatch(state.ui, this.host.agentsViewWorkDir());
    dispatch.installAutocomplete(dispatchSlashCommands());

    const component = new AgentsViewApp(
      this.buildProps({
        roster,
        dispatch,
        dispatchFocused: false,
        replyTargetId: undefined,
        selectedId: undefined,
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

    dispatch.onSubmit = (submission) => {
      const view = this.host.state.agentsView;
      const replyTarget = view?.replyTargetId;
      if (view !== undefined) this.exitReplyMode(view);
      this.unfocusDispatch();
      if (view !== undefined && replyTarget !== undefined) {
        void this.handleReply(view, replyTarget, submission.text);
        return;
      }
      void this.handleDispatch(submission);
    };
    dispatch.onError = (message) => {
      const view = this.host.state.agentsView;
      if (view !== undefined) this.exitReplyMode(view);
      this.unfocusDispatch();
      this.flash(message);
    };
    // Esc inside the focused editor returns focus to the list (the editor's
    // own autocomplete-cancel wins over this when a dropdown is open).
    // Reply mode is exited the same way as a submit: back to the "new
    // session" composer, not a second escape stage.
    dispatch.editor.onEscape = () => {
      const view = this.host.state.agentsView;
      if (view !== undefined) this.exitReplyMode(view);
      this.unfocusDispatch();
    };

    this.host.setAgentsView({
      component,
      savedChildren,
      roster,
      pins,
      viewSessions,
      seenAt,
      dispatch,
      detached: false,
      permissionHintShown: false,
      dispatchFocused: false,
      replyTargetId: undefined,
      selectedId: undefined,
      confirmDeleteId: undefined,
      renameDraft: undefined,
      flashMessage: undefined,
      flashTimer: undefined,
      busyTicker: undefined,
      collapsedGroups: new Set(),
      completedExpanded: false,
      eventUnsubscribe: this.host.harness.onEvent((event) => {
        this.handleGlobalEvent(event);
      }),
      connectionUnsubscribe: rpc?.onConnectionState((connected) => {
        // Global fan-out events have no journal: whatever changed during a
        // drop is lost, so a reconnect re-seeds the whole roster (I2). The
        // initial connect predates this handler — only reconnects fire it.
        if (connected) void this.refreshRoster();
      }),
    });

    // Trust badges load after mount: the roster is already useful without
    // them, and the per-row reads must never block or break show().
    void this.loadTrust((wireRows ?? summaries ?? []).map((row) => row.id));
    // A seeded busy row must start the spinner ticker without waiting for an event.
    this.syncBusyTicker();
  }

  close(): void {
    const { state } = this.host;
    const view = state.agentsView;
    if (view === undefined || view.detached) {
      // Detached (attached to a session): the roster subscription deliberately
      // survives — switchToSession's runtime reset calls close() on the
      // attach path, and tearing down here would kill the badge's data feed.
      return;
    }
    view.eventUnsubscribe();
    view.connectionUnsubscribe?.();
    if (view.flashTimer !== undefined) clearTimeout(view.flashTimer);
    if (view.busyTicker !== undefined) clearInterval(view.busyTicker);
    this.host.setAttachBadge(undefined);

    state.ui.clear();
    for (const child of view.savedChildren) {
      state.ui.addChild(child);
    }
    this.host.setAgentsView(undefined);
    state.ui.setFocus(state.editorContainer.children[0] ?? state.editor);
    state.ui.requestRender(true);
    // Panels deferred while the takeover was up mount now — the user is back
    // in the chat that owns the pending interaction.
    this.host.flushDeferredPanels?.();
  }

  /**
   * Attach detach: unmounts the component but keeps the roster and its global
   * event subscription alive (see {@link AgentsViewState.detached}). The user
   * returns via the Task-4 key, which re-runs show().
   *
   * `sessionId` is the session being attached — the seeded badge excludes it.
   * It must be passed in: at this point `appState.sessionId` still holds the
   * PREVIOUS session (switchToSession runs after the detach), so reading the
   * current id here would seed the badge with the wrong exclusion.
   */
  detachForAttach(sessionId: string): void {
    const { state } = this.host;
    const view = state.agentsView;
    if (view === undefined || view.detached) return;
    view.detached = true;
    // Each attach re-arms the one-time deferred-permission hint.
    view.permissionHintShown = false;
    if (view.flashTimer !== undefined) {
      clearTimeout(view.flashTimer);
      view.flashTimer = undefined;
      view.flashMessage = undefined;
    }
    // The spinner only animates on screen — the attach badge shows counts,
    // not frames, so the ticker stops until remount.
    if (view.busyTicker !== undefined) {
      clearInterval(view.busyTicker);
      view.busyTicker = undefined;
    }

    state.ui.clear();
    for (const child of view.savedChildren) {
      state.ui.addChild(child);
    }
    // Focus whatever occupies the editor slot: when a reverse-RPC panel is
    // mounted there the editor is off-tree, and focusing it would leave the
    // restored panel visible but keyboard-dead.
    state.ui.setFocus(state.editorContainer.children[0] ?? state.editor);
    state.ui.requestRender(true);
    // Seed the attach-mode footer badge with the current roster counts.
    this.pushAttachBadge(view, sessionId);
    // Pending approvals/questions belong to the CURRENT session (handlers
    // are per-session), so only an attach into that session surfaces what
    // the view deferred. Attaching into a DIFFERENT session must not pop
    // this session's panel into the wrong chat — those entries stay
    // deferred until the switch's unload cancels them (the same cancel
    // semantics as any session switch with a pending approval).
    if (sessionId === this.host.getCurrentSessionId()) this.host.flushDeferredPanels?.();
  }

  /** Return-from-attach remount: same component, same roster, no reload. */
  private remount(view: AgentsViewState): void {
    const { state } = this.host;
    view.detached = false;
    view.savedChildren = [...state.ui.children];
    state.ui.clear();
    state.ui.addChild(view.component);
    state.ui.setFocus(view.component);
    this.pushProps();
    // Back on the view: its own rows show the counts — the badge goes away.
    this.host.setAttachBadge(undefined);
    // Busy rows kept working while attached — resume the spinner heartbeat.
    this.syncBusyTicker();
    state.ui.requestRender(true);
  }

  // ---------------------------------------------------------------------------

  /**
   * One-shot trust read at roster load (no live refresh): the
   * wire transport resolves each row's workspace trust and the badge rides
   * `roster.setTrusted`. A per-row failure leaves `trusted` undefined — no
   * badge, no error surface; non-wire transports have no trust route and are
   * skipped by the narrowing.
   */
  private async loadTrust(ids: readonly string[]): Promise<void> {
    const view = this.host.state.agentsView;
    if (view === undefined) return;
    const rpc = this.host.harness.wireRpc();
    if (rpc === undefined) return;
    let changed = false;
    await Promise.all(
      ids.map(async (id) => {
        // Archived sessions never entered the roster; setTrusted would no-op.
        if (view.roster.get(id) === undefined) return;
        let trusted: boolean | undefined;
        try {
          trusted = await rpc.getWorkspaceTrustForSession(id);
        } catch {
          return;
        }
        if (this.host.state.agentsView !== view) return;
        view.roster.setTrusted(id, trusted);
        changed = true;
      }),
    );
    if (changed && this.host.state.agentsView === view) this.pushProps();
  }

  /**
   * WS reconnect reconciliation (I2): global fan-out events have no journal,
   * so whatever changed during the drop is re-seeded from a fresh session
   * list. A failed re-list keeps the last known roster — the next reconnect
   * retries.
   */
  private async refreshRoster(): Promise<void> {
    const view = this.host.state.agentsView;
    if (view === undefined) return;
    const rpc = this.host.harness.wireRpc();
    if (rpc === undefined) return;
    let rows: readonly WireSession[];
    try {
      rows = await rpc.listSessionRows();
    } catch {
      return;
    }
    if (this.host.state.agentsView !== view) return;
    view.roster.setAllRows(rows.filter((row) => view.viewSessions.has(row.id)));
    // A session that vanished during the drop must not leave a dangling
    // selection behind.
    if (view.selectedId !== undefined && view.roster.get(view.selectedId) === undefined) {
      view.selectedId = undefined;
    }
    this.syncBusyTicker();
    this.pushProps();
    // The attach badge reads the same roster while detached — keep it honest.
    if (view.detached) this.pushAttachBadge(view, this.host.getCurrentSessionId());
  }

  /**
   * Dispatch flow: create the session in the view's workDir,
   * then send the first prompt. Staged model/profile overrides must ride that
   * first prompt's submission body — the wire create route drops per-session
   * agent config, so they never reach `createSession`. The new roster row
   * arrives on its own via the `event.session.created` subscription.
   */
  private async handleDispatch(submission: DispatchSubmission): Promise<void> {
    const view = this.host.state.agentsView;
    if (view === undefined) return;
    // Validate before mutate: `Session.prompt` carries no overrides — the
    // extended rpc-level prompt (`WirePromptRpcInput`) does, reached
    // through the harness's rpc with an instanceof narrowing (never `any`).
    // A transport that can't carry the overrides is rejected HERE, before
    // createSession, so the failure can't orphan a server-side session.
    const hasOverrides = submission.model !== undefined || submission.profile !== undefined;
    const rpc = hasOverrides ? this.host.harness.wireRpc() : undefined;
    if (hasOverrides && rpc === undefined) {
      this.flash('Dispatch failed: /model and /agent overrides require the wire transport');
      return;
    }
    try {
      const session = await this.host.harness.createSession({
        workDir: this.host.agentsViewWorkDir(),
      });
      // Register BEFORE the first prompt: the server's
      // `event.session.created` echo only enters the roster when the id is
      // already in the view's registry. The new row is pre-selected so the
      // dispatch is visibly confirmed the moment it lands.
      view.viewSessions.add(session.id);
      void this.persistState(view);
      view.selectedId = session.id;
      this.pushProps();
      if (rpc !== undefined) {
        await rpc.prompt({
          sessionId: session.id,
          input: [{ type: 'text', text: submission.text }],
          model: submission.model,
          profile: submission.profile,
        });
      } else {
        await session.prompt(submission.text);
      }
    } catch (error) {
      if (this.host.state.agentsView !== view) return;
      this.flash(`Dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Reply flow (space on a row): prompts an EXISTING session directly
   * through the wire rpc — the same primitive `handleDispatch`'s override
   * branch already uses for model/profile, minus the overrides and minus
   * creating anything. Wire-only, same restriction as those overrides: a
   * background reply from the roster has no client-side `Session` object
   * to fall back to (the target row may never have been resumed in this
   * process — it could be listed straight from a persisted summary).
   */
  private async handleReply(view: AgentsViewState, targetId: string, text: string): Promise<void> {
    const rpc = this.host.harness.wireRpc();
    if (rpc === undefined) {
      this.flash('Reply failed: replying from the list requires the wire transport');
      return;
    }
    try {
      await rpc.prompt({ sessionId: targetId, input: [{ type: 'text', text }] });
    } catch (error) {
      if (this.host.state.agentsView !== view) return;
      this.flash(`Reply failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Clears reply-mode state (placeholder + `replyTargetId` + the dispatch's
   * `replying` parse-mode flag) — called on every editor submit round trip
   * (success or parse-error) and on Esc. Reply is the same composer as
   * dispatch; only its momentary target, placeholder and input parsing
   * differ, so "leaving reply mode" is just resetting those back to the
   * dispatch defaults.
   */
  private exitReplyMode(view: AgentsViewState): void {
    if (view.replyTargetId === undefined) return;
    view.replyTargetId = undefined;
    view.dispatch.replying = false;
    view.dispatch.editor.setPlaceholder(DISPATCH_PLACEHOLDER);
  }

  private handleGlobalEvent(event: Event): void {
    const view = this.host.state.agentsView;
    if (view === undefined) return;
    if (!GLOBAL_EVENT_TYPES.has(event.type)) return;
    // A session the view never touched never enters the roster: server-wide
    // `event.session.created` fan-outs from other clients (kimi-web, other
    // terminals) are dropped at the registry gate.
    if (event.type === 'event.session.created' && !view.viewSessions.has(event.session.id)) {
      return;
    }
    view.roster.applyEvent(event);
    this.syncBusyTicker();
    this.pushProps();
    // While attached the component is unmounted, but the footer badge still
    // reads live roster counts (the subscription survived the detach).
    if (view.detached) this.pushAttachBadge(view, this.host.getCurrentSessionId());
  }

  /** Pushes the live roster counts to the attach-mode footer badge. */
  private pushAttachBadge(view: AgentsViewState, excludeId: string): void {
    const counts = view.roster.counts(excludeId);
    this.host.setAttachBadge({ agents: counts.working, awaiting: counts.awaiting });
  }

  private buildProps(view: {
    roster: AgentsRoster;
    dispatch: AgentsViewDispatch;
    dispatchFocused: boolean;
    replyTargetId: string | undefined;
    selectedId: string | undefined;
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
      modelLabel: this.host.agentsViewModelLabel(),
      confirmDeleteId: view.confirmDeleteId,
      renameDraft: view.renameDraft,
      flashMessage: view.flashMessage,
      dispatchFocused: view.dispatchFocused,
      dispatchEditor: view.dispatch.editor,
      replyTargetId: view.replyTargetId,
      ...this.buildCallbacks(),
    };
  }

  /** Returns focus from the dispatch editor to the roster list. */
  private unfocusDispatch(): void {
    const view = this.host.state.agentsView;
    if (view === undefined || !view.dispatchFocused) return;
    view.dispatchFocused = false;
    view.dispatch.editor.focused = false;
    this.pushProps();
  }

  private pushProps(): void {
    const view = this.host.state.agentsView;
    if (view === undefined || view.detached) return;
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
    | 'onDeleteRequest'
    | 'onDeleteConfirm'
    | 'onRenameBegin'
    | 'onRenameSubmit'
    | 'onPinToggle'
    | 'onReplyRequest'
    | 'onReorderPinned'
    | 'onHelpToggle'
    | 'onQuit'
    | 'onDispatchFocusChange'
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
        if (this.host.onOpenSession !== undefined) {
          // Attaching a row reaffirms its registry membership (in practice it
          // is already registered — the roster only lists registry rows).
          view.viewSessions.add(id);
          // Opening a row is the only thing that clears its unseen bit.
          view.roster.markSeen(id);
          void this.persistState(view);
          this.host.onOpenSession(id);
        } else {
          this.host.showStatus('Attach is not available from this host');
        }
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
      onReplyRequest: (id) => {
        const view = this.host.state.agentsView;
        if (view === undefined) return;
        this.clearConfirm(view);
        const row = view.roster.get(id);
        if (row === undefined) return;
        view.replyTargetId = id;
        view.dispatch.replying = true;
        view.dispatchFocused = true;
        view.dispatch.editor.focused = true;
        view.dispatch.editor.setPlaceholder(`reply to ${rosterRowName(row)}`);
        this.pushProps();
      },
      onReorderPinned: (id, delta) => {
        const view = this.host.state.agentsView;
        if (view === undefined) return;
        this.clearConfirm(view);
        view.roster.reorderPinned(id, delta);
        this.pushProps();
        void this.persistState(view);
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
      onDispatchFocusChange: (focused) => {
        const view = this.host.state.agentsView;
        if (view === undefined || view.dispatchFocused === focused) return;
        view.dispatchFocused = focused;
        view.dispatch.editor.focused = focused;
        this.pushProps();
      },
    };
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
    let removed = 0;
    for (const sessionId of ids) {
      try {
        await this.host.harness.deleteSession(sessionId);
        view.roster.remove(sessionId);
        view.viewSessions.delete(sessionId);
        removed += 1;
        if (view.selectedId === sessionId) view.selectedId = undefined;
      } catch {
        failed += 1;
      }
      if (this.host.state.agentsView !== view) return;
      this.pushProps();
    }
    if (removed > 0) void this.persistState(view);
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
    // The roster mutates the pins Set in place; persist the whole view state.
    await this.persistState(view);
  }

  /**
   * Serializes state writes: tmp-write + rename must land in call order and
   * never overlap — a slow earlier write renaming after a later one would
   * persist stale pins/registry. The chain also coalesces bursts: each write
   * snapshots the (mutated-in-place) sets when it runs, not when it was
   * scheduled.
   */
  private persistChain: Promise<void> = Promise.resolve();

  /** Persist pins + registry atomically; failures flash, never throw. */
  private persistState(view: AgentsViewState): Promise<void> {
    this.persistChain = this.persistChain.then(async () => {
      try {
        await saveAgentsViewState(this.host.harness.homeDir, {
          pins: view.pins,
          sessions: view.viewSessions,
          seenAt: view.seenAt,
        });
      } catch (error) {
        if (this.host.state.agentsView !== view) return;
        this.flash(
          `Failed to persist agents view state: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    return this.persistChain;
  }

  /**
   * Spinner heartbeat: roster events are rare (busy on / busy off), so while
   * any row is working a 400 ms re-render keeps the spinner animating. Runs
   * only while the component is mounted; detach / close / an idle roster
   * stops it.
   */
  private syncBusyTicker(): void {
    const view = this.host.state.agentsView;
    if (view === undefined) return;
    const anyBusy = view.roster.counts().working > 0;
    if (anyBusy && !view.detached && view.busyTicker === undefined) {
      view.busyTicker = setInterval(() => {
        const current = this.host.state.agentsView;
        // close() cleared the interval alongside the state — nothing to do.
        if (current !== view) return;
        if (view.detached || view.roster.counts().working === 0) {
          this.syncBusyTicker();
          return;
        }
        this.pushProps();
      }, 400);
      // A render heartbeat must never hold the event loop open on its own.
      view.busyTicker.unref();
    } else if ((!anyBusy || view.detached) && view.busyTicker !== undefined) {
      clearInterval(view.busyTicker);
      view.busyTicker = undefined;
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
 * Deferred-permission hint: on the wire transport setPermission is
 * stashed and rides the NEXT prompt's submission body, so the first
 * user-initiated permission-mode change per attach earns a one-time status
 * hint. The per-attach flag lives on {@link AgentsViewState.permissionHintShown}
 * (reset by detachForAttach). `detached` is the "attached to a session"
 * marker — `isOpen` stays true while detached, so mount
 * checks must look at `detached`, not at the state's presence.
 */
export function hintDeferredPermissionOnce(host: {
  readonly state: { readonly agentsView: AgentsViewState | undefined };
  showStatus(msg: string): void;
}): void {
  const view = host.state.agentsView;
  if (view === undefined || !view.detached || view.permissionHintShown) return;
  view.permissionHintShown = true;
  host.showStatus('Permission mode applies to the next prompt.');
}
