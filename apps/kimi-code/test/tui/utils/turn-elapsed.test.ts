import { describe, expect, it } from 'vitest';

import { formatTurnElapsed, formatTurnElapsedSuffix } from '#/tui/utils/turn-elapsed';

describe('formatTurnElapsed', () => {
  it.each([
    [0, '0s'],
    [59_000, '59s'],
    [60_000, '1m0s'],
    [61_000, '1m1s'],
    [3_661_000, '61m1s'],
  ])('formats %ims as %s', (ms, expected) => {
    expect(formatTurnElapsed(ms)).toBe(expected);
  });

  it('has no leading zeros or decimals', () => {
    expect(formatTurnElapsed(4_000)).toBe('4s');
    expect(formatTurnElapsed(64_000)).toBe('1m4s');
    expect(formatTurnElapsed(4_500)).toBe('4s');
  });

  it('never goes negative for a clock reading slightly ahead of the origin', () => {
    expect(formatTurnElapsed(-50)).toBe('0s');
  });
});

describe('formatTurnElapsedSuffix', () => {
  it('renders a leading space and no marker when exact', () => {
    expect(formatTurnElapsedSuffix(14_000, false)).toBe(' 14s');
  });

  it('appends a trailing + when approximate', () => {
    expect(formatTurnElapsedSuffix(8_000, true)).toBe(' 8s+');
  });
});
