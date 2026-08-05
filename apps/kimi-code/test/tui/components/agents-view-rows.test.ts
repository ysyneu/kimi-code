/**
 * Scenario: agents-view roster row rendering.
 * Responsibilities: the Claude-style `glyph name summary time` layout, the
 * lastAssistantText → lastPrompt fallback, and the no-cwd/no-duplicate rules.
 * Wiring: pure function, no TUI/component harness needed.
 * Run: pnpm exec vitest run test/tui/components/agents-view-rows.test.ts
 */
import { describe, expect, it } from 'vitest';

import type { AgentsRosterRow } from '@/tui/agents/roster';
import { renderRosterRow } from '@/tui/components/agents-view/rows';

const ANSI_SGR = /\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function row(overrides: Partial<AgentsRosterRow> = {}): AgentsRosterRow {
  return {
    id: 's1',
    title: 's1 title',
    workDir: '/home/user/project',
    updatedAt: Date.now(),
    busy: false,
    pendingInteraction: 'none',
    pinned: false,
    ...overrides,
  };
}

describe('renderRosterRow', () => {
  it('renders name, assistant summary, and time in order, with no cwd', () => {
    const line = strip(
      renderRosterRow(row({ lastAssistantText: 'the answer is 42', updatedAt: Date.now() }), false, 80),
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
    const line = strip(renderRosterRow(row({ lastPrompt: 'do the thing' }), false, 80));
    expect(line).toContain('do the thing');
  });

  it('prefers lastAssistantText over lastPrompt when both are present', () => {
    const line = strip(
      renderRosterRow(row({ lastPrompt: 'the prompt', lastAssistantText: 'the reply' }), false, 80),
    );
    expect(line).toContain('the reply');
    expect(line).not.toContain('the prompt');
  });

  it('leaves the summary blank when title === lastPrompt (single-turn auto-title)', () => {
    const line = strip(
      renderRosterRow(row({ title: 'fix the flaky test', lastPrompt: 'fix the flaky test' }), false, 80),
    );
    expect(line.indexOf('fix the flaky test')).toBe(line.lastIndexOf('fix the flaky test'));
  });

  it('leaves the summary blank when an untitled row already used lastPrompt as its name', () => {
    // The name itself falls back to lastPrompt when title is empty; the
    // summary must not re-show the same text as a second copy.
    const line = strip(renderRosterRow(row({ title: '', lastPrompt: 'summarize the logs' }), false, 80));
    expect(line.indexOf('summarize the logs')).toBe(line.lastIndexOf('summarize the logs'));
  });

  it('shows no summary segment when neither field is set', () => {
    const line = strip(renderRosterRow(row(), false, 80));
    expect(line).toContain('s1 title');
  });
});
