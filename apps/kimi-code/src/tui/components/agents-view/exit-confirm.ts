/**
 * AgentsExitConfirmComponent — the shutdown-time confirmation for
 * `kimi agents` on an embedded kap-server: quitting interrupts sessions that
 * are still running server-side. Follows the TasksBrowser inline
 * stop-confirm pattern (a printable `y` confirms, ANY other key cancels,
 * the prompt auto-cancels on a timeout — the safe default is always to
 * stay), mounted by `KimiTUI.stop()` as a full-screen container swap so it
 * shows over both the agents view and an attached chat.
 */

import { Container, type Focusable } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import { printableChar } from '@/tui/utils/printable-key';

import { fitExactly } from './rows';

export interface AgentsExitConfirmProps {
  /** How many sessions are still running server-side. */
  readonly running: number;
  /** Exactly-once callback: true = interrupt & quit, false = stay. */
  readonly onResolve: (confirmed: boolean) => void;
}

/** Auto-cancel the confirmation after this many ms (a walk-away stays put). */
const EXIT_CONFIRM_TIMEOUT_MS = 10_000;

export class AgentsExitConfirmComponent extends Container implements Focusable {
  focused = false;

  private readonly props: AgentsExitConfirmProps;
  private readonly timer: ReturnType<typeof setTimeout>;
  private resolved = false;

  constructor(props: AgentsExitConfirmProps) {
    super();
    this.props = props;
    this.timer = setTimeout(() => {
      this.resolve(false);
    }, EXIT_CONFIRM_TIMEOUT_MS);
  }

  handleInput(data: string): void {
    const k = printableChar(data);
    // Only an explicit `y` interrupts running sessions; every other key —
    // n, Esc, Ctrl+C, anything — cancels (TasksBrowser stop-confirm shape).
    this.resolve(k === 'y' || k === 'Y');
  }

  private resolve(confirmed: boolean): void {
    if (this.resolved) return;
    this.resolved = true;
    clearTimeout(this.timer);
    this.props.onResolve(confirmed);
  }

  override render(width: number): string[] {
    const message = currentTheme.fg(
      'warning',
      ` ${String(this.props.running)} session(s) still running — quitting interrupts them (saved; resumable).`,
    );
    const hint = currentTheme.fg('textMuted', ' Y quit · N cancel ');
    return ['', fitExactly(message, width), fitExactly(hint, width)];
  }
}
