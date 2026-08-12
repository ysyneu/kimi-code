/**
 * Tests for TUI's mouse escape sequence consumption: a decoded left press
 * reaches the focused component's handleMouse, everything else (release,
 * other buttons, the legacy encoding) is swallowed without ever reaching
 * handleInput as garbage keys.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component } from "../src/tui.ts";
import { TUI } from "../src/tui.ts";
import type { MouseClickEvent } from "../src/mouse.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class Recorder implements Component {
	readonly inputs: string[] = [];
	readonly mouseEvents: MouseClickEvent[] = [];

	render(): string[] {
		return [""];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	handleMouse(event: MouseClickEvent): void {
		this.mouseEvents.push(event);
	}

	invalidate(): void {}
}

/** A component that, like most of this codebase's components, never
 *  implements handleMouse at all — used to prove the optional handler is
 *  genuinely optional and that mouse sequences are still consumed (not
 *  leaked to handleInput) even when nothing is listening for them. */
class InputOnlyRecorder implements Component {
	readonly inputs: string[] = [];

	render(): string[] {
		return [""];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

describe("TUI mouse input", () => {
	it("forwards a decoded left-button press to handleMouse, never to handleInput", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const recorder = new Recorder();
		tui.setFocus(recorder);
		tui.start();

		terminal.sendInput("\x1b[<0;20;5M");

		assert.deepStrictEqual(recorder.mouseEvents, [{ column: 19, row: 4 }]);
		assert.deepStrictEqual(recorder.inputs, []);
		tui.stop();
	});

	it("consumes a release event without calling handleMouse or handleInput", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const recorder = new Recorder();
		tui.setFocus(recorder);
		tui.start();

		terminal.sendInput("\x1b[<0;20;5m");

		assert.deepStrictEqual(recorder.mouseEvents, []);
		assert.deepStrictEqual(recorder.inputs, []);
		tui.stop();
	});

	it("consumes a non-left button press without calling handleMouse or handleInput", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const recorder = new Recorder();
		tui.setFocus(recorder);
		tui.start();

		terminal.sendInput("\x1b[<2;20;5M"); // right button

		assert.deepStrictEqual(recorder.mouseEvents, []);
		assert.deepStrictEqual(recorder.inputs, []);
		tui.stop();
	});

	it("consumes the legacy X10 encoding without leaking it to handleInput", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const recorder = new Recorder();
		tui.setFocus(recorder);
		tui.start();

		terminal.sendInput("\x1b[M !\"");

		assert.deepStrictEqual(recorder.mouseEvents, []);
		assert.deepStrictEqual(recorder.inputs, []);
		tui.stop();
	});

	it("does not throw and still consumes the sequence when the focused component has no handleMouse", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const recorder = new InputOnlyRecorder();
		tui.setFocus(recorder);
		tui.start();

		assert.doesNotThrow(() => terminal.sendInput("\x1b[<0;20;5M"));

		assert.deepStrictEqual(recorder.inputs, []);
		tui.stop();
	});

	it("still forwards ordinary keyboard input after a mouse sequence", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const recorder = new Recorder();
		tui.setFocus(recorder);
		tui.start();

		terminal.sendInput("\x1b[<0;20;5M");
		terminal.sendInput("q");

		assert.deepStrictEqual(recorder.mouseEvents, [{ column: 19, row: 4 }]);
		assert.deepStrictEqual(recorder.inputs, ["q"]);
		tui.stop();
	});
});
