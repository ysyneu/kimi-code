/**
 * Promise timing helpers: `timeoutOutcome` resolves with a fixed fallback
 * value after a delay (clearable); `raceTimeout` is its reject-on-timeout
 * counterpart, for callers that want a clear error instead of a fallback
 * value when a promise doesn't settle in time.
 */

const NEVER = new Promise<never>(() => {});

export type TimeoutOutcomePromise<Outcome> = Promise<Outcome> & {
  clear(): void;
};

export function timeoutOutcome<Outcome>(
  timeoutMs: number | undefined,
  outcome: Outcome,
): TimeoutOutcomePromise<Outcome> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const promise: Promise<Outcome> =
    timeoutMs === undefined || timeoutMs <= 0
      ? NEVER
      : new Promise((resolve) => {
          timeout = setTimeout(() => {
            timeout = undefined;
            resolve(outcome);
          }, timeoutMs);
        });

  return Object.assign(promise, {
    clear() {
      if (timeout === undefined) return;
      clearTimeout(timeout);
      timeout = undefined;
    },
  });
}

/**
 * Bounds `promise` to `timeoutMs`: rejects with `onTimeout()`'s error if it
 * hasn't settled in time. The loser is left to settle in the background,
 * unobserved — this never touches or cancels `promise`, only bounds how
 * long the caller waits on it. Same `Promise.race` + timer shape already
 * used for RPC-style waits elsewhere in this codebase (client and server
 * side alike); pulled here once a second real call site needed it.
 */
export async function raceTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(onTimeout());
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
