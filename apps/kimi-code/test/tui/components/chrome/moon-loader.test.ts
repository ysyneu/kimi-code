import type { TUI } from '@moonshot-ai/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MoonLoader } from '#/tui/components/chrome/moon-loader';

// MoonLoader starts a real setInterval in its constructor, so every loader
// created in these tests must be stopped to avoid leaving live timers behind.
const loaders: MoonLoader[] = [];

function createLoader(): MoonLoader {
  const ui = { requestRender() {} } as unknown as TUI;
  const loader = new MoonLoader(ui, 'moon');
  loaders.push(loader);
  return loader;
}

afterEach(() => {
  for (const loader of loaders) loader.stop();
  loaders.length = 0;
});

describe('MoonLoader', () => {
  it('keeps the tip out of renderInline so it does not squeeze against the swarm progress bar', () => {
    const loader = createLoader();
    loader.setTip(' · Tip: ctrl+s: steer mid-turn');
    loader.setAvailableWidth(80);

    const inline = loader.renderInline();
    expect(inline).not.toContain('Tip');
    expect(inline).not.toContain('steer');
    expect(inline.trim().length).toBeGreaterThan(0);
  });

  it('still shows the tip on its own row when width allows', () => {
    const loader = createLoader();
    loader.setTip(' · Tip: ctrl+s: steer mid-turn');
    loader.setAvailableWidth(80);

    const row = loader.render(80).join('\n');
    expect(row).toContain('Tip: ctrl+s: steer mid-turn');
  });

  it('shows no elapsed suffix by default', () => {
    const loader = createLoader();
    expect(loader.render(80).join('\n').trim()).not.toMatch(/\d/);
  });

  it('appends the elapsed time since the given origin, recomputed on each tick', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const loader = createLoader();
      loader.setElapsedOrigin(0);

      vi.setSystemTime(4_000);
      vi.advanceTimersByTime(120);
      expect(loader.render(80).join('\n')).toContain('4s');

      vi.setSystemTime(64_000);
      vi.advanceTimersByTime(120);
      expect(loader.render(80).join('\n')).toContain('1m4s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('appends a trailing + when the origin is approximate', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(8_000);
      const loader = createLoader();
      loader.setElapsedOrigin(0, true);

      expect(loader.render(80).join('\n')).toContain('8s+');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the elapsed suffix when the origin is unset', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(4_000);
      const loader = createLoader();
      loader.setElapsedOrigin(0);
      expect(loader.render(80).join('\n')).toContain('4s');

      loader.setElapsedOrigin(undefined);
      expect(loader.render(80).join('\n')).not.toMatch(/\d/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('includes the elapsed suffix in the label-only inline text too', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(9_000);
      const loader = createLoader();
      loader.setElapsedOrigin(0);

      expect(loader.renderInline()).toContain('9s');
    } finally {
      vi.useRealTimers();
    }
  });
});
