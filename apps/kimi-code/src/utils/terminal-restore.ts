/**
 * Best-effort terminal restoration for crash / emergency-exit paths.
 *
 * The normal shutdown path goes through pi-tui's `TUI.stop()`, which restores
 * raw mode, the cursor, bracketed paste, the Kitty / modifyOtherKeys
 * keyboard protocols, and mouse tracking. When we bail out without running
 * `TUI.stop()` — an uncaught exception, a SIGTERM whose cleanup throws, or a
 * SIGHUP — the terminal would otherwise be left stuck in raw mode with a
 * hidden cursor (and, if the crash landed while the agents view was mounted,
 * captured mouse input breaking native text selection), and the user's shell
 * would look broken afterwards. Writing these sequences lets the terminal
 * recover.
 *
 * Every step is wrapped: the terminal may already be dead (EIO), and an exit
 * path must never throw.
 */

// Show cursor (`?25h`), disable bracketed paste (`?2004l`), pop the Kitty
// keyboard protocol (`<u`), reset modifyOtherKeys (`>4;0m`), and turn off SGR
// mouse tracking (`?1006l` then `?1000l` — see ProcessTerminal.
// disableMouseTracking, whose exact sequence this mirrors so a crash mid-way
// through the agents view's mount window still leaves the terminal usable).
const TERMINAL_RESTORE_SEQUENCE =
	'\u001B[?25h\u001B[?2004l\u001B[<u\u001B[>4;0m\u001B[?1006l\u001B[?1000l';

export function restoreTerminalModes(): void {
  try {
    process.stdin.setRawMode(false);
  } catch {
    // ignore — raw mode may not be active, or stdin may not be a TTY.
  }
  try {
    process.stdout.write(TERMINAL_RESTORE_SEQUENCE);
  } catch {
    // ignore — the terminal may already be dead (EIO).
  }
}
