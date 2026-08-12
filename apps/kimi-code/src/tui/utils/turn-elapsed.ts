/**
 * Formats how long the current turn has been running, for the live status
 * line (`⠋ thinking... 14s`). `<60s` renders as `Ns`; `>=60s` renders as
 * `NmSs`. No leading zeros, no decimals — this is a coarse "still working"
 * signal, not a stopwatch.
 */
export function formatTurnElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds}s`;
}

/**
 * The elapsed suffix as it appears trailing a status line: a leading space,
 * then the formatted duration. `approximate` appends a trailing `+` — used
 * when attaching to a turn already in flight, where the real start predates
 * this client's subscription and the clock instead starts at attach time
 * ("at least this long", never a fabricated age).
 */
export function formatTurnElapsedSuffix(elapsedMs: number, approximate: boolean): string {
  return ` ${formatTurnElapsed(elapsedMs)}${approximate ? '+' : ''}`;
}
