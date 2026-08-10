/**
 * Tests for SGR mouse input decoding (see src/mouse.ts).
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { decodeMouseClick, isMouseSequence } from "../src/mouse.ts";
import { StdinBuffer } from "../src/stdin-buffer.ts";

describe("decodeMouseClick", () => {
	it("decodes a plain left-button press to 0-indexed coordinates", () => {
		assert.deepStrictEqual(decodeMouseClick("\x1b[<0;20;5M"), { column: 19, row: 4 });
	});

	it("decodes a left-button press at the top-left cell (1-indexed 1;1 -> 0;0)", () => {
		assert.deepStrictEqual(decodeMouseClick("\x1b[<0;1;1M"), { column: 0, row: 0 });
	});

	it("still recognizes a left click with shift/meta/ctrl held", () => {
		// Modifier bits (shift=4, meta=8, ctrl=16) packed onto button 0 (left) = 28.
		assert.deepStrictEqual(decodeMouseClick("\x1b[<28;1;1M"), { column: 0, row: 0 });
	});

	it("returns undefined for a release event", () => {
		assert.strictEqual(decodeMouseClick("\x1b[<0;20;5m"), undefined);
	});

	it("returns undefined for a non-left button press (middle)", () => {
		assert.strictEqual(decodeMouseClick("\x1b[<1;20;5M"), undefined);
	});

	it("returns undefined for a non-left button press (right)", () => {
		assert.strictEqual(decodeMouseClick("\x1b[<2;20;5M"), undefined);
	});

	it("returns undefined for a wheel event", () => {
		assert.strictEqual(decodeMouseClick("\x1b[<64;20;5M"), undefined);
	});

	it("returns undefined for a motion event", () => {
		// Never actually sent by us (motion tracking is never enabled), but
		// decode must reject it defensively rather than misread it as a click.
		assert.strictEqual(decodeMouseClick("\x1b[<32;20;5M"), undefined);
	});

	it("returns undefined for the legacy X10 encoding", () => {
		assert.strictEqual(decodeMouseClick("\x1b[M !\""), undefined);
	});

	it("returns undefined for a non-mouse escape sequence", () => {
		assert.strictEqual(decodeMouseClick("\x1b[A"), undefined);
	});

	it("returns undefined for plain text", () => {
		assert.strictEqual(decodeMouseClick("a"), undefined);
	});
});

describe("isMouseSequence", () => {
	it("recognizes SGR press and release sequences", () => {
		assert.strictEqual(isMouseSequence("\x1b[<0;20;5M"), true);
		assert.strictEqual(isMouseSequence("\x1b[<0;20;5m"), true);
	});

	it("recognizes SGR sequences that decodeMouseClick discards (non-left, wheel, motion)", () => {
		assert.strictEqual(isMouseSequence("\x1b[<1;20;5M"), true);
		assert.strictEqual(isMouseSequence("\x1b[<64;20;5M"), true);
		assert.strictEqual(isMouseSequence("\x1b[<32;20;5M"), true);
	});

	it("recognizes the legacy X10 encoding", () => {
		assert.strictEqual(isMouseSequence("\x1b[M !\""), true);
	});

	it("does not recognize ordinary keyboard sequences", () => {
		assert.strictEqual(isMouseSequence("\x1b[A"), false);
		assert.strictEqual(isMouseSequence("a"), false);
		assert.strictEqual(isMouseSequence("\x1b"), false);
	});
});

describe("decodeMouseClick over a sequence StdinBuffer reassembled from split chunks", () => {
	it("decodes correctly once the buffer joins a press split across two stdin events", () => {
		// This is the exact scenario stdin-buffer.ts's own module doc calls
		// out for mouse SGR sequences: the terminal can hand the escape and
		// its payload to separate `data` events.
		const buffer = new StdinBuffer({ timeout: 10 });
		const emitted: string[] = [];
		buffer.on("data", (sequence) => emitted.push(sequence));

		buffer.process("\x1b");
		buffer.process("[<0;20;5M");

		assert.deepStrictEqual(emitted, ["\x1b[<0;20;5M"]);
		assert.deepStrictEqual(decodeMouseClick(emitted[0]!), { column: 19, row: 4 });
	});

	it("decodes correctly once the buffer joins a press split mid-payload across three stdin events", () => {
		const buffer = new StdinBuffer({ timeout: 10 });
		const emitted: string[] = [];
		buffer.on("data", (sequence) => emitted.push(sequence));

		buffer.process("\x1b[<0");
		buffer.process(";20");
		buffer.process(";5M");

		assert.deepStrictEqual(emitted, ["\x1b[<0;20;5M"]);
		assert.deepStrictEqual(decodeMouseClick(emitted[0]!), { column: 19, row: 4 });
	});
});
