import { describe, expect, it, vi } from 'vitest';

import { applyUpdatePreferenceChoice } from '#/tui/commands/config';
import { darkColors } from '#/tui/theme/colors';

const mocks = vi.hoisted(() => ({
  saveTuiConfig: vi.fn(),
}));

vi.mock('../../../src/tui/config', async () => {
  const actual = await vi.importActual<typeof import('../../../src/tui/config.js')>(
    '../../../src/tui/config.js',
  );
  return {
    ...actual,
    saveTuiConfig: mocks.saveTuiConfig,
  };
});

function makeHost(groupMode: 'state' | 'directory' = 'state') {
  const setAppState = vi.fn();
  const showStatus = vi.fn();
  const track = vi.fn();
  const agentsViewGroupMode = vi.fn(() => groupMode);
  const host = {
    state: {
      appState: {
        theme: 'auto' as const,
        editorCommand: null,
        notifications: { enabled: true, condition: 'unfocused' as const },
        upgrade: { autoInstall: true },
      },
      theme: { palette: darkColors },
    },
    setAppState,
    showStatus,
    track,
    agentsViewGroupMode,
  };
  return { host, setAppState, showStatus, track, agentsViewGroupMode };
}

describe('update preference commands', () => {
  it('saves automatic update preference changes to tui.toml', async () => {
    const { host, setAppState, showStatus, track } = makeHost('state');

    await applyUpdatePreferenceChoice(host, false);

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith({
      theme: 'auto',
      editorCommand: null,
      disablePasteBurst: false,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: false },
      agentsView: { groupMode: 'state' },
    });
    expect(setAppState).toHaveBeenCalledWith({ upgrade: { autoInstall: false } });
    expect(track).toHaveBeenCalledWith('upgrade_preference_changed', { auto_install: false });
    expect(showStatus).toHaveBeenCalledWith('Automatic updates disabled.');
  });

  // A6 regression (review round 1, Critical finding #1): currentTuiConfig()
  // must thread every persisted field through an unrelated save, not just
  // the ones this command itself changes — otherwise a Ctrl+S-persisted
  // agents_view.group_mode is silently reverted to 'state' by the very next
  // /theme, /editor, or (as exercised here) auto-update-toggle save. This
  // command is a stand-in for all three: they share the same
  // currentTuiConfig() helper, so pinning the behavior through any one call
  // site covers the shared root cause.
  it('preserves an already-persisted agents_view.group_mode across an unrelated save (would fail without the currentTuiConfig fix)', async () => {
    const { host, agentsViewGroupMode } = makeHost('directory');

    await applyUpdatePreferenceChoice(host, false);

    expect(agentsViewGroupMode).toHaveBeenCalled();
    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ agentsView: { groupMode: 'directory' } }),
    );
  });
});
