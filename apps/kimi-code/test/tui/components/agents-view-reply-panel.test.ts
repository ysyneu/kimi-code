/**
 * Scenario: the reply panel (task A1 / R9 §2.A1) — the bordered preview
 * panel `space` opens on a focused roster row.
 * Responsibilities: `previewLines`' content-source priority (assistant
 * output → initial prompt → nothing) and its up-to-6-line clamp;
 * `renderReplyPanel`'s box chrome, its embedding of the shared dispatch
 * editor unmodified, and its graceful handling of a vanished target row.
 * Wiring: pure functions, no controller harness needed — `renderReplyPanel`
 * takes a real `CustomEditor` over a minimal fake TUI (same stub shape the
 * component test file's `makeDispatchEditor` uses).
 * Run: pnpm exec vitest run test/tui/components/agents-view-reply-panel.test.ts
 */
import type { TUI } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentsRosterRow } from '@/tui/agents/roster';
import { CustomEditor } from '@/tui/components/editor/custom-editor';
import { previewLines, renderReplyPanel } from '@/tui/components/agents-view/reply-panel';

// This file asserts exact lengths and regex-anchored full-line matches (box
// corners), so (unlike the sibling test files' substring-only checks, which
// tolerate a stray leading ESC byte) the ESC byte itself has to be stripped
// too, not just the trailing `[...m` — mirrors `custom-editor.ts`'s own
// `ANSI_SGR` pattern.
// oxlint-disable-next-line no-control-regex -- ESC (\x1b) is required to match ANSI SGR escape sequences
const ANSI_SGR = /\u001B\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

// Bold/color assertions need chalk actually emitting SGR codes — the test
// process is not a TTY, so chalk auto-detects level 0 without this.
const previousChalkLevel = chalk.level;
beforeAll(() => {
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = previousChalkLevel;
});

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

/** Same minimal fake TUI shape as the component test file's own
 *  `makeDispatchEditor` — only `terminal`/`render`/`requestRender` are read
 *  by a `CustomEditor` that's never actually mounted into a real UI tree. */
function makeEditor(placeholder = 'reply'): CustomEditor {
  const tui = {
    requestRender: () => {},
    render: () => [],
    terminal: { rows: 40, columns: 120 },
  } as unknown as TUI;
  return new CustomEditor(tui, { frameVariant: 'rules', promptSymbol: '❯', placeholder });
}

describe('previewLines', () => {
  it('prefers lastAssistantText over lastPrompt', () => {
    expect(previewLines(row({ lastPrompt: 'the prompt', lastAssistantText: 'the reply' }))).toEqual([
      'the reply',
    ]);
  });

  it('falls back to lastPrompt when there is no assistant output yet', () => {
    expect(previewLines(row({ lastPrompt: 'investigate the outage' }))).toEqual([
      'investigate the outage',
    ]);
  });

  it('is empty when the row has neither field', () => {
    expect(previewLines(row())).toEqual([]);
  });

  it('is empty when both fields are blank/whitespace-only', () => {
    expect(previewLines(row({ lastAssistantText: '   ', lastPrompt: '\n\t' }))).toEqual([]);
  });

  it('preserves line breaks (unlike the roster row summary, which squashes them)', () => {
    expect(previewLines(row({ lastAssistantText: 'first line\nsecond line' }))).toEqual([
      'first line',
      'second line',
    ]);
  });

  it('collapses internal whitespace runs within a line but keeps the line break', () => {
    expect(previewLines(row({ lastAssistantText: 'a   b\tc\nd     e' }))).toEqual(['a b c', 'd e']);
  });

  it('drops blank lines rather than spending the line budget on them', () => {
    expect(previewLines(row({ lastAssistantText: 'a\n\n\nb' }))).toEqual(['a', 'b']);
  });

  it('caps at maxLines (default 6)', () => {
    const many = Array.from({ length: 10 }, (_, i) => `line ${String(i)}`).join('\n');
    const lines = previewLines(row({ lastAssistantText: many }));
    expect(lines).toEqual(['line 0', 'line 1', 'line 2', 'line 3', 'line 4', 'line 5']);
  });

  it('honors a custom maxLines override', () => {
    const many = Array.from({ length: 10 }, (_, i) => `line ${String(i)}`).join('\n');
    expect(previewLines(row({ lastAssistantText: many }), 2)).toEqual(['line 0', 'line 1']);
  });
});

describe('renderReplyPanel', () => {
  it('draws a rounded box (╭─╮ / │ / ╰─╯) around the content', () => {
    const lines = renderReplyPanel(row(), makeEditor(), 80).map(strip);
    expect(lines[0]).toMatch(/^╭─+╮$/);
    expect(lines.at(-1)).toMatch(/^╰─+╯$/);
    expect(lines.slice(1, -1).every((l) => l.startsWith('│') && l.endsWith('│'))).toBe(true);
  });

  it('every line is exactly `width` columns wide', () => {
    const width = 90;
    const lines = renderReplyPanel(row({ lastAssistantText: 'the answer is 42' }), makeEditor(), width);
    for (const line of lines) expect(strip(line).length).toBe(width);
  });

  it('includes the preview text and a relative-age line, in that order', () => {
    const out = strip(
      renderReplyPanel(row({ lastAssistantText: 'the answer is 42', updatedAt: Date.now() }), makeEditor(), 100).join(
        '\n',
      ),
    );
    const previewIdx = out.indexOf('the answer is 42');
    const ageIdx = out.indexOf('just now');
    expect(previewIdx).toBeGreaterThan(-1);
    expect(ageIdx).toBeGreaterThan(previewIdx);
  });

  it('falls back to the initial prompt when there is no assistant output yet', () => {
    const out = strip(renderReplyPanel(row({ lastPrompt: 'investigate the outage' }), makeEditor(), 100).join('\n'));
    expect(out).toContain('investigate the outage');
  });

  it("renders the editor's own placeholder inside the box", () => {
    const out = strip(renderReplyPanel(row(), makeEditor('reply'), 100).join('\n'));
    expect(out).toContain('reply');
  });

  it('reflects live editor text (typed, not yet submitted)', () => {
    const editor = makeEditor();
    editor.setText('here is more context');
    const out = strip(renderReplyPanel(row(), editor, 100).join('\n'));
    expect(out).toContain('here is more context');
  });

  it('renders without a preview/age block when row is undefined — no throw, editor still shown', () => {
    const editor = makeEditor();
    editor.setText('typed before the row vanished');
    expect(() => renderReplyPanel(undefined, editor, 100)).not.toThrow();
    const out = strip(renderReplyPanel(undefined, editor, 100).join('\n'));
    expect(out).toContain('typed before the row vanished');
  });

  it('never renders more than 6 preview lines even for a long multi-line output', () => {
    const many = Array.from({ length: 10 }, (_, i) => `preview-line-${String(i)}`).join('\n');
    const out = strip(renderReplyPanel(row({ lastAssistantText: many }), makeEditor(), 120).join('\n'));
    for (let i = 0; i < 6; i++) expect(out).toContain(`preview-line-${String(i)}`);
    for (let i = 6; i < 10; i++) expect(out).not.toContain(`preview-line-${String(i)}`);
  });

  it('falls back to a bare editor render on an unreasonably narrow width', () => {
    const editor = makeEditor();
    const lines = renderReplyPanel(row({ lastAssistantText: 'x' }), editor, 2);
    expect(lines).toEqual(editor.render(2));
  });
});
