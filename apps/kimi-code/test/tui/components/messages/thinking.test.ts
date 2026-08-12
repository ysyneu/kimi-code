import { visibleWidth, type TUI } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { STATUS_BULLET } from '#/tui/constant/symbols';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

const longThinking = ['line1', 'line2', 'line3', 'line4', 'line5', 'line6', 'line7'].join('\n');

describe('ThinkingComponent', () => {
  it('shows the live spinner header before thinking content', () => {
    const component = new ThinkingComponent('working it out', true, 'live');
    const out = strip(component.render(80).join('\n'));

    expect(out).toContain('⠋ thinking...');
    expect(out).not.toContain('  ⠋ thinking...');
    expect(out).not.toContain(`${STATUS_BULLET}⠋`);
    expect(out).toContain('  working it out');
  });

  it('keeps live thinking height-limited to the tail', () => {
    const component = new ThinkingComponent(longThinking, true, 'live');
    const out = strip(component.render(80).join('\n'));

    expect(out).not.toContain('line1');
    expect(out).not.toContain('line4');
    expect(out).not.toContain('line5');
    expect(out).toContain('line6');
    expect(out).toContain('line7');
    expect(out).not.toContain('ctrl+o to expand');
  });

  it('animates the live spinner and stops on finalize', () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const component = new ThinkingComponent('step', true, 'live', {
      requestRender,
    } as unknown as TUI);

    expect(strip(component.render(80).join('\n'))).toContain('⠋ thinking...');

    vi.advanceTimersByTime(80);
    expect(requestRender).toHaveBeenCalled();
    expect(strip(component.render(80).join('\n'))).toContain('⠙ thinking...');

    component.finalize();
    requestRender.mockClear();
    vi.advanceTimersByTime(160);
    expect(requestRender).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('renders elapsed time since the turn start, not since construction', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const component = new ThinkingComponent('working it out', true, 'live', undefined, 4_000);

    expect(strip(component.render(80).join('\n'))).toContain('⠋ thinking... 6s');
    vi.useRealTimers();
  });

  it('recomputes elapsed from the timestamp on the existing spinner tick, never a counter', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const requestRender = vi.fn();
    const component = new ThinkingComponent('step', true, 'live', { requestRender } as unknown as TUI, 0);

    vi.setSystemTime(3_000);
    vi.advanceTimersByTime(80);
    expect(strip(component.render(80).join('\n'))).toContain('thinking... 3s');

    vi.setSystemTime(65_000);
    vi.advanceTimersByTime(80);
    expect(strip(component.render(80).join('\n'))).toContain('thinking... 1m5s');
    vi.useRealTimers();
  });

  it('appends a trailing + for an approximate (attach-time) origin', () => {
    vi.useFakeTimers();
    vi.setSystemTime(9_000);
    const component = new ThinkingComponent('working it out', true, 'live', undefined, 1_000, true);

    expect(strip(component.render(80).join('\n'))).toContain('⠋ thinking... 8s+');
    vi.useRealTimers();
  });

  it('renders no elapsed suffix when constructed without a turn clock', () => {
    const component = new ThinkingComponent('working it out', true, 'live');
    const out = strip(component.render(80).join('\n'));

    expect(out).toContain('⠋ thinking...');
    expect(out).not.toMatch(/thinking\.\.\. \d/);
  });

  it('never shows the elapsed suffix once finalized', () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const component = new ThinkingComponent('working it out', true, 'live', undefined, 1_000);
    component.finalize();

    expect(strip(component.render(80).join('\n'))).not.toMatch(/\d+s/);
    vi.useRealTimers();
  });

  it('finalizes in place into a collapsed preview', () => {
    const component = new ThinkingComponent(longThinking, true, 'live');

    component.finalize();

    const out = strip(component.render(80).join('\n'));
    expect(out).toContain('line1');
    expect(out).toContain('line2');
    expect(out).not.toContain('line3');
    expect(out).not.toContain('line4');
    expect(out).toContain('... (5 more lines, ctrl+o to expand)');
  });

  it('expands and collapses after finalization', () => {
    const component = new ThinkingComponent(longThinking, true, 'live');
    component.finalize();

    component.setExpanded(true);
    const expanded = strip(component.render(80).join('\n'));
    expect(expanded).toContain('line7');
    expect(expanded).not.toContain('ctrl+o to expand');

    component.setExpanded(false);
    const collapsed = strip(component.render(80).join('\n'));
    expect(collapsed).not.toContain('line7');
    expect(collapsed).toContain('ctrl+o to expand');
  });

  it('keeps the finalized truncation footer within the requested render width', () => {
    const component = new ThinkingComponent(longThinking, true, 'live');
    component.finalize();

    for (const line of component.render(37)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(37);
    }
  });
});
