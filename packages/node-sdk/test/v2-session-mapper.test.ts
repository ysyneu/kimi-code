/**
 * Scenario: v2 → v1 session shape mapping used by the wire client.
 * Responsibilities: field-by-field projection from agent-core-v2's
 * `SessionSummary` onto the v1 SDK `SessionSummary` the public surface serves.
 * Wiring: pure functions, no server.
 * Run: pnpm exec vitest run test/v2-session-mapper.test.ts
 */
import { describe, expect, it } from 'vitest';

import { v2SummaryToSessionSummary } from '#/v2/session-mapper';

function summary(overrides: Partial<Parameters<typeof v2SummaryToSessionSummary>[0]> = {}) {
  return {
    id: 'ses_1',
    workspaceId: 'wd_1',
    title: 'demo',
    createdAt: 0,
    updatedAt: 0,
    archived: false,
    ...overrides,
  };
}

describe('v2SummaryToSessionSummary', () => {
  it('carries lastAssistantText through unchanged when present', () => {
    const mapped = v2SummaryToSessionSummary(summary({ lastAssistantText: 'hi there' }), {
      workDir: '/tmp/demo',
      sessionDir: '/tmp/demo/.kimi',
    });

    expect(mapped.lastAssistantText).toBe('hi there');
  });

  it('leaves lastAssistantText undefined for sessions with no assistant reply yet', () => {
    const mapped = v2SummaryToSessionSummary(summary(), {
      workDir: '/tmp/demo',
      sessionDir: '/tmp/demo/.kimi',
    });

    expect(mapped.lastAssistantText).toBeUndefined();
  });
});
