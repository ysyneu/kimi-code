/**
 * Scenario: agents-view roster row rendering.
 * Responsibilities: the fixed-width `glyph name summary meta` row layout,
 * the lastAssistantText → lastPrompt fallback, the no-cwd/no-duplicate
 * rules, the busy/unseen/seen status glyph, the ping-pong spinner, and the
 * selected/isOrigin styling split (full-row background on selection, bold
 * name on isOrigin — independent, composable flags; see rows.ts's doc
 * comment).
 * Wiring: pure function, no TUI/component harness needed.
 * Run: pnpm exec vitest run test/tui/components/agents-view-rows.test.ts
 */
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentsRosterRow } from '@/tui/agents/roster';
import {
  formatRelativeTime,
  renderGroupHeader,
  renderMoreRow,
  renderRosterRow,
  spinnerFrames,
} from '@/tui/components/agents-view/rows';
import { darkColors } from '@/tui/theme/colors';

// This file asserts exact lengths and column offsets, so (unlike the
// sibling test files' substring-only checks) the ESC byte has to be
// stripped too, not just the trailing `[...m`.
const ANSI_SGR = /\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

// Bold-vs-plain assertions need chalk actually emitting SGR codes — the
// test process is not a TTY, so chalk auto-detects level 0 without this.
const previousChalkLevel = chalk.level;
beforeAll(() => {
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = previousChalkLevel;
});

