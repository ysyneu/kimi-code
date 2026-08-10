/**
 * SGR mouse input decoding for terminal applications.
 *
 * Mouse reporting is opt-in and narrowly scoped (see `ProcessTerminal.
 * enableMouseTracking`): normal button tracking (`?1000`) plus the SGR
 * extension (`?1006`), never motion tracking. That combination reports only
 * button presses and releases — never drags — so this module only ever
 * needs to recognize a complete SGR (or legacy) sequence and, for a plain
 * left-button press, decode its 0-indexed screen coordinates. Everything
 * else (releases, other buttons, the legacy encoding) is recognized only
 * well enough to be swallowed rather than leaked into keyboard input — see
 * `isMouseSequence` and `TUI`'s `handleInput`, which consumes any
 * recognized sequence before it can reach a focused component's
 * `handleInput` as garbage keys, and only ever forwards a decoded press to
 * `Component.handleMouse`.
 *
 * Reference: https://invisible-island.net/xterm/ctlseqs/ctlseqs.html (SGR
 * mouse mode, private mode 1006).
 */

/** A left mouse-button press, already converted to 0-indexed screen
 *  coordinates (the terminal reports 1-indexed row/column). */
export interface MouseClickEvent {
	readonly column: number;
	readonly row: number;
}

/** Legacy X10/normal mouse encoding: `ESC[M` followed by exactly 3 data
 *  bytes (button, column, row, each biased by +32). Enabling SGR (`?1006`)
 *  makes modern terminals send the SGR form below instead, but a
 *  non-compliant terminal could still send this — recognized only so it can
 *  be swallowed rather than leaked to `handleInput`; never decoded. */
const LEGACY_MOUSE_SEQUENCE = /^\x1b\[M[\s\S]{3}$/;

/** SGR mouse encoding (`?1006`): `ESC[<Cb;Cx;CyM` (press) or the same with
 *  a trailing `m` (release). */
const SGR_MOUSE_SEQUENCE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

/** Modifier bits packed into the SGR button code alongside the button id —
 *  shift (4), meta (8), ctrl (16). Masked off so a modified left click is
 *  still recognized as a left click. The motion (32) and wheel/extra-button
 *  (64) bits are deliberately left in place: either one means "not a plain
 *  button press", which is what makes the `=== 0` check below reject them. */
const SGR_MODIFIER_BITS = 0b11100;

function isLeftButtonPress(buttonCode: number, isRelease: boolean): boolean {
	if (isRelease) return false;
	return (buttonCode & ~SGR_MODIFIER_BITS) === 0;
}

/**
 * Recognize any complete mouse escape sequence — SGR or legacy — whether or
 * not it goes on to decode into an actionable event. Used to consume the
 * raw bytes so they never reach `handleInput` as garbage keys, independent
 * of whether `decodeMouseClick` returns anything for them.
 */
export function isMouseSequence(data: string): boolean {
	return SGR_MOUSE_SEQUENCE.test(data) || LEGACY_MOUSE_SEQUENCE.test(data);
}

/**
 * Decode a complete escape sequence into a left-button press, or `undefined`
 * for anything else (a release, a non-left button, the legacy encoding, or
 * not a mouse sequence at all). Callers that only need to know whether to
 * consume the sequence — regardless of whether it decodes — should use
 * `isMouseSequence` instead.
 */
export function decodeMouseClick(data: string): MouseClickEvent | undefined {
	const match = SGR_MOUSE_SEQUENCE.exec(data);
	if (!match) return undefined;

	const buttonCode = Number.parseInt(match[1]!, 10);
	const isRelease = match[4] === "m";
	if (!isLeftButtonPress(buttonCode, isRelease)) return undefined;

	return {
		column: Number.parseInt(match[2]!, 10) - 1,
		row: Number.parseInt(match[3]!, 10) - 1,
	};
}
