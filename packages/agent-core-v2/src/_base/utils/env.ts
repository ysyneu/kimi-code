/**
 * Parse environment-variable string values into typed primitives.
 */

const TRUE_BOOLEAN_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_BOOLEAN_ENV_VALUES = new Set(['0', 'false', 'no', 'off']);

export function parseBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0) return undefined;
  if (TRUE_BOOLEAN_ENV_VALUES.has(normalized)) return true;
  if (FALSE_BOOLEAN_ENV_VALUES.has(normalized)) return false;
  return undefined;
}

/** Parses an integer env var; falls back to `fallback` when unset,
 *  non-numeric, or below `min`. */
export function parseIntegerEnv(value: string | undefined, fallback: number, min = 0): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}