/** True when the raw (unstripped) line carries a bold SGR code anywhere. */
const BOLD_SGR = /\[1m/;
function isBold(rawLine: string): boolean {
  return BOLD_SGR.test(rawLine);
}

/** True when the raw (unstripped) line carries a truecolor background SGR
 *  code anywhere -- chalk.bgHex always emits the 48;2;r;g;b form. */
const BG_SGR = /\[48;2;/;
function hasBg(rawLine: string): boolean {
  return BG_SGR.test(rawLine);
}

/** pointer (2 cols) + glyph (1 col) + space (1 col) — constant either state. */
const PREFIX_WIDTH = 4;
const NAME_WIDTH = 42;

function row(overrides: Partial<AgentsRosterRow> = {}): AgentsRosterRow {
  return {
    id: 's1',
    title: 's1 title',
    workDir: '/home/user/project',
    updatedAt: Date.now(),
    busy: false,
    pendingInteraction: 'none',
    pinned: false,
    unseen: false,
    ...overrides,
  };
}

describe('renderRosterRow', () => {
  it('renders name, assistant summary, and time in order, with no cwd', () => {
    const line = strip(
      renderRosterRow(row({ lastAssistantText: 'the answer is 42', updatedAt: Date.now() }), false, false, 80),
    );

    const nameIdx = line.indexOf('s1 title');
    const summaryIdx = line.indexOf('the answer is 42');
    const timeIdx = line.indexOf('just now');
    expect(nameIdx).toBeGreaterThan(-1);
    expect(summaryIdx).toBeGreaterThan(nameIdx);
    expect(timeIdx).toBeGreaterThan(summaryIdx);
    expect(line).not.toContain('project');
    expect(line).not.toContain('/home/user');
  });

  it('falls back to lastPrompt when lastAssistantText is absent (older sessions)', () => {
    const line = strip(renderRosterRow(row({ lastPrompt: 'do the thing' }), false, false, 80));
    expect(line).toContain('do the thing');
  });

  it('prefers lastAssistantText over lastPrompt when both are present', () => {
    const line = strip(
      renderRosterRow(row({ lastPrompt: 'the prompt', lastAssistantText: 'the reply' }), false, false, 80),
    );
    expect(line).toContain('the reply');
    expect(line).not.toContain('the prompt');
  });

  it('leaves the summary blank when title === lastPrompt (single-turn auto-title)', () => {
    const line = strip(
      renderRosterRow(row({ title: 'fix the flaky test', lastPrompt: 'fix the flaky test' }), false, false, 80),
    );
    expect(line.indexOf('fix the flaky test')).toBe(line.lastIndexOf('fix the flaky test'));
  });

  it('normalizes a multi-line title for both the rendered row and the lastPrompt dedup', () => {
    // kap-server accepts multi-line titles; the row must still render as one
    // line, and the dedup below must still match a single-line lastPrompt.
    const line = strip(
      renderRosterRow(row({ title: 'fix the\nflaky test', lastPrompt: 'fix the flaky test' }), false, false, 80),
    );
    expect(line).toContain('fix the flaky test');
    expect(line).not.toContain('\n');
    expect(line.indexOf('fix the flaky test')).toBe(line.lastIndexOf('fix the flaky test'));
  });

  it('leaves the summary blank when an untitled row already used lastPrompt as its name', () => {
    // The name itself falls back to lastPrompt when title is empty; the
    // summary must not re-show the same text as a second copy.
    const line = strip(renderRosterRow(row({ title: '', lastPrompt: 'summarize the logs' }), false, false, 80));
    expect(line.indexOf('summarize the logs')).toBe(line.lastIndexOf('summarize the logs'));
  });

  it('shows no summary segment when neither field is set', () => {
    const line = strip(renderRosterRow(row(), false, false, 80));
    expect(line).toContain('s1 title');
  });
});

describe('renderRosterRow — fixed 42-col name slot', () => {
  it.each([
    ['short', 5],
    ['a name of medium length here', 29],
    ['x'.repeat(40), 40],
  ])('left-pads "%s" (%i chars) so name + gap = 42', (name, length) => {
    const line = strip(renderRosterRow(row({ title: name }), false, false, 120));
    const nameField = line.slice(PREFIX_WIDTH, PREFIX_WIDTH + NAME_WIDTH);
    expect(nameField).toHaveLength(NAME_WIDTH);
    expect(nameField.startsWith(name)).toBe(true);
    const gap = nameField.slice(length);
    expect(gap).toBe(' '.repeat(NAME_WIDTH - length));
    expect(length + gap.length).toBe(NAME_WIDTH);
  });

  it('ellipsis-truncates a name longer than 42 columns to exactly 42, mid-word', () => {
    const longName = 'refactor the nightly report generation pipeline';
    const line = strip(renderRosterRow(row({ title: longName }), false, false, 120));
    const nameField = line.slice(PREFIX_WIDTH, PREFIX_WIDTH + NAME_WIDTH);
    expect(nameField).toHaveLength(NAME_WIDTH);
    expect(nameField.endsWith('…')).toBe(true);
    expect(nameField).toBe(`${longName.slice(0, NAME_WIDTH - 1)}…`);
  });

  it('the name slot starts at the same column whether the row is selected or not', () => {
    const selectedLine = strip(renderRosterRow(row({ title: 'abc' }), true, false, 120));
    const plainLine = strip(renderRosterRow(row({ title: 'abc' }), false, false, 120));
    expect(selectedLine.indexOf('abc')).toBe(plainLine.indexOf('abc'));
    expect(plainLine.indexOf('abc')).toBe(PREFIX_WIDTH);
  });
});

describe('renderRosterRow — summary truncates, meta never does', () => {
  it('a long summary at a comfortable width truncates before the reserved meta zone', () => {
    const longSummary =
      'Delivered five ready to paste prompts with detailed staging notes and a full changelog attached here';
    const updatedAt = Date.now() - 5 * 60 * 1000;
    const line = strip(renderRosterRow(row({ lastAssistantText: longSummary, updatedAt }), false, false, 90));
    expect(line).toHaveLength(90);
    expect(line.endsWith('5m ago')).toBe(true);
    // The summary itself got cut with an ellipsis well before the line end.
    const summaryZone = line.slice(PREFIX_WIDTH + NAME_WIDTH);
    expect(summaryZone).toContain('…');
  });

  it('regression: at a narrow width the trailing time is never chopped mid-string (was "9m ago …")', () => {
    const longSummary = 'hi nihao, 有什么可以帮你的吗? 比如修 bug、加功能、或者看看代码，直接说就行';
    const updatedAt = Date.now() - (9 * 60 * 1000 + 5_000); // comfortably inside the 9m bucket
    const line = strip(renderRosterRow(row({ lastAssistantText: longSummary, updatedAt }), false, false, 60));
    expect(line.endsWith('9m ago')).toBe(true);
    expect(line).not.toContain('ago …');
  });

  it('a short summary still leaves the time flush against the last column', () => {
    const updatedAt = Date.now() - 60 * 1000;
    const line = strip(renderRosterRow(row({ lastAssistantText: 'ok', updatedAt }), false, false, 80));
    expect(line).toHaveLength(80);
    expect(line.endsWith('1m ago')).toBe(true);
  });

  it('an empty summary still right-flushes the time to the last column', () => {
    const updatedAt = Date.now() - 2 * 60 * 60 * 1000;
    const line = strip(renderRosterRow(row({ updatedAt }), false, false, 70));
    expect(line).toHaveLength(70);
    expect(line.endsWith('2h ago')).toBe(true);
  });
});

describe('renderRosterRow — untrusted badge in the meta zone', () => {
  it('renders the untrusted badge ahead of the time, both right-flush and never truncated', () => {
    const updatedAt = Date.now() - 4 * 60 * 1000;
    const line = strip(
      renderRosterRow(
        row({
          lastAssistantText: 'a fairly long summary that eats into the middle budget',
          trusted: false,
          updatedAt,
        }),
        false,
        false,
        80,
      ),
    );
    expect(line).toHaveLength(80);
    expect(line.endsWith('untrusted · 4m ago')).toBe(true);
  });

  it('omits the badge entirely when the row is trusted', () => {
    const line = strip(renderRosterRow(row({ trusted: true }), false, false, 80));
    expect(line).not.toContain('untrusted');
  });

  it('at a narrow width the badge yields first so the time still shows in full', () => {
    // 60 cols leaves only 14 columns after the fixed prefix (4) + name (42) —
    // not enough for "untrusted · 4m ago" (19), but enough for "4m ago" (7)
    // alone. The badge disappears; the time is never partially shown.
    const updatedAt = Date.now() - 4 * 60 * 1000;
    const line = strip(renderRosterRow(row({ trusted: false, updatedAt }), false, false, 60));
    expect(line).not.toContain('untrusted');
    expect(line.endsWith('4m ago')).toBe(true);
  });

  it('below the width where even the time alone fits, it disappears whole — never a partial cut', () => {
    const updatedAt = Date.now() - 4 * 60 * 1000;
    const line = strip(renderRosterRow(row({ trusted: false, updatedAt }), false, false, 48));
    expect(line).toHaveLength(48);
    expect(line).not.toContain('untrusted');
    expect(line).not.toContain('4m');
  });
});

describe('renderRosterRow — status glyph (busy / unseen / seen)', () => {
  function glyphAt(line: string): string {
    return line.slice(2, 3);
  }

  it('a busy row shows a spinner frame, never the retired braille dial', () => {
    const line = strip(renderRosterRow(row({ busy: true }), false, false, 80));
    expect(spinnerFrames()).toContain(glyphAt(line));
    expect(line).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });

  it('an idle unseen row shows the teardrop asterisk', () => {
    const line = strip(renderRosterRow(row({ busy: false, unseen: true }), false, false, 80));
    expect(glyphAt(line)).toBe('✻');
  });

  it('an idle seen row shows the bullet operator', () => {
    const line = strip(renderRosterRow(row({ busy: false, unseen: false }), false, false, 80));
    expect(glyphAt(line)).toBe('∙');
  });

  it('busy wins over unseen', () => {
    const line = strip(renderRosterRow(row({ busy: true, unseen: true }), false, false, 80));
    expect(spinnerFrames()).toContain(glyphAt(line));
  });

  it('never renders the retired ✗ (failed) or ! (pending-interaction) glyphs', () => {
    const failed = strip(renderRosterRow(row({ lastTurnReason: 'failed', unseen: false }), false, false, 80));
    expect(failed).not.toContain('✗');
    expect(glyphAt(failed)).toBe('∙');

    const pending = strip(renderRosterRow(row({ pendingInteraction: 'approval', unseen: true }), false, false, 80));
    expect(pending).not.toContain('!');
    expect(glyphAt(pending)).toBe('✻');
  });
});

describe('renderRosterRow — selected vs isOrigin (independent styling flags)', () => {
  // The roster bolds the title on `isOrigin` ("the session you came from"),
  // never on cursor `selected` — the two used to be conflated onto
  // `selected` here. Selection instead drives its own full-row
  // `surfaceSelected` background fill. Both flags are independent and
  // compose on the same row.

  it('selected alone (isOrigin false) renders the name in the plain "text" token, not bold', () => {
    const line = renderRosterRow(row({ title: 'abc' }), true, false, 120);
    expect(isBold(line)).toBe(false);
    expect(line).toContain(chalk.hex(darkColors.text)('abc'));
  });

  it('selected alone shows the full-row background fill', () => {
    const line = renderRosterRow(row({ title: 'abc' }), true, false, 120);
    expect(hasBg(line)).toBe(true);
  });

  it('an unselected row never shows the background fill, isOrigin or not', () => {
    const plain = renderRosterRow(row({ title: 'abc' }), false, false, 120);
    const origin = renderRosterRow(row({ title: 'abc' }), false, true, 120);
    expect(hasBg(plain)).toBe(false);
    expect(hasBg(origin)).toBe(false);
  });

  it('isOrigin alone (not selected) bolds the name in "textStrong"', () => {
    const line = renderRosterRow(row({ title: 'abc' }), false, true, 120);
    expect(isBold(line)).toBe(true);
    expect(line).toContain(chalk.hex(darkColors.textStrong).bold('abc'));
  });

  it('neither selected nor isOrigin: plain, unbolded name', () => {
    const line = renderRosterRow(row({ title: 'abc' }), false, false, 120);
    expect(isBold(line)).toBe(false);
  });

  it('both selected and isOrigin on the same row: bold still applies (they compose)', () => {
    const line = renderRosterRow(row({ title: 'abc' }), true, true, 120);
    expect(isBold(line)).toBe(true);
    expect(line).toContain(chalk.hex(darkColors.textStrong).bold('abc'));
  });

  it('both selected and isOrigin on the same row: the background fill also still applies (bg + bold together)', () => {
    const line = renderRosterRow(row({ title: 'abc' }), true, true, 120);
    expect(hasBg(line)).toBe(true);
    expect(isBold(line)).toBe(true);
  });

  it('the ❯ pointer still keys off `selected`, independently of `isOrigin`', () => {
    const selectedNotOrigin = strip(renderRosterRow(row({ title: 'abc' }), true, false, 120));
    const originNotSelected = strip(renderRosterRow(row({ title: 'abc' }), false, true, 120));
    expect(selectedNotOrigin.trimStart().startsWith('❯')).toBe(true);
    expect(originNotSelected.trimStart().startsWith('❯')).toBe(false);
  });
});

describe('spinnerFrames — ping-pong asterisk bloom', () => {
  it('darwin: a 12-frame bounce through the six-glyph charset', () => {
    expect(spinnerFrames('darwin')).toEqual([
      '·', '✢', '✳', '✶', '✻', '✽',
      '✽', '✻', '✶', '✳', '✢', '·',
    ]);
  });

  it('non-darwin substitutes a plain * for the third/tenth frame', () => {
    const frames = spinnerFrames('linux');
    expect(frames).toEqual(['·', '✢', '*', '✶', '✻', '✽', '✽', '✻', '✶', '*', '✢', '·']);
    expect(spinnerFrames('win32')).toEqual(frames);
  });

  it('the second half mirrors the first half in reverse (ping-pong, not a forward loop)', () => {
    const frames = spinnerFrames('darwin');
    expect(frames.slice(6)).toEqual(frames.slice(0, 6).toReversed());
  });
});

describe('renderGroupHeader', () => {
  it('an expanded header (collapsedCount undefined) shows the label alone, no count', () => {
    const out = strip(renderGroupHeader('Completed', undefined, false, 40));
    expect(out.trim()).toBe('Completed');
  });

  it('a collapsed header appends the hidden count in parens, on the same line as the label', () => {
    const out = strip(renderGroupHeader('Completed', 9, false, 40));
    const line = out.trim();
    expect(line).toBe('Completed (9)');
    // Single rendered line, no embedded newline — this is the regression
    // this test locks down: the label and count must never be split apart.
    expect(line).not.toContain('\n');
  });

  it('a collapsed header with zero hidden rows still renders "(0)", not a bare label', () => {
    // 0 is a real, distinct-from-undefined count — a group can be manually
    // collapsed down to an empty bucket (e.g. its last row got archived
    // while collapsed), and that's a different state from never-collapsed.
    const out = strip(renderGroupHeader('Completed', 0, false, 40));
    expect(out.trim()).toBe('Completed (0)');
  });

  it('the selection pointer still renders ahead of the label + count', () => {
    const out = strip(renderGroupHeader('Completed', 9, true, 40));
    expect(out.trimEnd().startsWith('❯')).toBe(true);
    expect(out).toContain('Completed (9)');
  });

  it('fix round 1: a selected header also carries the full-width background fill — the spec applies it to header rows, not just job rows', () => {
    const selected = renderGroupHeader('Completed', undefined, true, 40);
    const plain = renderGroupHeader('Completed', undefined, false, 40);
    expect(hasBg(selected)).toBe(true);
    expect(hasBg(plain)).toBe(false);
  });
});

describe('renderMoreRow', () => {
  it('renders the pointer, ellipsis and hidden count', () => {
    const out = strip(renderMoreRow(4, false, 40));
    expect(out.trim()).toBe('… 4 more');
  });

  it('the selection pointer still renders ahead of the label', () => {
    const out = strip(renderMoreRow(4, true, 40));
    expect(out.trimEnd().startsWith('❯')).toBe(true);
  });

  it('fix round 1: a selected "more" row also carries the full-width background fill — the spec applies it to fold rows, not just job rows', () => {
    const selected = renderMoreRow(4, true, 40);
    const plain = renderMoreRow(4, false, 40);
    expect(hasBg(selected)).toBe(true);
    expect(hasBg(plain)).toBe(false);
  });
});

describe('formatRelativeTime (sanity — consumed directly by the meta zone)', () => {
  it('formats minutes/hours/days with no "ago"-less form and no fractional units', () => {
    expect(formatRelativeTime(Date.now() - 30_000)).toBe('just now');
    expect(formatRelativeTime(Date.now() - 5 * 60 * 1000)).toBe('5m ago');
    expect(formatRelativeTime(Date.now() - 3 * 60 * 60 * 1000)).toBe('3h ago');
    expect(formatRelativeTime(Date.now() - 2 * 24 * 60 * 60 * 1000)).toBe('2d ago');
  });
});
