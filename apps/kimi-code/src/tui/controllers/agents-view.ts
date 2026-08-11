import { randomUUID } from 'node:crypto';

import { parseIntegerEnv } from '@moonshot-ai/agent-core-v2';
import type { Event, KimiHarness, PromptPart, Unsubscribe, WireSession } from '@moonshot-ai/kimi-code-sdk';
import type { Component, Container, ProcessTerminal, TUI } from '@moonshot-ai/pi-tui';

import { AgentsRoster, type AgentsGroup, type AgentsRosterRow } from '../agents/roster';
import { loadAgentsViewState, saveAgentsViewState } from '../agents/roster-persistence';
import { completeLeadingArg, type ArgCompletionSpec } from '../commands/complete-args';
import { BUILTIN_SLASH_COMMANDS } from '../commands/registry';
import type { KimiSlashCommand } from '../commands/types';
import { AgentsViewApp, type AgentsViewProps } from '../components/agents-view/app';
import { rosterRowName, SPINNER_FRAME_MS } from '../components/agents-view/rows';
import type { CustomEditor } from '../components/editor/custom-editor';
import { pasteClipboardImage } from '../media/clipboard-paste';
import type { ImageAttachmentStore } from '../utils/image-attachment-store';
import {
  extractMediaAttachments,
  rewriteMediaPlaceholders,
  type MediaReferenceStyle,
} from '../utils/image-placeholder';
import { DELETE_ARM_WINDOW_MS, EXIT_CONFIRM_WINDOW_MS } from '#/tui/constant/kimi-tui';
import type { Theme } from '#/tui/theme';

import {
  AgentsViewDispatch,
  DISPATCH_PLACEHOLDER,
  type DispatchActivatableCommands,
  type DispatchSubmission,
} from './agents-view-dispatch';
import { buildDirectoryGroups, type AgentsGroupMode } from './agents-view-groups';

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
  /** Telemetry — same signature as `EditorKeyboardHost.track`, so both
   *  composers' clipboard-paste wiring (`pasteClipboardImage`) forward it
   *  identically. */
  track(event: string, properties?: Record<string, unknown>): void;
  setAgentsView(value: AgentsViewState | undefined): void;
  /** Header label for the connected kap-server: "embedded" or host:port. */
  agentsViewServerLabel(): string;
  /**
   * I6: true when closing the agents-view process leaves its sessions
   * running server-side — false only in embedded mode, where quitting the
   * CLI also ends the embedded server and interrupts whatever was in
   * flight. Read once per `buildProps` call, same "read once, no I/O on
   * the read path" footing as `agentsViewServerLabel`/`agentsViewWorkDir`.
   * Drives the two mode-aware roster strings (Ctrl+C armed footer,
   * empty-skeleton Working-band description) — the exit-confirm modal's
   * own copy is already correct and untouched by this.
   */
  agentsViewSessionsSurviveExit(): boolean;
  /** Dispatch target: every session created from the view opens in this cwd. */
  agentsViewWorkDir(): string;
  /**
   * Initial roster grouping mode for a fresh `show()` mount — read from the
   * host's already-loaded startup config (same "read once, keep in memory"
   * footing as `agentsViewServerLabel`/`agentsViewWorkDir` above: no disk I/O
   * on the read path). Ctrl+S (`AgentsViewProps.onGroupModeToggle`) cycles it
   * thereafter and {@link saveAgentsViewGroupMode} persists the change back
   * (and updates what this getter returns for the next `show()`).
   */
  agentsViewGroupMode(): AgentsGroupMode;
  /** Persists a Ctrl+S grouping-mode change. Rejections propagate to the
   *  controller's own flash (same contract as `saveAgentsViewState`). */
  saveAgentsViewGroupMode(mode: AgentsGroupMode): Promise<void>;
  /** Header label for the model new sessions dispatch with by default. */
  agentsViewModelLabel(): string;
  /**
   * `/model` argument completion candidates for the dispatch composer: every
   * configured alias with its display label, same source and
   * secondary-derived-alias exclusion as the chat's model picker.
   */
  agentsViewModelCompletions(): readonly ArgCompletionSpec[];
  /**
   * Skill + plugin-command entries and their activation maps for the
   * dispatch composer's staged-activation category — same source and shape
   * the main chat's own `/` menu uses, reused as-is (see `KimiTUI.
   * agentsViewActivatableCommands`).
   */
  agentsViewActivatableCommands(): DispatchActivatableCommands;
  /**
   * Fills the skill half of `agentsViewActivatableCommands`'s cold-start
   * gap (no session attached this run yet) via whatever session-independent
   * route the host has for it — the controller calls this once at view
   * mount and re-reads `agentsViewActivatableCommands()` when it resolves;
   * it never inspects this method's return value. No plugin-command
   * equivalent exists to warm the same way (see `KimiTUI.
   * warmAgentsViewSkillMenu`'s doc comment), so the plugin half of the gap
   * is unaffected by this call.
   */
  warmAgentsViewSkillMenu(): Promise<void>;
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
  /** Focus split between the roster list and the dispatch editor. */
  dispatchFocused: boolean;
  /**
   * Set while the composer targets an EXISTING session (space on a row)
   * instead of a new one — this is also the reply PANEL's own open flag
   * (`AgentsViewApp` renders the bordered preview panel instead of the
   * plain composer whenever it's set; see `renderReplyPanel`). Always
   * paired with `dispatchFocused === true` — entering and leaving the panel
   * toggles both together (see `onReplyRequest` and `closeReplyPanel`) so
   * the component never has to reconcile a composer that's "replying" but
   * unfocused.
   */
  replyTargetId: string | undefined;
  /**
   * Row ids whose `space`-reply RPC is currently outstanding — renders a
   * distinct "sending" glyph (never the busy spinner) until the RPC settles
   * OR the bounded client-side wait is exceeded, whichever comes first. See
   * {@link handleReply}.
   */
  pendingReplyIds: Set<string>;
  /**
   * One entry per row whose last reply attempt is currently showing as
   * failed — rejected, or exceeded the bounded client-side wait
   * ({@link replyRpcTimeoutMs}) while the underlying RPC was still running.
   * Carries the lost text back so reopening the reply panel on that row
   * restores it instead of dropping it (see `onReplyRequest`). Cleared on
   * the next send attempt for that row (success or failure), on a fresh
   * re-entry, and — the late-ack case — if the underlying RPC the bounded
   * wait gave up on turns out to have succeeded after all (see
   * {@link settleReplyAttempt}).
   */
  replyFailures: Map<string, { text: string }>;
  /**
   * The reply RPC promise currently "owned" by each row's most recent
   * {@link handleReply} call. The bounded wait in `handleReply` can give up
   * on a row while the real RPC keeps running in the background; this map
   * is how {@link settleReplyAttempt} tells whether a given attempt is
   * still the one that matters for that row (its own promise still matches
   * the map entry) before touching `pendingReplyIds`/`replyFailures` — a
   * retry overwrites the entry, which is what lets a stale late arrival
   * from the SUPERSEDED attempt no-op instead of clobbering the newer
   * one's state. Not rendered; pure bookkeeping, same footing as
   * `flashTimer`/`busyTicker` below.
   */
  replyAttempts: Map<string, Promise<void>>;
  /**
   * The {@link handleReply} call's own promise for each row's most recent
   * attempt — distinct from {@link replyAttempts}' raw RPC promise, which
   * can run long after the client gives up: THIS promise always settles
   * within {@link replyRpcTimeoutMs}, because `handleReply`'s own control
   * flow bounds itself on that same wait (success or the bounded give-up,
   * whichever comes first). The attach barrier
   * ({@link AgentsViewController.awaitPendingReply}, R9 Q1a) awaits this
   * map, never `replyAttempts`, so a stuck underlying RPC can never block an
   * attach — only the bounded wait can. Entries are removed once the
   * promise they hold settles.
   */
  replyBarriers: Map<string, Promise<void>>;
  /**
   * A2 optimistic placeholders currently in flight — placeholder id → the
   * fields `AgentsRoster.upsertLocalRow` was given when it was inserted
   * (everything but `busy`, which is always `true` for a live placeholder).
   * A WS reconnect's `refreshRoster` reseeds the whole roster from the
   * server's row list via `AgentsRoster.setAllRows` — a full clear + reseed
   * with no server-side representation for a client-only placeholder, which
   * would otherwise wipe it until `createSession` resolves. `refreshRoster`
   * re-asserts every entry here immediately after that reseed instead, so
   * the row survives a reconnect landing mid-dispatch. Populated when a
   * placeholder is inserted in `handleDispatch`, deleted on both resolution
   * paths (promotion to the real id, and removal on a `createSession`
   * failure) — this map's keys are always exactly the roster's
   * currently-live placeholder ids.
   */
  pendingDispatchPlaceholders: Map<string, { title: string; workDir: string; updatedAt: number }>;
  selectedId: string | undefined;
  /**
   * The session id this SAME roster-attach lifecycle was last backed out of
   * via ← (`returnToAgentsView`) — `undefined` until the first such return.
   * Scoped to this `AgentsViewState` object's lifetime (reset only by a
   * fresh `close()` + re-`show()`), not persisted across process restarts.
   * Attaching TO a session (`detachForAttach`) never touches this — it only
   * changes on the way back. Drives the row-level `isOrigin` bold marker.
   */
  originSessionId: string | undefined;
  /** Ctrl+X first-press target awaiting a second Ctrl+X — GROUP HEADERS
   *  only now (B1 moved row deletes to the arm fields below); see
   *  `AgentsViewProps.confirmDeleteId`'s own doc. */
  confirmDeleteId: string | undefined;
  /** B1: roster ROW id currently Ctrl+X-armed — see `armDelete`/
   *  `clearArmedDelete` and `AgentsViewProps.armedDeleteId`'s own doc.
   *  Mutually exclusive with `confirmDeleteId`. */
  armedDeleteId: string | undefined;
  /** See `AgentsViewProps.armedDeleteStopped`'s own doc. */
  armedDeleteStopped: boolean;
  /** Auto-expire timer for the current arm (`DELETE_ARM_WINDOW_MS`);
   *  cleared by `clearArmedDelete` (confirm, cancel, any other action, its
   *  own firing) — same "controller owns the timer, only it can force a
   *  repaint on silent expiry" shape as `pendingExitTimer` below. */
  armedDeleteTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The armed row's classify-relevant fields (`busy`, `pendingInteraction`,
   * `updatedAt`) as of arm time — fed to `AgentsRoster.withFrozenRow` in
   * `buildProps` so a live event or WS-reconnect reseed landing mid-arm
   * can't bucket/reorder the row out from under the user (see that
   * method's own doc for why freezing these three is what freezing
   * "position" reduces to).
   */
  armedDeleteFreeze:
    | { busy: boolean; pendingInteraction: AgentsRosterRow['pendingInteraction']; updatedAt: number }
    | undefined;
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
  /**
   * Set while a first Ctrl+C is armed, waiting on a confirming second press
   * within `EXIT_CONFIRM_WINDOW_MS` — owned here (not the component) because
   * disarming on a silent timeout needs `host.state.ui.requestRender()` to
   * repaint without a keypress, access only the controller has. Exposed to
   * the component read-only as `AgentsViewProps.pendingExitArmed`.
   */
  pendingExitTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Group ids currently manually collapsed. State-mode ids (`AgentsGroupId`)
   * and directory-mode ids (`dir:<workDir>` / `other` / `directory-pinned`,
   * `AgentsGroup.id`'s own doc) share this one `Set<string>` — the two id
   * spaces are kept deliberately disjoint (directory mode's Pinned group
   * uses `directory-pinned`, not state mode's `pinned`, precisely so this
   * holds), so a collapse from one mode never matches an id from the other:
   * switching modes naturally shows everything expanded again there without
   * any explicit reset.
   */
  collapsedGroups: Set<string>;
  completedExpanded: boolean;
  /** A6: roster grouping — Ctrl+S cycles `state ⇄ directory`; persisted via
   *  {@link AgentsViewHost.saveAgentsViewGroupMode}. */
  groupMode: AgentsGroupMode;
  eventUnsubscribe: Unsubscribe;
  /** WS connection-state subscription (wire transport only) — drives the
   *  post-reconnect roster reconciliation. Dies with the view on close(). */
  connectionUnsubscribe: Unsubscribe | undefined;
}

