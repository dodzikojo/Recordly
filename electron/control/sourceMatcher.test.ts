import { describe, expect, it } from "vitest";
import { matchSource } from "./sourceMatcher";
import type { CaptureSourceSummary } from "./types";

const screens: CaptureSourceSummary[] = [
	{ id: "screen:1:0", name: "Screen 1 (Primary)", kind: "screen", displayId: "1" },
	{ id: "screen:2:0", name: "Screen 2", kind: "screen", displayId: "2" },
];
const orca: CaptureSourceSummary = {
	id: "window:10:0",
	name: "ORCA — Northbank",
	kind: "window",
};
const other: CaptureSourceSummary = { id: "window:11:0", name: "Notepad", kind: "window" };
const sources = [...screens, orca, other];

describe("matchSource", () => {
	it("matches an exact id", () => {
		expect(matchSource(sources, { id: "window:11:0" })).toEqual({ ok: true, source: other });
	});

	it("fails for an unknown id", () => {
		expect(matchSource(sources, { id: "window:99:0" }).ok).toBe(false);
	});

	it("picks the display by 0-based index among screens", () => {
		expect(matchSource(sources, { display: 1 })).toEqual({ ok: true, source: screens[1] });
		expect(matchSource(sources, { display: 0 })).toEqual({ ok: true, source: screens[0] });
	});

	it("fails for a display index out of range", () => {
		const result = matchSource(sources, { display: 5 });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.candidates).toEqual(screens);
	});

	it("matches a window title case-insensitively by substring", () => {
		expect(matchSource(sources, { windowTitle: "orca" })).toEqual({ ok: true, source: orca });
	});

	it("refuses ambiguous window titles and lists the candidates", () => {
		const second: CaptureSourceSummary = {
			id: "window:12:0",
			name: "ORCA - Recordly",
			kind: "window",
		};
		const result = matchSource([...sources, second], { windowTitle: "orca" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.candidates).toEqual([orca, second]);
			expect(result.error).toMatch(/ambiguous|multiple/i);
		}
	});

	it("prefers the single window whose title equals the query exactly", () => {
		const app: CaptureSourceSummary = {
			id: "window:20:0",
			name: "ORCA · AI design coordination",
			kind: "window",
		};
		const chrome: CaptureSourceSummary = {
			id: "window:21:0",
			name: "ORCA · AI design coordination - Google Chrome",
			kind: "window",
		};
		const edge: CaptureSourceSummary = {
			id: "window:22:0",
			name: "ORCA · AI design coordination - Microsoft Edge",
			kind: "window",
		};
		expect(
			matchSource([...screens, chrome, app, edge], {
				windowTitle: "  orca · ai design coordination ",
			}),
		).toEqual({ ok: true, source: app });
	});

	it("stays ambiguous when more than one window matches exactly", () => {
		const a: CaptureSourceSummary = { id: "window:30:0", name: "ORCA", kind: "window" };
		const b: CaptureSourceSummary = { id: "window:31:0", name: "orca", kind: "window" };
		const c: CaptureSourceSummary = {
			id: "window:32:0",
			name: "ORCA - Chrome",
			kind: "window",
		};
		const result = matchSource([a, b, c], { windowTitle: "ORCA" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.candidates).toEqual([a, b, c]);
	});

	it("lists all windows when nothing matches", () => {
		const result = matchSource(sources, { windowTitle: "zzz" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.candidates).toEqual([orca, other]);
	});

	it("rejects malformed selectors", () => {
		const bad: unknown[] = [
			{},
			{ display: -1 },
			{ display: 1.5 },
			"x",
			null,
			undefined,
			3,
			{ windowTitle: "" },
			{ id: "" },
		];
		for (const selector of bad) {
			expect(matchSource(sources, selector).ok).toBe(false);
		}
	});
});