/**
 * Per-attempt server-side bound this client assumes for headroom purposes
 * when `KIMI_SNAPSHOT_TIMEOUT_MS` is unset — same default the resume chain's
 * own bounds use (`agent-core-v2`'s `DEFAULT_ROOT_STAT_TIMEOUT_MS` /
 * `DEFAULT_MCP_READY_TIMEOUT_MS`, both 4000).
 */
const DEFAULT_SERVER_TIMEOUT_MS = 4000;

/**
 * Fixed slack added on top of the doubled server bound in
 * {@link replyRpcTimeoutMs} — network RTT to reach the server at all, plus
 * the several resume-chain awaits that stay unbounded after this fix round
 * (`workspaceDirs.ready`, `hostEnv.ready`, `sessionMetadata.ready`,
 * `sessionToolPolicy.ready`, the agent-profile loaders). Same order of
 * magnitude as this codebase's other client-side RPC-wait constant,
 * `MODEL_PICKER_REFRESH_TIMEOUT_MS` (`commands/config.ts`).
 */
const REPLY_RPC_TIMEOUT_MARGIN_MS = 2_000;

/**
 * Bounds {@link AgentsViewController.loadTrust}'s fan-out. A roster
 * accumulated over a long-lived home can hold hundreds of rows; firing one
 * `getWorkspaceTrustForSession` RPC per row unconditionally would put that
 * many concurrent HTTP round-trips in flight the moment the roster paints —
 * all landing on the same event loop the terminal uses for keypress
 * dispatch and render. A small worker pool pulling from a shared cursor
 * (same shape as `feedback/upload.ts`'s `uploadParts`) keeps steady
 * progress without the unbounded burst.
 */
export const LOAD_TRUST_CONCURRENCY = 8;

/**
 * Bounds how long the view waits for a reply RPC before treating it as
 * failed. The server chain this RPC funnels through can legitimately stack
 * TWO instances of the same server bound in series on a cold resume
 * (`WorkspaceService.createOrTouch`'s root-stat wait, then
 * `WorkspaceHandlerService.materializeSession`'s MCP-ready wait) before the
 * client's own clock — started earlier, at RPC issue, not at either
 * server-side timer's start — even gets to see either one resolve. Matching
 * the server bound 1:1 is therefore guaranteed to fire first on any
 * legitimately-slow-but-not-stuck resume, so this derives real headroom:
 * twice the assumed per-attempt server bound plus a fixed margin. Reads
 * `KIMI_SNAPSHOT_TIMEOUT_MS` fresh on every call (not cached at import) so
 * raising that knob to tolerate a slower legitimate resume widens the
 * client's patience too, instead of widening the gap between the two —
 * deliberately the SAME env var the server-side bounds use, not a new
 * client-only one (the connected kap-server shares this process's env —
 * same-machine is today's only deployment; a remote-host kap-server would
 * need its own signal, out of scope here).
 */
export function replyRpcTimeoutMs(): number {
  const serverBound = parseIntegerEnv(process.env['KIMI_SNAPSHOT_TIMEOUT_MS'], DEFAULT_SERVER_TIMEOUT_MS, 100);
  return 2 * serverBound + REPLY_RPC_TIMEOUT_MARGIN_MS;
}

/**
 * Bounds `promise` to `ms`: rejects with a timeout error if it hasn't
 * settled in time. Losing race leaves `promise` itself still running in the
 * background — this function doesn't observe it further, though a caller
 * may (see {@link handleReply}, which attaches its own `.then` to the same
 * promise for exactly that reason). Same `Promise.race` + timer shape
 * already used for client-side RPC waits elsewhere in this codebase
 * (`commands/config.ts`'s `withTimeout`, `cli/run-prompt.ts`'s
 * `raceWithTimeout`).
 */
function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(ms)}ms`));
    }, ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
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
 * `parseDispatchInput`. No `completeArgs`: profile names come from
 * filesystem discovery that's DI-service-only today (`agent-core-v2`'s
 * `workspaceAgentProfileLoader`), not a plain list the TUI can call, so the
 * argument position shows no suggestions — `argumentHint` below still labels
 * it in the top-level `/` menu.
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
const DISPATCH_BUILTIN_WHITELIST: ReadonlySet<string> = new Set(['model']);

/**
 * Prefix for the client-fabricated id an optimistic dispatch placeholder
 * (A2) carries until `handleDispatch` learns the real session id — never
 * sent to the SDK, never persisted (it never touches `viewSessions`/
 * `pins`/`seenAt`), purely a local `AgentsRoster` row key. A colon-bearing
 * prefix keeps it visibly distinct from any real session id (see the
 * `wireRow`/`summary` id shapes throughout this module's own tests — plain
 * slugs, never containing `:`).
 */
const PENDING_DISPATCH_ID_PREFIX = 'pending-dispatch:';

function isPendingDispatchId(id: string): boolean {
  return id.startsWith(PENDING_DISPATCH_ID_PREFIX);
}

/** Shown when a row action targets a placeholder still waiting on its real
 *  session id (`isPendingDispatchId`) — every action that needs a REAL
 *  session (open/reply/rename/pin/delete) declines with this hint instead
 *  of acting on a fabricated id. */
const DISPATCHING_HINT = 'Still dispatching — try again in a moment';

/**
 * The dispatch autocomplete whitelist: `/model` filtered out of
 * `BUILTIN_SLASH_COMMANDS` (its copy is not reinvented here, only its
 * argument completion is added), the dispatch-local `/agent` item, and every
 * skill the main chat's own `/` menu would show — same source, same entries.
 * Plugin commands are deliberately dropped (item 2): there is no wire
 * activation route for one, so advertising it would offer a command that
 * always rejects on submit — `pluginCommandMap` is the signal that
 * identifies which of `getActivatableCommands().commands` are plugin
 * commands (skill/plugin entries carry no other discriminator).
 * `getModelCompletions`/`getActivatableCommands` are getters rather than
 * captured snapshots so the closures they feed always see live data as of
 * completion/menu-build time, not as of this call.
 */
export function dispatchSlashCommands(
  getModelCompletions: () => readonly ArgCompletionSpec[],
  getActivatableCommands: () => DispatchActivatableCommands,
): readonly KimiSlashCommand[] {
  const builtins = BUILTIN_SLASH_COMMANDS.filter((command) =>
    DISPATCH_BUILTIN_WHITELIST.has(command.name),
  ).map((command) =>
    command.name === 'model'
      ? {
          ...command,
          completeArgs: (prefix: string) => completeLeadingArg(getModelCompletions(), prefix),
        }
      : command,
  );
  const { commands, pluginCommandMap } = getActivatableCommands();
  const activatable = commands.filter((command) => !pluginCommandMap.has(command.name));
  return [...builtins, DISPATCH_AGENT_COMMAND, ...activatable];
}

/**
 * Mounts the agents view as a full-screen takeover (same container-swap
 * pattern as TasksBrowserController), owns the roster data flow
 * (listSessions + global event subscription) and every action side effect —
 * the component stays SDK-free.
 *
 * Component contract obligations (see AgentsViewApp's docstring):
 * - While `confirmDeleteId` (group headers) or `armedDeleteId` (B1, rows —
 *   mutually exclusive with `confirmDeleteId`) is set, ANY action callback
 *   — including `onQuit` (Esc during confirm/arm) — clears it instead of
 *   acting as a quit; see `clearDeleteOverlays`.
 * - Esc during rename submits the ORIGINAL title; an unchanged title is a
 *   cancel and never reaches the SDK.
 */
export class AgentsViewController {
  constructor(
    private readonly host: AgentsViewHost,
    /**
     * Same store the main REPL editor pastes into (`KimiTUI`'s single
     * per-process `ImageAttachmentStore`) — threaded through the
     * constructor rather than `AgentsViewHost`, matching how
     * `EditorKeyboardController` receives it, since `KimiTUI`'s own field is
     * private. A pasted attachment's id is valid on either composer.
     */
    private readonly imageStore: ImageAttachmentStore,
  ) {}

  /**
   * B2: session ids this TUI PROCESS has successfully attached to at least
   * once — drives the roster footer's `enter to open` → `enter to return`
   * verb (`AgentsViewProps.attachedIds`). Lives on the controller instance
   * itself (constructed once per process, see `KimiTUI`'s constructor), not
   * on `AgentsViewState` — that state object is recreated per `show()`
   * after a `close()`, but this memory must survive that and only reset on
   * an actual process restart. Never persisted to disk.
   */
  private readonly attachedSessionIds = new Set<string>();

  get isOpen(): boolean {
    return this.host.state.agentsView !== undefined;
  }

  /**
   * `originSessionId`: passed only by the ← "return to roster" seam
   * (`returnToAgentsView`) — the session id the caller is backing out of.
   * Every other caller (cold open, post-quit-confirm remount, failed-attach
   * recovery) omits it, leaving whatever origin the lifecycle already had
   * untouched.
   */
  async show(originSessionId?: string): Promise<void> {
    const { state } = this.host;
    const existing = state.agentsView;
    if (existing !== undefined) {
      // Return from attach: remount the same component over the live roster —
      // the subscription kept it current, so there is nothing to reload.
      if (existing.detached) {
        if (originSessionId !== undefined) existing.originSessionId = originSessionId;
        this.remount(existing);
      }
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
    const groupMode = this.host.agentsViewGroupMode();
    const { pins, sessions: viewSessions, seenAt } = persisted;

    const roster = new AgentsRoster(pins, seenAt);
    if (wireRows !== undefined) roster.setAllRows(wireRows.filter((row) => viewSessions.has(row.id)));
    else if (summaries !== undefined) roster.setAll(summaries.filter((row) => viewSessions.has(row.id)));

    // The dispatch editor is built before the component: it renders into the
    // component's bottom box, so the initial props already reference it.
    const dispatch = new AgentsViewDispatch(
      state.ui,
      this.host.agentsViewWorkDir(),
      () => this.host.agentsViewActivatableCommands(),
    );
    dispatch.installAutocomplete(
      dispatchSlashCommands(
        () => this.host.agentsViewModelCompletions(),
        () => this.host.agentsViewActivatableCommands(),
      ),
    );

    const component = new AgentsViewApp(
      this.buildProps({
        roster,
        pins,
        dispatch,
        dispatchFocused: false,
        replyTargetId: undefined,
        pendingReplyIds: new Set(),
        replyFailures: new Map(),
        selectedId: undefined,
        originSessionId: undefined,
        confirmDeleteId: undefined,
        armedDeleteId: undefined,
        armedDeleteStopped: false,
        armedDeleteFreeze: undefined,
        renameDraft: undefined,
        flashMessage: undefined,
        pendingExitTimer: undefined,
        collapsedGroups: new Set(),
        completedExpanded: false,
        groupMode,
      }),
      state.terminal,
    );

    const savedChildren = [...state.ui.children];
    state.ui.clear();
    state.ui.addChild(component);
    state.ui.setFocus(component);
    // Mouse tracking is scoped to exactly this mount window (see
    // detachForAttach/close for the matching disable) — never left on for
    // the chat REPL or any other view, which would otherwise break native
    // text selection there.
    state.terminal.enableMouseTracking();
    state.ui.requestRender(true);

    dispatch.onSubmit = (submission) => {
      const view = this.host.state.agentsView;
      const replyTarget = view?.replyTargetId;
      if (view !== undefined) this.closeReplyPanel(view);
      if (view !== undefined && replyTarget !== undefined) {
        // Bounded (replyRpcTimeoutMs) regardless of how long the underlying
        // RPC actually takes — see replyBarriers' own doc. The attach
        // barrier (awaitPendingReply) reads this map entry, never the raw
        // RPC promise in replyAttempts.
        const barrier = this.handleReply(view, replyTarget, submission.text);
        view.replyBarriers.set(replyTarget, barrier);
        void barrier.finally(() => {
          if (view.replyBarriers.get(replyTarget) === barrier) view.replyBarriers.delete(replyTarget);
        });
        return;
      }
      void this.handleDispatch(submission);
    };
    // B7: shift+Enter never targets a reply (see `AgentsViewDispatch.
    // handleShiftEnterSubmit`'s own `replying` guard) — identical dispatch,
    // then attach the moment the real session id exists (see
    // `handleDispatch`'s `attach` option).
    dispatch.onShiftEnterSubmit = (submission) => {
      void this.handleDispatch(submission, { attach: true });
    };
    dispatch.onError = (message) => {
      const view = this.host.state.agentsView;
      if (view !== undefined) this.closeReplyPanel(view);
      this.flash(message);
    };
    // M3: the B6 "not runnable here" toast restores the composer's text
    // (`AgentsViewDispatch.handleEditorSubmit`) so the user can edit it —
    // closing the reply panel here (as `onError` does) would strand that
    // text with focus on the list, where Enter attaches instead of editing.
    // Just flash; leave focus and the restored text alone.
    dispatch.onToast = (message) => {
      this.flash(message);
    };
    // `exit` / `/exit` submitted from the dispatch composer — dispatch mode
    // only, `AgentsViewDispatch` never fires this while `replying`. Same
    // close path as onQuit (Esc-Esc / `?` grid's `esc to quit`).
    dispatch.onExit = () => {
      this.close();
    };
    // I2: the roster composer has no one-shot shell route either — same
    // reasoning as the main chat editor's own agents-view veto
    // (editor-keyboard.ts's `onBashModeAttempt`, same hint copy). Routed
    // through `notifyUser` so the hint is visible while the roster is
    // mounted (`host.showStatus` alone would render into the detached
    // UI-tree child `show()`'s own `state.ui.clear()` already replaced).
    dispatch.editor.onBashModeAttempt = () => {
      const view = this.host.state.agentsView;
      if (view === undefined) return false;
      this.notifyUser(view, 'Shell commands (!) are not available in agents view.');
      return true;
    };
    // Esc inside the focused editor returns focus to the list (the editor's
    // own autocomplete-cancel wins over this when a dropdown is open).
    // The reply panel is closed the same way as a submit: back to the "new
    // session" composer, not a second escape stage — and (unlike a submit,
    // which the editor already emptied on its own) this is the path that
    // discards an unsent draft (see `exitReplyMode`).
    dispatch.editor.onEscape = () => {
      const view = this.host.state.agentsView;
      if (view !== undefined) this.closeReplyPanel(view);
    };
    // B11: Esc closing the slash/@-mention dropdown never reaches `onEscape`
    // above (pi-tui's own hasAutocompleteActivity() gate intercepts it
    // first and always closes the dropdown itself before this fires — see
    // `CustomEditor.handleInput`'s Esc branch). Scoped to the plain "new
    // session" composer: reply mode has no slash-command surface
    // (`parseReplyInput` never interprets `/`) and clearing an in-progress
    // reply out from under the user is not this item's concern.
    //
    // I4: `hasAutocompleteActivity()` is true for an open dropdown AND for
    // a pending debounce/abort timer with nothing on screen yet — so this
    // also fires mid-sentence, e.g. `fix the bug in @src/x` while the
    // `@`-mention menu is still resolving. B11's own stated scope is the
    // slash menu specifically ("the menu closes but `/` and whatever else
    // was typed keeps sitting in the composer" — this comment's own
    // pre-fix wording), so the whole-buffer wipe only belongs to that case:
    // clear only when the draft is itself a slash command in progress: a
    // mid-sentence `@`-mention dismissal or a debounce-pending Esc must
    // preserve the draft instead.
    dispatch.editor.onEscapeAutocompleteCancel = () => {
      const view = this.host.state.agentsView;
      if (view === undefined || view.replyTargetId !== undefined) return;
      if (dispatch.editor.getText().trim().startsWith('/')) dispatch.editor.setText('');
    };
    // B8: → on an EMPTY composer attaches to the selected row — the same
    // `handleOpen` Enter/→ on the row itself already calls, just reached
    // from inside the composer instead of the list. No selection (or a
    // reply-mode composer, which has its own empty-Enter attach path via
    // `handleReplyPanelKey`) declines and lets pi-tui's own empty-buffer
    // cursor-right no-op run.
    dispatch.editor.onRightArrowEmpty = () => {
      const view = this.host.state.agentsView;
      if (view === undefined || view.replyTargetId !== undefined) return false;
      const id = view.selectedId;
      if (id === undefined) return false;
      this.handleOpen(id);
      return true;
    };
    // Ctrl+C parity with the main REPL (editor-keyboard.ts's own onCtrlC):
    // `AgentsViewApp.handleInput` routes every key to the editor while
    // `dispatchFocused`, so without this the editor's `CustomEditor.
    // handleInput` sees Ctrl+C, finds `onCtrlC` unset, and does nothing —
    // the two-stage exit can never arm from a focused composer. Mirrors the
    // main REPL exactly: clear the draft if present, then defer to the same
    // arm/quit machine the list-focused Ctrl+C uses (`triggerCtrlC`) —
    // reached identically for a new dispatch or an open reply panel, since
    // both share this one editor instance.
    dispatch.editor.onCtrlC = () => {
      const view = this.host.state.agentsView;
      if (view === undefined) return;
      if (dispatch.editor.getText().length > 0) dispatch.editor.setText('');
      this.triggerCtrlC(view);
    };
    // Same clipboard → attachment → placeholder pipeline the main REPL
    // editor pastes through (`clipboard-paste.ts`), reused rather than
    // reimplemented: the placeholder lands in the SAME per-process
    // `imageStore`, so `handleDispatch`/`handleReply` expand it identically
    // to how `KimiTUI.sendNormalUserInput` expands a main-chat paste. No
    // session is known yet here (dispatch targets a NEW session; reply
    // targets one this process never resumed), so `sessionDir` is left
    // unset — the pre-compression original falls back to the temp-dir path
    // `pasteClipboardImage` already applies when a session dir is unknown.
    // Errors route through `notifyUser`, not `host.showError` — same
    // detached-UI-tree reasoning as `onBashModeAttempt` above.
    dispatch.editor.onPasteImage = async () =>
      pasteClipboardImage({
        editor: dispatch.editor,
        imageStore: this.imageStore,
        harness: this.host.harness,
        track: (event, properties) => this.host.track(event, properties),
        notifyError: (message) => this.notifyUser(this.host.state.agentsView, message, { error: true }),
        requestRender: () => this.host.state.ui.requestRender(),
      });

    this.host.setAgentsView({
      component,
      savedChildren,
      roster,
      pins,
      viewSessions,
      seenAt,
      dispatch,
      detached: false,
      dispatchFocused: false,
      replyTargetId: undefined,
      pendingReplyIds: new Set(),
      replyFailures: new Map(),
      replyAttempts: new Map(),
      replyBarriers: new Map(),
      pendingDispatchPlaceholders: new Map(),
      selectedId: undefined,
      originSessionId: undefined,
      confirmDeleteId: undefined,
      armedDeleteId: undefined,
      armedDeleteStopped: false,
      armedDeleteTimer: undefined,
      armedDeleteFreeze: undefined,
      renameDraft: undefined,
      flashMessage: undefined,
      flashTimer: undefined,
      busyTicker: undefined,
      pendingExitTimer: undefined,
      collapsedGroups: new Set(),
      completedExpanded: false,
      groupMode,
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
    // Skill cold-start gap (R6 review): the composer is already usable
    // without the warmed menu, so this must never block show() either.
    void this.warmSkillMenu(dispatch);
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
    if (view.pendingExitTimer !== undefined) clearTimeout(view.pendingExitTimer);
    if (view.armedDeleteTimer !== undefined) clearTimeout(view.armedDeleteTimer);
    this.host.setAttachBadge(undefined);

    state.ui.clear();
    for (const child of view.savedChildren) {
      state.ui.addChild(child);
    }
    this.host.setAgentsView(undefined);
    // Unmounting for good — turn mouse tracking back off (see show()'s
    // matching enable).
    state.terminal.disableMouseTracking();
    state.ui.setFocus(state.editorContainer.children[0] ?? state.editor);
    state.ui.requestRender(true);
    // Panels deferred while the takeover was up mount now — the user is back
    // in the chat that owns the pending interaction.
    this.host.flushDeferredPanels?.();
  }

  /**
   * Attach barrier (R9 Q1a): if `targetId` has a roster reply RPC in flight
   * from this same lifecycle, waits for it to settle — success or the
   * bounded {@link replyRpcTimeoutMs} give-up, see {@link
   * AgentsViewState.replyBarriers} — before the caller takes an attach
   * snapshot, so the snapshot can never race ahead of the reply's own
   * durability. No-op (resolves immediately) when nothing is pending for
   * this row. Reuses R8's own per-row bookkeeping instead of a new
   * synchronization primitive; no separate timeout is added here since the
   * awaited promise is already bounded.
   */
  async awaitPendingReply(targetId: string): Promise<void> {
    const barrier = this.host.state.agentsView?.replyBarriers.get(targetId);
    if (barrier === undefined) return;
    await barrier;
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
    // An armed Ctrl+C hint is screen-local: detaching mid-window must not
    // leave a stale timer running against the now-invisible component, nor
    // let its footer hint reappear armed on remount (remount reuses this
    // same component instance) with the next Ctrl+C misread as a
    // confirming second press instead of a fresh first one.
    if (view.pendingExitTimer !== undefined) {
      clearTimeout(view.pendingExitTimer);
      view.pendingExitTimer = undefined;
    }
    // Same reasoning as the Ctrl+C hint above: a B1 row arm is screen-local
    // too — detaching mid-arm must not leave its timer running against the
    // invisible component, nor have it reappear armed on remount.
    this.clearArmedDelete(view);

    state.ui.clear();
    for (const child of view.savedChildren) {
      state.ui.addChild(child);
    }
    // Detaching (not closing) still unmounts the component — turn mouse
    // tracking back off, same as close(); remount() turns it back on.
    state.terminal.disableMouseTracking();
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
    // Remounted — turn mouse tracking back on (see detachForAttach's
    // matching disable).
    state.terminal.enableMouseTracking();
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
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        const id = ids[index];
        if (id === undefined) return;
        // Archived sessions never entered the roster; setTrusted would no-op.
        if (view.roster.get(id) === undefined) continue;
        let trusted: boolean | undefined;
        try {
          trusted = await rpc.getWorkspaceTrustForSession(id);
        } catch {
          continue;
        }
        if (this.host.state.agentsView !== view) return;
        view.roster.setTrusted(id, trusted);
        changed = true;
      }
    };
    const workerCount = Math.min(LOAD_TRUST_CONCURRENCY, ids.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    if (changed && this.host.state.agentsView === view) this.pushProps();
  }

  /**
   * Closes the dispatch composer's skill cold-start gap (R6 review):
   * `agentsViewActivatableCommands()` only reflects skills once a session
   * has attached this run, so the menu built at mount time can miss them.
   * Same "load after mount, never block show()" shape as `loadTrust` —
   * awaits the host's warming call, then re-installs the dispatch
   * autocomplete so the on-screen `/` menu picks up whatever the host
   * filled in, without the user needing to reopen the view. No-ops if the
   * view closed or was replaced by a fresh `show()` while awaiting.
   */
  private async warmSkillMenu(dispatch: AgentsViewDispatch): Promise<void> {
    const view = this.host.state.agentsView;
    if (view === undefined) return;
    await this.host.warmAgentsViewSkillMenu();
    if (this.host.state.agentsView !== view) return;
    dispatch.installAutocomplete(
      dispatchSlashCommands(
        () => this.host.agentsViewModelCompletions(),
        () => this.host.agentsViewActivatableCommands(),
      ),
    );
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
    // A2: `setAllRows` has no server-side row for a client-only placeholder
    // still in flight — re-assert every one immediately, BEFORE the dangling
    // -selection check below (a reconnect landing mid-dispatch must not read
    // as "the selected row vanished" when it's about to be put right back).
    for (const [id, placeholder] of view.pendingDispatchPlaceholders) {
      view.roster.upsertLocalRow({ id, busy: true, ...placeholder });
    }
    // A session that vanished during the drop must not leave a dangling
    // selection behind.
    if (view.selectedId !== undefined && view.roster.get(view.selectedId) === undefined) {
      view.selectedId = undefined;
    }
    // B1: nor a dangling row arm — a refresh that REMOVES the armed row
    // outright (e.g. archived from another client while armed here) has
    // nothing left to freeze a position for; `withFrozenRow` would just
    // silently no-op forever, leaving a stale timer ticking against a row
    // that no longer exists.
    if (view.armedDeleteId !== undefined && view.roster.get(view.armedDeleteId) === undefined) {
      this.clearArmedDelete(view);
    }
    this.syncBusyTicker();
    this.pushProps();
    // The attach badge reads the same roster while detached — keep it honest.
    if (view.detached) this.pushAttachBadge(view, this.host.getCurrentSessionId());
  }

  /**
   * Dispatch flow: create the session in the view's workDir, then apply the
   * first RPC call. Staged model/profile overrides ride the first `prompt`
   * call's submission body — the wire create route drops per-session agent
   * config, so they never reach `createSession`. A staged skill/plugin
   * activation instead calls `activateSkill`/`activatePluginCommand` in
   * place of `prompt` — neither is literal text the model should see
   * verbatim (see `DispatchActivation`'s doc comment).
   *
   * A2 optimistic placeholder: for a PLAIN, non-slash submission (`model`/
   * `profile`/`activation` all undefined — a `/model`/`/agent`/skill/plugin
   * dispatch keeps the pre-A2 behaviour, matching the task brief's own
   * carve-out) a local row is inserted into the roster SYNCHRONOUSLY, before
   * the `createSession` await — busy (spinner), selected, named after the
   * raw prompt text — so the row is on screen the instant Enter is pressed
   * instead of waiting 1–30s for the server's own `event.session.created`
   * echo. Once `createSession` resolves, the placeholder is promoted IN
   * PLACE to the real session id (`AgentsRoster.upsertLocalRow`'s own doc
   * explains why this alone prevents a double row: `Map.set` on a key
   * already in the map overwrites, so a same-id echo arriving afterward just
   * refreshes the same entry). A `createSession` failure removes the
   * placeholder instead of leaving a dead row behind — same "Dispatch
   * failed: …" flash the pre-A2 failure path already used, chosen over an
   * in-row failed-glyph because a placeholder has no server-side session to
   * retry or delete.
   *
   * `options.attach` (B7 — shift+Enter): once the real id is known, attaches
   * to it immediately via the same `host.onOpenSession` path a manual Enter/
   * → on a roster row uses — the placeholder bridges the roster view for
   * however long `createSession` takes, then the view hands off to attach
   * the moment it can. That attach can detach the roster view (`view.
   * detached`) before the first turn's own `activateSkill`/`prompt` call
   * settles — a rejection reaching the final catch below routes to
   * `host.showError` instead of `flash` in that case, since `flash`'s
   * `pushProps()` silently no-ops while detached (see `handleRename`'s own
   * catch for the same host-level fallback).
   *
   * `view.pendingDispatchPlaceholders` mirrors whatever placeholder this
   * call currently has live — see its own doc for why (a WS reconnect's
   * `refreshRoster` needs it to survive its full roster reseed).
   */
  private async handleDispatch(
    submission: DispatchSubmission,
    options: { attach?: boolean } = {},
  ): Promise<void> {
    const view = this.host.state.agentsView;
    if (view === undefined) return;

    // Media placeholders resolve BEFORE createSession, same "validate before
    // mutate" invariant the overrides-vs-transport check below applies: a
    // pasted video whose cache copy fails (unwritable cache dir, vanished
    // source) must not orphan a server-side session with no way to receive
    // the now-lost media. An activation's args go through
    // `rewriteMediaPlaceholders` (the plain-text channel `session.
    // activateSkill`/`activatePluginCommand` read — same 'plain'/'tag' style
    // split as `KimiTUI.sendSkillActivation`/`activatePluginCommand`); a
    // plain prompt goes through `extractMediaAttachments`, matching
    // `KimiTUI.sendNormalUserInput`. Mirrors that method's own catch: report
    // and send nothing.
    let promptParts: PromptPart[] | undefined;
    let activationArgs = submission.activation?.args ?? '';
    try {
      if (submission.activation !== undefined) {
        const style: MediaReferenceStyle = submission.activation.kind === 'skill' ? 'plain' : 'tag';
        activationArgs = rewriteMediaPlaceholders(submission.activation.args, this.imageStore, style).text;
      } else {
        const extraction = extractMediaAttachments(submission.text, this.imageStore);
        if (extraction.hasMedia) promptParts = extraction.parts;
      }
    } catch (error) {
      const message = `Failed to prepare media attachment: ${error instanceof Error ? error.message : String(error)}`;
      this.notifyUser(view, message, { error: true });
      return;
    }

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

    const isPlainDispatch =
      submission.model === undefined && submission.profile === undefined && submission.activation === undefined;
    let placeholderId: string | undefined;
    if (isPlainDispatch) {
      placeholderId = `${PENDING_DISPATCH_ID_PREFIX}${randomUUID()}`;
      const placeholderFields = {
        title: submission.text,
        workDir: this.host.agentsViewWorkDir(),
        updatedAt: Date.now(),
      };
      view.pendingDispatchPlaceholders.set(placeholderId, placeholderFields);
      view.roster.upsertLocalRow({ id: placeholderId, busy: true, ...placeholderFields });
      view.selectedId = placeholderId;
      this.syncBusyTicker();
      this.pushProps();
    }

    let session: Awaited<ReturnType<KimiHarness['createSession']>>;
    try {
      session = await this.host.harness.createSession({
        workDir: this.host.agentsViewWorkDir(),
      });
    } catch (error) {
      if (this.host.state.agentsView !== view) return;
      if (placeholderId !== undefined) {
        view.roster.remove(placeholderId);
        view.pendingDispatchPlaceholders.delete(placeholderId);
        if (view.selectedId === placeholderId) view.selectedId = undefined;
        this.syncBusyTicker();
      }
      this.flash(`Dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    // I7: `view` can be dead here — the only async continuation on this
    // method without the staleness guard every other one in this file has
    // (loadTrust, refreshRoster, handleReply, handleDelete, handleRename,
    // persistState, …). Re-read live state and branch on how it relates to
    // the captured `view` instead of assuming they still match. Never
    // mutate or persist the dead `view` past this point.
    const live = this.host.state.agentsView;
    if (live === view) {
      // Register BEFORE the first RPC call: the server's
      // `event.session.created` echo only enters the roster when the id is
      // already in the view's registry.
      view.viewSessions.add(session.id);
      void this.persistState(view);
      if (placeholderId !== undefined) {
        view.roster.remove(placeholderId);
        view.pendingDispatchPlaceholders.delete(placeholderId);
        view.roster.upsertLocalRow({
          id: session.id,
          title: submission.text,
          workDir: this.host.agentsViewWorkDir(),
          updatedAt: Date.now(),
          busy: true,
        });
        if (view.selectedId === placeholderId) view.selectedId = session.id;
      } else {
        // The new row is pre-selected so the dispatch is visibly confirmed the
        // moment it lands — the slash-command paths have no placeholder to
        // promote, so this is the first time `selectedId` moves onto it.
        view.selectedId = session.id;
      }
      this.pushProps();

      if (options.attach === true) {
        // Same "no attach seam" fallback `onOpen` already uses — B7 is the
        // same attach contract, just reached via shift+Enter instead of a
        // second Enter on the row.
        if (this.host.onOpenSession !== undefined) {
          view.roster.markSeen(session.id);
          // B2: same attach-succeeded record `onOpen` writes.
          this.attachedSessionIds.add(session.id);
          void this.persistState(view);
          this.host.onOpenSession(session.id);
        } else {
          this.notifyUser(view, 'Attach is not available from this host');
        }
      }
    } else if (live !== undefined) {
      // The view was REBUILT while `createSession` was in flight (e.g. the
      // user declined a quit-confirm and a fresh `AgentsViewState`
      // remounted — see `KimiTUI.stop`) — `view` is dead. Register the id
      // into the LIVE view's registry so the row appears on its next
      // refresh; the dead view's placeholder reconcile is skipped (nothing
      // renders it any more) and so is `options.attach` — the dispatch
      // context (the screen the user pressed Enter/Shift+Enter from) is
      // gone, so an unasked attach would be worse than none.
      live.viewSessions.add(session.id);
      void this.persistState(live);
    } else {
      // The view closed entirely while `createSession` was in flight —
      // there is no live `AgentsViewState` to register the id into or to
      // snapshot (persisting the dead view's own Sets here is exactly the
      // clobber this guard exists to prevent). Persist just this one id
      // through the same on-disk registry `persistState` writes, so the
      // session isn't orphaned from the view's registry next time it opens.
      void this.persistOrphanedSessionId(session.id);
    }

    try {
      const { activation } = submission;
      if (activation !== undefined) {
        if (activation.kind === 'skill') {
          await session.activateSkill(activation.skillName, activationArgs);
        } else {
          await session.activatePluginCommand(
            activation.pluginId,
            activation.commandName,
            activationArgs,
          );
        }
      } else if (rpc !== undefined) {
        await rpc.prompt({
          sessionId: session.id,
          input: promptParts ?? [{ type: 'text', text: submission.text }],
          model: submission.model,
          profile: submission.profile,
        });
      } else {
        await session.prompt(promptParts ?? submission.text);
      }
    } catch (error) {
      if (this.host.state.agentsView !== view) return;
      const message = `Dispatch failed: ${error instanceof Error ? error.message : String(error)}`;
      if (submission.activation !== undefined) {
        // I3: an activation validates before it can ever start a turn (the
        // server route resolves/checks the skill first — item 1), so a
        // failed activation on the session this call just created never
        // leaves a real turn behind, only a permanently useless empty
        // `(untitled)` row (matches the live bug's journal: exactly one
        // `event.session.created` event, nothing else, ever). Delete it
        // with the same primitive the roster's own delete uses, restoring
        // this method's own "validate before mutate" invariant after the
        // fact for the one path (skill activation) that can still fail
        // post-create. A plain-prompt failure is different — the session
        // is legitimately usable and the user may retry into it — so it is
        // left alone; only this branch runs.
        try {
          await this.host.harness.deleteSession(session.id);
        } catch {
          // Best-effort: nothing more to do if the server call itself
          // fails — the local cleanup below still drops the row so it
          // doesn't linger regardless.
        }
        // The delete above is a fresh async gap — re-check staleness the
        // same way every other continuation in this method does.
        if (this.host.state.agentsView === view) {
          view.roster.remove(session.id);
          view.viewSessions.delete(session.id);
          // Fix round 1: the session is reachable (selectable, pinnable,
          // reply-able) from the instant `createSession` above resolves —
          // well before this activation call settles — so `forgetSession`
          // is required here, not optional: a pin taken in that window
          // would otherwise survive to the next launch. See its own doc
          // comment for the full collection list.
          this.forgetSession(view, session.id);
          if (view.selectedId === session.id) view.selectedId = undefined;
          void this.persistState(view);
          this.pushProps();
        }
      }
      if (this.host.state.agentsView !== view) return;
      // B7 can have already detached the roster view (options.attach above)
      // by the time this rejects — flash()'s pushProps() silently no-ops
      // while detached, so the failure needs the same host-level surface
      // handleRename's own catch uses instead of vanishing unseen.
      if (view.detached) this.host.showError(message);
      else this.flash(message);
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
   *
   * The call is fire-and-forget from `dispatch.onSubmit`'s point of view —
   * the reply panel has already closed and focus has already returned to
   * the list by the time this runs — so the row itself carries the truth of
   * whether the send landed: `pendingReplyIds` while outstanding, then
   * either nothing (success — the roster's own `work_changed` fan-out picks
   * up the change) or `replyFailures` (rejection, or the bounded wait in
   * {@link replyRpcTimeoutMs} was exceeded), which persists until the user
   * reopens the reply panel on that row OR {@link settleReplyAttempt} clears
   * it because the RPC the bound gave up on turns out to have succeeded.
   */
  private async handleReply(view: AgentsViewState, targetId: string, text: string): Promise<void> {
    const rpc = this.host.harness.wireRpc();
    if (rpc === undefined) {
      this.flash('Reply failed: replying from the list requires the wire transport');
      return;
    }
    // Same media-placeholder resolution as `handleDispatch`'s plain-prompt
    // path (`extractMediaAttachments`, matching `KimiTUI.
    // sendNormalUserInput`) — before any of this method's own state
    // mutation, so a failed extraction (a pasted video's cache copy
    // vanished/unwritable) reports and sends nothing instead of arming
    // `pendingReplyIds` for a reply that was never going to go out.
    let promptParts: PromptPart[] | undefined;
    try {
      const extraction = extractMediaAttachments(text, this.imageStore);
      if (extraction.hasMedia) promptParts = extraction.parts;
    } catch (error) {
      const message = `Failed to prepare media attachment: ${error instanceof Error ? error.message : String(error)}`;
      this.notifyUser(view, message, { error: true });
      return;
    }
    view.replyFailures.delete(targetId);
    view.pendingReplyIds.add(targetId);
    this.pushProps();

    const attempt = rpc.prompt({ sessionId: targetId, input: promptParts ?? [{ type: 'text', text }] });
    view.replyAttempts.set(targetId, attempt);
    // Keeps observing the RPC for as long as it actually takes, independent
    // of the bounded wait below — a legitimately slow server that succeeds
    // or fails AFTER the client gives up must still correct the row instead
    // of freezing on whatever the bounded wait last wrote.
    attempt.then(
      () => this.settleReplyAttempt(view, targetId, attempt, text, false),
      () => this.settleReplyAttempt(view, targetId, attempt, text, true),
    );

    try {
      await raceTimeout(attempt, replyRpcTimeoutMs());
    } catch (error) {
      // Either `attempt` itself rejected within the bound (the `.then`
      // above already reconciled the maps for that, or is about to on the
      // next microtask — this write is then redundant but harmless), or
      // the bound was exceeded while `attempt` is still running — in that
      // case this IS the only thing that marks the row failed right now;
      // `settleReplyAttempt` fires later, whenever `attempt` really settles.
      if (this.host.state.agentsView !== view) return;
      view.replyFailures.set(targetId, { text });
      view.pendingReplyIds.delete(targetId);
      const row = view.roster.get(targetId);
      const name = row === undefined ? targetId : rosterRowName(row);
      this.flash(`Reply to "${name}" failed: ${error instanceof Error ? error.message : String(error)}`);
      this.pushProps();
    }
  }

  /**
   * The single place that applies a reply attempt's REAL outcome to
   * `pendingReplyIds`/`replyFailures` — called once `attempt` actually
   * settles, whether that happens inside {@link handleReply}'s bounded wait
   * or well after it already gave up (a legitimately slow, not stuck,
   * server). On success this is what corrects a false "reply failed" row
   * left by an exceeded bound; on failure it (re)affirms the failure the
   * bounded wait may already have shown. No-ops once a retry has replaced
   * this attempt for the row — `view.replyAttempts.get(targetId)` no
   * longer points at THIS promise, because a fresh `handleReply` call
   * always overwrites the entry — or the view has been torn down, so a
   * late arrival from a superseded attempt never clobbers a newer one's
   * state (the accepted duplicate-prompt case: the user already saw the
   * failure and chose to retry).
   */
  private settleReplyAttempt(
    view: AgentsViewState,
    targetId: string,
    attempt: Promise<void>,
    text: string,
    failed: boolean,
  ): void {
    if (this.host.state.agentsView !== view) return;
    if (view.replyAttempts.get(targetId) !== attempt) return;
    view.replyAttempts.delete(targetId);
    view.pendingReplyIds.delete(targetId);
    if (failed) view.replyFailures.set(targetId, { text });
    else view.replyFailures.delete(targetId);
    this.pushProps();
  }

  /**
   * Clears reply-panel state (placeholder + `replyTargetId` + the dispatch's
   * `replying` parse-mode flag + any unsent draft text) — called on every
   * editor submit round trip (success or parse-error) and on every panel
   * close. Reply is the same composer as dispatch; only its momentary
   * target, placeholder and input parsing differ, so "leaving the panel" is
   * just resetting those back to the dispatch defaults. The `setText('')`
   * is a no-op after a submit (pi-tui already emptied the editor before
   * calling back) but is what makes a non-submit close (Esc, space-on-empty,
   * Ctrl+X, ↑/↓ — see `closeReplyPanel`) discard an unsent draft instead of
   * leaking it into the next "new session" dispatch.
   */
  private exitReplyMode(view: AgentsViewState): void {
    if (view.replyTargetId === undefined) return;
    view.replyTargetId = undefined;
    view.dispatch.replying = false;
    view.dispatch.editor.setPlaceholder(DISPATCH_PLACEHOLDER);
    view.dispatch.editor.setText('');
  }

  /**
   * The reply panel's single "close" primitive: clears the panel's state
   * (via `exitReplyMode`) and returns focus from the (now-unmounted) panel
   * composer to the roster list. Shared by every way of leaving the panel —
   * a submit (`dispatch.onSubmit`), a parse error (`dispatch.onError`), Esc
   * (the editor's own `onEscape`, wired above), and the component's
   * `onReplyClose` prop callback (space on an empty input, Ctrl+X, ↑/↓ when
   * the editor's autocomplete isn't open — see
   * `AgentsViewApp.handleReplyPanelKey`).
   */
  private closeReplyPanel(view: AgentsViewState): void {
    this.exitReplyMode(view);
    this.unfocusDispatch();
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

  /**
   * Mode-aware group builder (A6) — the single place `buildProps` and the
   * group-delete-all path (`handleDelete`) both read from, so a directory-mode
   * `dir:<workDir>` / `other` group id resolves the same way `completed` /
   * `pinned` already do in state mode. State mode delegates straight to the
   * unchanged, already-tested `AgentsRoster.groups()`; directory mode computes
   * fresh buckets from a live row snapshot via the pure `buildDirectoryGroups`
   * (`agents-view-groups.ts`) — no page-size windowing, no "more" affordance
   * (see that function's own doc for why).
   */
  private currentGroups(
    view: { roster: AgentsRoster; pins: ReadonlySet<string>; groupMode: AgentsGroupMode },
    pageSize?: number,
  ): readonly AgentsGroup[] {
    return view.groupMode === 'directory'
      ? buildDirectoryGroups(view.roster.allRows(), view.pins)
      : view.roster.groups(pageSize);
  }

  private buildProps(view: {
    roster: AgentsRoster;
    pins: ReadonlySet<string>;
    dispatch: AgentsViewDispatch;
    dispatchFocused: boolean;
    replyTargetId: string | undefined;
    pendingReplyIds: ReadonlySet<string>;
    replyFailures: ReadonlyMap<string, { text: string }>;
    selectedId: string | undefined;
    originSessionId: string | undefined;
    confirmDeleteId: string | undefined;
    armedDeleteId: string | undefined;
    armedDeleteStopped: boolean;
    armedDeleteFreeze:
      | { busy: boolean; pendingInteraction: AgentsRosterRow['pendingInteraction']; updatedAt: number }
      | undefined;
    renameDraft: { sessionId: string; text: string } | undefined;
    flashMessage: string | undefined;
    pendingExitTimer: ReturnType<typeof setTimeout> | undefined;
    collapsedGroups: ReadonlySet<string>;
    completedExpanded: boolean;
    groupMode: AgentsGroupMode;
  }): AgentsViewProps {
    const pageSize = view.completedExpanded ? Number.MAX_SAFE_INTEGER : undefined;
    // B1: an armed row's group/sort position freezes across whatever this
    // particular buildProps call would otherwise recompute it to (a live
    // event or WS-reconnect reseed landing mid-arm) — see `withFrozenRow`'s
    // own doc for why patching the row in place, for the duration of this
    // one `currentGroups` call, is what makes that hold for both grouping
    // strategies without either needing its own override parameter.
    const rawGroups =
      view.armedDeleteId !== undefined && view.armedDeleteFreeze !== undefined
        ? view.roster.withFrozenRow(view.armedDeleteId, view.armedDeleteFreeze, () =>
            this.currentGroups(view, pageSize),
          )
        : this.currentGroups(view, pageSize);
    const groups = rawGroups.map((group): AgentsGroup => {
      if (!view.collapsedGroups.has(group.id)) return group;
      return { id: group.id, label: group.label, rows: [], collapsedCount: group.rows.length };
    });
    return {
      groups,
      // B10: which empty-roster rendering `groups === []` gets — the
      // component itself stays mode-unaware, this is the one pre-computed
      // signal it reads to pick between the two.
      emptyGroupsDisplay: view.groupMode === 'directory' ? 'plain' : 'skeleton',
      counts: view.roster.counts(),
      selectedId: view.selectedId,
      originId: view.originSessionId,
      attachedIds: this.attachedSessionIds,
      serverLabel: this.host.agentsViewServerLabel(),
      sessionsSurviveExit: this.host.agentsViewSessionsSurviveExit(),
      modelLabel: this.host.agentsViewModelLabel(),
      confirmDeleteId: view.confirmDeleteId,
      armedDeleteId: view.armedDeleteId,
      armedDeleteStopped: view.armedDeleteStopped,
      renameDraft: view.renameDraft,
      flashMessage: view.flashMessage,
      dispatchFocused: view.dispatchFocused,
      dispatchEditor: view.dispatch.editor,
      replyTargetId: view.replyTargetId,
      pendingReplyIds: view.pendingReplyIds,
      replyFailureIds: new Set(view.replyFailures.keys()),
      pendingExitArmed: view.pendingExitTimer !== undefined,
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

  /** Clears a pending GROUP delete confirm; returns true when one was
   *  pending. See `clearArmedDelete` for the B1 row-arm equivalent. */
  private clearConfirm(view: AgentsViewState): boolean {
    if (view.confirmDeleteId === undefined) return false;
    view.confirmDeleteId = undefined;
    return true;
  }

  /**
   * B1: clears a pending ROW Ctrl+X arm (timer included) — the confirm, an
   * Esc cancel, any other action callback, or the timer's own expiry all
   * route through here (see `AgentsViewState.armedDeleteTimer`'s own doc
   * for why the controller, not the component, owns it). Returns true when
   * an arm was pending.
   */
  private clearArmedDelete(view: AgentsViewState): boolean {
    if (view.armedDeleteId === undefined) return false;
    if (view.armedDeleteTimer !== undefined) clearTimeout(view.armedDeleteTimer);
    view.armedDeleteId = undefined;
    view.armedDeleteStopped = false;
    view.armedDeleteTimer = undefined;
    view.armedDeleteFreeze = undefined;
    return true;
  }

  /**
   * Clears whichever delete overlay is currently active — the group-header
   * confirm dialog OR a row's Ctrl+X arm (B1); the two are mutually
   * exclusive, so at most one of `clearConfirm`/`clearArmedDelete` ever
   * actually clears anything, but both run unconditionally rather than
   * short-circuiting so neither can be left dangling by an assumption that
   * turns out wrong. Returns true if either was cleared — the shared "any
   * other action" signal every `buildCallbacks` entry and
   * `quitOrCancelConfirm` use.
   */
  private clearDeleteOverlays(view: AgentsViewState): boolean {
    const clearedConfirm = this.clearConfirm(view);
    const clearedArm = this.clearArmedDelete(view);
    return clearedConfirm || clearedArm;
  }

  /**
   * The shared "actually leave" path behind both `onQuit` and a confirming
   * second Ctrl+C: a pending delete overlay (group confirm OR row arm)
   * still absorbs it as a cancel first (matches Ctrl+X's own confirm/arm
   * flow), otherwise closes the view.
   */
  private quitOrCancelConfirm(view: AgentsViewState): void {
    if (this.clearDeleteOverlays(view)) {
      this.pushProps();
      return;
    }
    this.close();
  }

  /**
   * The controller's own two-stage confirm-to-exit state machine — arm vs.
   * quit is decided by whether a timer is already running. The timer (not
   * the component) owns the auto-disarm because only the controller has
   * `state.ui.requestRender()` to repaint on a silent timeout.
   *
   * Shared by every Ctrl+C source: the roster itself (`buildCallbacks`'s
   * `onCtrlC`, list-focused) and the dispatch composer (`dispatch.editor.
   * onCtrlC`, wired in `show()` — reached identically whether the composer
   * targets a new dispatch or an open reply panel, since both share the one
   * `dispatch.editor` instance). Deliberately does not touch
   * `dispatchFocused`/`replyTargetId`: matching the class docstring's own
   * "Ctrl+C is independent of Esc/origin" invariant, closing a focused
   * composer or reply panel is Esc's job, not Ctrl+C's.
   *
   * I5: a delete overlay (row arm or header confirm) is not a modal for
   * Ctrl+C's own two-stage exit — unlike Esc (`onQuit`, via
   * `quitOrCancelConfirm`), which still absorbs a confirming Ctrl+C as an
   * arm-cancel if the overlay is still up at that point. Clearing it HERE,
   * on the first press, is what keeps the two from ever colliding: by the
   * time a second Ctrl+C reaches `quitOrCancelConfirm` below, there is
   * nothing left for it to absorb, so it really exits — matching the
   * footer's own promise instead of silently cancelling the arm on what the
   * user was told was the confirming press.
   */
  private triggerCtrlC(view: AgentsViewState): void {
    if (view.pendingExitTimer !== undefined) {
      clearTimeout(view.pendingExitTimer);
      view.pendingExitTimer = undefined;
      this.quitOrCancelConfirm(view);
      return;
    }
    this.clearDeleteOverlays(view);
    view.pendingExitTimer = setTimeout(() => {
      const current = this.host.state.agentsView;
      if (current === undefined || current.pendingExitTimer === undefined) return;
      current.pendingExitTimer = undefined;
      this.pushProps();
    }, EXIT_CONFIRM_WINDOW_MS);
    this.pushProps();
  }

  /**
   * B1: first Ctrl+X on a roster ROW — arms it in place instead of opening
   * the group-header's confirm dialog. A BUSY row's turn is stopped
   * immediately, optimistically (the summary already reads `stopped · ...`
   * before the RPC settles — see `rows.ts`'s `RowDeleteArm`), reusing the
   * same session-id-scoped cancel A3's attach-mode Ctrl+C already routes
   * through (`KimiHarness.cancelSession`, no attach/local `Session` cache
   * required — this row was very likely never attached in this process at
   * all). Captures the row's current classify-relevant fields so
   * `buildProps` can freeze its group/sort position for as long as the arm
   * lasts (`AgentsRoster.withFrozenRow`), and starts the
   * `DELETE_ARM_WINDOW_MS` auto-expire timer. Declines a still-dispatching
   * A2 placeholder the same way every other row action does (checked by
   * the caller, `onDeleteRequest`, before this is reached).
   */
  private armDelete(view: AgentsViewState, id: string): void {
    const row = view.roster.get(id);
    if (row === undefined) return;
    if (view.armedDeleteTimer !== undefined) clearTimeout(view.armedDeleteTimer);
    view.armedDeleteId = id;
    view.armedDeleteStopped = row.busy;
    view.armedDeleteFreeze = {
      busy: row.busy,
      pendingInteraction: row.pendingInteraction,
      updatedAt: row.updatedAt,
    };
    view.armedDeleteTimer = setTimeout(() => {
      const current = this.host.state.agentsView;
      if (current === undefined || current.armedDeleteId !== id) return;
      this.clearArmedDelete(current);
      this.pushProps();
    }, DELETE_ARM_WINDOW_MS);
    if (row.busy) {
      void this.host.harness.cancelSession(id).catch((error: unknown) => {
        // Same staleness guard as `persistGroupMode`/`handleDelete`'s own
        // async continuations: `view` is captured at arm time, but the
        // rejection can land after the user has closed AND reopened the
        // agents view (a fresh `AgentsViewState`) — without this check a
        // stale "Failed to stop" toast would bleed into that new view.
        if (this.host.state.agentsView !== view) return;
        this.flash(`Failed to stop: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    this.pushProps();
  }

  /**
   * The single "open" handler for an id from the roster: a row attaches
   * (hands off to `host.onOpenSession`), `more:completed` expands the
   * truncated Completed band, and a `group:<id>` toggles that group's
   * collapse — same three-way dispatch Enter/→ on the list already used
   * inline here before B8 extracted it. `AgentsViewProps.onOpen` (Enter/→ on
   * a row or header, alt+1..9, the reply panel's empty-Enter) and the
   * dispatch composer's B8 →-on-empty hook (`AgentsViewHost.show`'s
   * `dispatch.editor.onRightArrowEmpty`) both call this directly — one
   * attach entry point, not a parallel implementation.
   */
  private handleOpen(id: string): void {
    const view = this.host.state.agentsView;
    if (view === undefined) return;
    this.clearDeleteOverlays(view);
    if (id === 'more:completed') {
      view.completedExpanded = true;
      this.pushProps();
      return;
    }
    if (id.startsWith('group:')) {
      const groupId = id.slice('group:'.length);
      if (view.collapsedGroups.has(groupId)) view.collapsedGroups.delete(groupId);
      else view.collapsedGroups.add(groupId);
      this.pushProps();
      return;
    }
    // A2 placeholder: has no real session behind it yet — attaching
    // would hand the host an id no session actually owns.
    if (isPendingDispatchId(id)) {
      this.notifyUser(view, DISPATCHING_HINT);
      return;
    }
    if (this.host.onOpenSession !== undefined) {
      // Attaching a row reaffirms its registry membership (in practice it
      // is already registered — the roster only lists registry rows).
      view.viewSessions.add(id);
      // Opening a row is the only thing that clears its unseen bit.
      view.roster.markSeen(id);
      // B2: the footer's open→return verb flip — recorded at the point
      // the attach actually succeeds, not on keypress.
      this.attachedSessionIds.add(id);
      void this.persistState(view);
      this.host.onOpenSession(id);
    } else {
      this.notifyUser(view, 'Attach is not available from this host');
    }
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
    | 'onReplyClose'
    | 'onReorderPinned'
    | 'onHelpToggle'
    | 'onQuit'
    | 'onCtrlC'
    | 'onDispatchFocusChange'
    | 'onGroupModeToggle'
  > {
    return {
      onSelect: (id) => {
        const view = this.host.state.agentsView;
        if (view === undefined) return;
        view.selectedId = id === '' ? undefined : id;
        if (this.clearDeleteOverlays(view)) this.pushProps();
      },
      onOpen: (id) => {
        this.handleOpen(id);
      },
      onDeleteRequest: (id) => {
        const view = this.host.state.agentsView;
        if (view === undefined) return;
        // A2 placeholder: nothing server-side to archive yet — see
        // `handleDispatch`'s own failure path for how a placeholder that
        // never becomes a real session is cleaned up instead.
        if (isPendingDispatchId(id)) {
          this.notifyUser(view, DISPATCHING_HINT);
          return;
        }
        // Group-header delete-all keeps the existing confirm-dialog flow —
        // B1 only replaces the ROW path below with the inline arm.
        if (id.startsWith('group:')) {
          view.confirmDeleteId = id;
          this.pushProps();
          return;
        }
        this.armDelete(view, id);
      },
      onDeleteConfirm: (id) => {
        // Shared by both delete overlays' second press: `id` is either the
        // pending `confirmDeleteId` (group) or `armedDeleteId` (B1, row) —
        // `AgentsViewApp.handleInput` only ever calls this with whichever
        // one is actually set, so clearing both defensively is safe and
        // keeps this callback from needing to know which one it was.
        const view = this.host.state.agentsView;
        if (view === undefined) return;
        this.clearDeleteOverlays(view);
        this.pushProps();
        void this.handleDelete(id);
      },
      onRenameBegin: (id) => {
        const view = this.host.state.agentsView;
        if (view === undefined) return;
        this.clearDeleteOverlays(view);
        if (isPendingDispatchId(id)) {
          this.notifyUser(view, DISPATCHING_HINT);
          return;
        }
        const row = view.roster.get(id);
        if (row === undefined) return;
        view.renameDraft = { sessionId: id, text: row.title };
        this.pushProps();
      },
      onRenameSubmit: (id, text) => {
        const view = this.host.state.agentsView;
        if (view === undefined) return;
        this.clearDeleteOverlays(view);
        view.renameDraft = undefined;
        // A2 placeholder: `onRenameBegin` already declines starting a rename
        // on one, but the component's OWN inline rename editor is a local
        // toggle it can enter on any row without asking the controller
        // first (`Ctrl+R` sets its `this.rename` unconditionally) — this is
        // the backstop that keeps a rename typed against that local state
        // from ever reaching `harness.renameSession` with a fabricated id.
        if (isPendingDispatchId(id)) {
          this.pushProps();
          return;
        }
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
        this.clearDeleteOverlays(view);
        // A2 placeholder: pinning would persist the fabricated id into the
        // pins Set — it never survives the promotion to the real id.
        if (isPendingDispatchId(id)) {
          this.notifyUser(view, DISPATCHING_HINT);
          return;
        }
        void this.handlePinToggle(id);
      },
      onReplyRequest: (id) => {
        const view = this.host.state.agentsView;
        if (view === undefined) return;
        this.clearDeleteOverlays(view);
        if (isPendingDispatchId(id)) {
          this.notifyUser(view, DISPATCHING_HINT);
          return;
        }
        const row = view.roster.get(id);
        if (row === undefined) return;
        view.replyTargetId = id;
        view.dispatch.replying = true;
        view.dispatchFocused = true;
        view.dispatch.editor.focused = true;
        // Fixed literal, not `reply to <name>` — the panel itself already
        // shows the row's preview/age content (see `renderReplyPanel`), so
        // the composer placeholder doesn't need to repeat the name too.
        view.dispatch.editor.setPlaceholder('reply');
        // A row re-entered from its failed state recovers the text that
        // never made it through instead of forcing the user to retype it.
        const failure = view.replyFailures.get(id);
        if (failure !== undefined) {
          view.replyFailures.delete(id);
          view.dispatch.editor.setText(failure.text);
        }
        this.pushProps();
      },
      onReplyClose: () => {
        const view = this.host.state.agentsView;
        if (view === undefined) return;
        this.closeReplyPanel(view);
      },
      onReorderPinned: (id, delta) => {
        const view = this.host.state.agentsView;
        if (view === undefined) return;
        this.clearDeleteOverlays(view);
        // Re-anchor selection onto the row BEFORE reordering + pushing props,
        // rather than trusting `view.selectedId` already matches `id` (the
        // caller only invokes this for the currently-selected row, but
        // nothing before this line enforces that `view.selectedId` agrees —
        // an intervening push with a not-yet-resolved `selectedId` (e.g. a
        // WS-reconnect `refreshRoster` landing between the row being
        // selected and this keypress) leaves `view.selectedId` stale/
        // undefined while the component's own on-screen cursor hasn't
        // moved; `syncSelectionFromProps` then falls back to that stale
        // index into the POST-reorder row array, which can land the ❯
        // marker on the group header or the wrong row instead of following
        // the one just moved). Setting it explicitly here makes the reorder
        // action own its own "selection follows the moved row" contract
        // instead of depending on an ambient invariant maintained elsewhere.
        view.selectedId = id;
        view.roster.reorderPinned(id, delta);
        this.pushProps();
        void this.persistState(view);
      },
      onHelpToggle: () => {
        const view = this.host.state.agentsView;
        if (view === undefined) return;
        if (this.clearDeleteOverlays(view)) this.pushProps();
      },
      onQuit: () => {
        const view = this.host.state.agentsView;
        if (view === undefined) return;
        // Esc during a delete confirm or arm cancels it, not the view.
        this.quitOrCancelConfirm(view);
      },
      // Every Ctrl+C press reports here unconditionally — the arm/quit state
      // machine itself lives in `triggerCtrlC` (shared with the dispatch
      // composer's own Ctrl+C, wired in `show()`).
      onCtrlC: () => {
        const view = this.host.state.agentsView;
        if (view === undefined) return;
        this.triggerCtrlC(view);
      },
      onDispatchFocusChange: (focused) => {
        const view = this.host.state.agentsView;
        if (view === undefined || view.dispatchFocused === focused) return;
        view.dispatchFocused = focused;
        view.dispatch.editor.focused = focused;
        this.pushProps();
      },
      // Ctrl+S (A6), roster-only — the component only reaches this while no
      // overlay (rename/dispatch-focused/help) is open (see its own
      // `handleInput` doc). `view.selectedId` is deliberately left untouched:
      // it is still a valid row id in the new mode's groups (A5's own
      // "selection follows by row id" contract, reused as-is — `AgentsViewApp.
      // syncSelectionFromProps` re-finds it in the freshly rebuilt items list
      // on the very next `setProps`), so re-anchoring it here would be both
      // redundant and wrong the one time it WOULD matter (a row paginated out
      // of view — same pre-existing fallback every other reshuffle already
      // has, not something this action needs to special-case).
      onGroupModeToggle: () => {
        const view = this.host.state.agentsView;
        if (view === undefined) return;
        this.clearDeleteOverlays(view);
        view.groupMode = view.groupMode === 'state' ? 'directory' : 'state';
        this.pushProps();
        void this.persistGroupMode(view, view.groupMode);
      },
    };
  }

  /**
   * M1/I3-follow-up: `AgentsRoster.remove` drops only the row — pins/seenAt
   * and the reply bookkeeping are separate persisted Sets/Maps the
   * controller owns (see their own `AgentsViewState` doc comments) and are
   * never pruned on their own, so a discarded id would otherwise linger in
   * them forever (a pin on it would even survive to the next launch via
   * `persistState`). Shared by every path that permanently discards a
   * session id — `handleDelete` and the activation-failure cleanup in
   * `handleDispatch` — so this list can't drift between them again; it
   * already had once. Callers still own their own roster/`viewSessions`
   * removal, selection fix-up, `persistState`, and flash copy — this is the
   * collection pruning only.
   */
  private forgetSession(view: AgentsViewState, id: string): void {
    view.pins.delete(id);
    view.seenAt.delete(id);
    view.pendingReplyIds.delete(id);
    view.replyFailures.delete(id);
    view.replyAttempts.delete(id);
    view.replyBarriers.delete(id);
  }

  private async handleDelete(id: string): Promise<void> {
    const view = this.host.state.agentsView;
    if (view === undefined) return;
    // `onDeleteRequest` already declines a bare placeholder id (see its own
    // guard) — this only remains reachable via a GROUP delete below, where
    // the filter is what actually matters: `deleteSession` has nothing
    // server-side to archive for a row that hasn't become a real session yet.
    if (isPendingDispatchId(id)) return;

    const ids: readonly string[] = id.startsWith('group:')
      ? (this.currentGroups(view, Number.MAX_SAFE_INTEGER)
          .find((group) => group.id === id.slice('group:'.length))
          ?.rows.map((row) => row.id)
          .filter((rowId) => !isPendingDispatchId(rowId)) ?? [])
      : [id];
    if (ids.length === 0) return;

    let failed = 0;
    let removed = 0;
    for (const sessionId of ids) {
      try {
        await this.host.harness.deleteSession(sessionId);
        view.roster.remove(sessionId);
        view.viewSessions.delete(sessionId);
        this.forgetSession(view, sessionId);
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
      this.notifyUser(view, `Rename failed: ${error instanceof Error ? error.message : String(error)}`, {
        error: true,
      });
      this.pushProps();
    }
  }

  private async handlePinToggle(id: string): Promise<void> {
    const view = this.host.state.agentsView;
    if (view === undefined) return;
    const row = view.roster.get(id);
    if (row === undefined) return;
    // Same re-anchor as `onReorderPinned` (agents-view.ts, shift+↑↓): `id` is
    // always the component's currently-selected row (Ctrl+T only fires for
    // `item.kind === 'row'`), and toggling pin RELOCATES it — into a new
    // `Pinned` group, or out of one — exactly the kind of index-shifting
    // move whose "selection follows" contract must not depend on
    // `view.selectedId` already agreeing with the on-screen cursor.
    view.selectedId = id;
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
   * I7: registers a single session id into the on-disk registry directly —
   * for a `handleDispatch` success landing after the view has closed
   * entirely, where there is no live `AgentsViewState` left to snapshot and
   * writing a dead view's own (possibly stale) `pins`/`seenAt` would risk
   * clobbering whatever is actually on disk. Reads the CURRENT file, adds
   * `id` to its session set, writes it back — same {@link persistChain}
   * serialization {@link persistState} uses, so the two can never race or
   * land out of order. Best-effort: there is no view left to flash a
   * failure against.
   */
  private persistOrphanedSessionId(id: string): Promise<void> {
    this.persistChain = this.persistChain.then(async () => {
      try {
        const current = await loadAgentsViewState(this.host.harness.homeDir);
        await saveAgentsViewState(this.host.harness.homeDir, {
          pins: current.pins,
          sessions: new Set([...current.sessions, id]),
          seenAt: current.seenAt,
        });
      } catch {
        // Nothing left to flash against — see the doc comment above.
      }
    });
    return this.persistChain;
  }

  /** Same "never overlap, coalesce bursts" reasoning as {@link persistChain},
   *  kept as its own chain: it writes a different file (`tui.toml` via
   *  {@link AgentsViewHost.saveAgentsViewGroupMode}) than {@link persistState}
   *  does, so there is nothing for the two to serialize against each other. */
  private groupModePersistChain: Promise<void> = Promise.resolve();

  /** Persist a Ctrl+S grouping-mode change; failures flash, never throw. */
  private persistGroupMode(view: AgentsViewState, mode: AgentsGroupMode): Promise<void> {
    this.groupModePersistChain = this.groupModePersistChain.then(async () => {
      try {
        await this.host.saveAgentsViewGroupMode(mode);
      } catch (error) {
        if (this.host.state.agentsView !== view) return;
        this.flash(
          `Failed to persist view mode: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    return this.groupModePersistChain;
  }

  /**
   * Spinner heartbeat: roster events are rare (busy on / busy off), so while
   * any row is working a repaint every {@link SPINNER_FRAME_MS} keeps the
   * spinner animating at the same cadence `rows.ts`'s frame selection
   * advances on (B5) — same constant, imported rather than a second copy of
   * `120`. Runs only while the component is mounted; detach / close / an
   * idle roster stops it.
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
      }, SPINNER_FRAME_MS);
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

  /**
   * Routes a status/error message to whichever surface can actually show it
   * right now. While the roster owns the screen (`view` is mounted, not
   * detached) `host.showStatus`/`showError` render into a UI-tree child
   * `show()`'s own `state.ui.clear()` already detached — nothing would
   * appear until the view eventually closes and flushes it stale into the
   * chat. `flash()` is the view's own visible channel, so this uses that
   * instead. While detached (an attached session owns the screen) or not
   * open at all, `flash()`'s `pushProps()` silently no-ops (or there is no
   * view to push props to) — this falls back to `host.showStatus`/
   * `showError`, the surface actually on screen. Same inverse rule
   * `handleDispatch`'s own catch (around its `createSession` call) already
   * applies for its dispatch-failure message. `view` is read live by
   * callers rather than captured across an `await` — the one caller outside
   * this class (`KimiTUI.attachAgentsViewSession`'s pre-`detachForAttach`
   * resume failure) holds no `AgentsViewState` reference of its own and
   * reads `this.state.agentsView` (the same object, via `AgentsViewHost`)
   * fresh at the call site instead.
   */
  notifyUser(view: AgentsViewState | undefined, message: string, options: { error?: boolean } = {}): void {
    if (view !== undefined && !view.detached) {
      this.flash(message);
      return;
    }
    if (options.error === true) this.host.showError(message);
    else this.host.showStatus(message);
  }
}
