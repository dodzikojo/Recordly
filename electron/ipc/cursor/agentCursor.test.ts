import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: {
		getPath: vi.fn(() => "/tmp"),
	},
}));

vi.mock("../utils", () => ({
	getTelemetryPathForVideo: vi.fn(() => "/tmp/recording.cursor.json"),
	getScreen: vi.fn(() => {
		const display = { id: 1, bounds: { x: 0, y: 0, width: 1000, height: 500 }, scaleFactor: 1 };
		return {
			getCursorScreenPoint: () => ({ x: 0, y: 0 }),
			getPrimaryDisplay: () => display,
			getDisplayNearestPoint: () => display,
			getAllDisplays: () => [display],
		};
	}),
}));

import {
	activeCursorSamples,
	agentCursorTakeActive,
	lastAgentCursorEventAtMs,
	nativeCaptureStartedAtMs,
	setActiveCursorSamples,
	setAgentCursorTakeActive,
	setCursorCaptureStartTimeMs,
	setIsCursorCaptureActive,
	setLastAgentCursorEventAtMs,
	setLastLeftClick,
	setSelectedSource,
} from "../state";
import {
	AgentCursorInactiveError,
	clearNativeCaptureStart,
	computeAgentCursorTimeLeadMs,
	ingestAgentCursorEvents,
	MAX_AGENT_CURSOR_BATCH,
	mapCssCursorToVisualType,
	markNativeCapturePaused,
	markNativeCaptureResumed,
	markNativeCaptureStarted,
	resolveCursorClockStartMs,
} from "./agentCursor";
import {
	pauseCursorCapture,
	pauseCursorCaptureAtBoundary,
	resetCursorCaptureClock,
} from "./telemetry";

function lastSample() {
	return activeCursorSamples[activeCursorSamples.length - 1];
}

describe("mapCssCursorToVisualType", () => {
	it("maps CSS cursors", () => {
		expect(mapCssCursorToVisualType("pointer")).toBe("pointer");
		expect(mapCssCursorToVisualType("text")).toBe("text");
		expect(mapCssCursorToVisualType("grab")).toBe("open-hand");
		expect(mapCssCursorToVisualType("grabbing")).toBe("closed-hand");
		expect(mapCssCursorToVisualType("ew-resize")).toBe("resize-ew");
		expect(mapCssCursorToVisualType("col-resize")).toBe("resize-ew");
		expect(mapCssCursorToVisualType("ns-resize")).toBe("resize-ns");
		expect(mapCssCursorToVisualType("row-resize")).toBe("resize-ns");
		expect(mapCssCursorToVisualType("not-allowed")).toBe("not-allowed");
		expect(mapCssCursorToVisualType("crosshair")).toBe("crosshair");
		expect(mapCssCursorToVisualType("auto")).toBe("arrow");
		expect(mapCssCursorToVisualType("default")).toBe("arrow");
		expect(mapCssCursorToVisualType(undefined)).toBe("arrow");
		expect(mapCssCursorToVisualType("weird")).toBe("arrow");
	});
});

describe("ingestAgentCursorEvents", () => {
	beforeEach(() => {
		setSelectedSource(null);
		setActiveCursorSamples([]);
		setLastLeftClick(null);
		setLastAgentCursorEventAtMs(null);
		resetCursorCaptureClock();
		setCursorCaptureStartTimeMs(10_000);
		setIsCursorCaptureActive(true);
		setAgentCursorTakeActive(true);
	});

	it("stamps events on the video timeline when the clock is backdated by the lead", () => {
		// The handler backdates the clock: wall start 10_000, native lead 900.
		setCursorCaptureStartTimeMs(10_000 - computeAgentCursorTimeLeadMs(10_000, 9_100));
		ingestAgentCursorEvents([{ atMs: 10_250, x: 500, y: 250, kind: "move" }]);
		expect(lastSample().timeMs).toBe(1_150);
		// Ordering still uses the raw atMs.
		expect(lastAgentCursorEventAtMs).toBe(10_250);
	});

	it("keeps events inside the lead window when pausing, and still rejects while paused", () => {
		setCursorCaptureStartTimeMs(9_100);
		ingestAgentCursorEvents([
			{ atMs: 10_400, x: 100, y: 100, kind: "down" },
			{ atMs: 10_500, x: 100, y: 100, kind: "up" },
		]);
		expect(activeCursorSamples.map((sample) => sample.timeMs)).toEqual([1_300, 1_400]);

		pauseCursorCaptureAtBoundary(10_550);
		expect(activeCursorSamples.map((sample) => sample.timeMs)).toEqual([1_300, 1_400]);

		const result = ingestAgentCursorEvents([{ atMs: 10_700, x: 10, y: 10, kind: "move" }]);
		expect(result.rejected).toEqual([{ index: 0, reason: "paused" }]);
		expect(activeCursorSamples).toHaveLength(2);
	});

	it("ingests a move", () => {
		const result = ingestAgentCursorEvents([
			{ atMs: 10_250, x: 500, y: 250, kind: "move", cursor: "pointer" },
		]);

		expect(result).toEqual({ accepted: 1, rejected: [] });
		expect(lastSample()).toEqual({
			timeMs: 250,
			cx: 0.5,
			cy: 0.5,
			interactionType: "move",
			cursorType: "pointer",
		});
		expect(lastAgentCursorEventAtMs).toBe(10_250);
	});

	it("classifies down as click, two quick downs as double-click, right button as right-click", () => {
		ingestAgentCursorEvents([{ atMs: 10_100, x: 100, y: 100, kind: "down" }]);
		expect(lastSample().interactionType).toBe("click");

		ingestAgentCursorEvents([{ atMs: 10_300, x: 100, y: 100, kind: "down" }]);
		expect(lastSample().interactionType).toBe("double-click");

		ingestAgentCursorEvents([{ atMs: 10_900, x: 100, y: 100, kind: "down", button: "right" }]);
		expect(lastSample().interactionType).toBe("right-click");

		ingestAgentCursorEvents([{ atMs: 11_000, x: 100, y: 100, kind: "down", button: "middle" }]);
		expect(lastSample().interactionType).toBe("middle-click");
	});

	it("up records mouseup", () => {
		const result = ingestAgentCursorEvents([{ atMs: 10_400, x: 200, y: 100, kind: "up" }]);

		expect(result.accepted).toBe(1);
		expect(lastSample()).toMatchObject({
			timeMs: 400,
			cx: 0.2,
			cy: 0.2,
			interactionType: "mouseup",
		});
	});

	it("rejects per event, keeps the rest", () => {
		const result = ingestAgentCursorEvents([
			{ atMs: 10_100, x: 10, y: 10, kind: "move" },
			{ atMs: 10_150, x: Number.NaN, y: 10, kind: "move" },
			{ atMs: 10_160, x: 10, y: 10, kind: "jump" },
			{ atMs: 10_200, x: 20, y: 20, kind: "move" },
		]);

		expect(result.accepted).toBe(2);
		expect(result.rejected.map((entry) => entry.index)).toEqual([1, 2]);
		expect(activeCursorSamples).toHaveLength(2);
	});

	it("rejects null and non-object entries without throwing", () => {
		const result = ingestAgentCursorEvents([
			null,
			42,
			"x",
			{ atMs: "soon", x: 1, y: 1, kind: "move" },
		]);

		expect(result.accepted).toBe(0);
		expect(result.rejected.map((entry) => entry.index)).toEqual([0, 1, 2, 3]);
	});

	it("rejects events older than the last accepted one", () => {
		ingestAgentCursorEvents([{ atMs: 10_500, x: 10, y: 10, kind: "move" }]);

		const result = ingestAgentCursorEvents([{ atMs: 10_400, x: 10, y: 10, kind: "move" }]);

		expect(result.accepted).toBe(0);
		expect(result.rejected).toHaveLength(1);
		expect(result.rejected[0].reason).toContain("out of order");
		expect(activeCursorSamples).toHaveLength(1);
	});

	it("rejects an event stamped more than 5 s in the future, so it can't block later events", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(10_100);
		try {
			const result = ingestAgentCursorEvents([
				{ atMs: 15_101, x: 10, y: 10, kind: "move" },
				{ atMs: 10_200, x: 10, y: 10, kind: "move" },
				{ atMs: 15_100, x: 20, y: 20, kind: "move" },
			]);

			expect(result.accepted).toBe(2);
			expect(result.rejected).toEqual([{ index: 0, reason: "timestamp in the future" }]);
			expect(lastAgentCursorEventAtMs).toBe(15_100);
		} finally {
			now.mockRestore();
		}
	});

	it("drops events while paused", () => {
		pauseCursorCapture(10_600);

		const result = ingestAgentCursorEvents([{ atMs: 10_700, x: 10, y: 10, kind: "move" }]);

		expect(result.accepted).toBe(0);
		expect(result.rejected).toEqual([{ index: 0, reason: "paused" }]);
		expect(activeCursorSamples).toHaveLength(0);
	});

	it("throws AgentCursorInactiveError when the agent take is not active", () => {
		setAgentCursorTakeActive(false);

		expect(() =>
			ingestAgentCursorEvents([{ atMs: 10_100, x: 10, y: 10, kind: "move" }]),
		).toThrow(AgentCursorInactiveError);
		expect(agentCursorTakeActive).toBe(false);
	});

	it("throws AgentCursorInactiveError when capture is inactive", () => {
		setIsCursorCaptureActive(false);

		expect(() =>
			ingestAgentCursorEvents([{ atMs: 10_100, x: 10, y: 10, kind: "move" }]),
		).toThrow(AgentCursorInactiveError);
	});

	it("rejects a non-array or a batch over MAX_AGENT_CURSOR_BATCH", () => {
		const notArray = ingestAgentCursorEvents({ atMs: 10_100 });
		expect(notArray.accepted).toBe(0);
		expect(notArray.rejected.length).toBeGreaterThan(0);

		const oversized = Array.from({ length: MAX_AGENT_CURSOR_BATCH + 1 }, (_, i) => ({
			atMs: 10_000 + i,
			x: 1,
			y: 1,
			kind: "move",
		}));
		const result = ingestAgentCursorEvents(oversized);

		expect(result.accepted).toBe(0);
		expect(result.rejected).toHaveLength(MAX_AGENT_CURSOR_BATCH + 1);
		expect(activeCursorSamples).toHaveLength(0);
	});
});

describe("native capture start clock", () => {
	beforeEach(() => {
		clearNativeCaptureStart();
		setIsCursorCaptureActive(false);
	});

	it("keeps the start stamp when capture never paused", () => {
		markNativeCaptureStarted(10_000);
		expect(nativeCaptureStartedAtMs).toBe(10_000);
		expect(resolveCursorClockStartMs(10_900, true)).toBe(10_000);
	});

	it("shifts the start by a pre-take pause (the countdown), which the helper drops from the video", () => {
		markNativeCaptureStarted(10_000);
		markNativeCapturePaused(10_050);
		markNativeCaptureResumed(13_050);
		expect(nativeCaptureStartedAtMs).toBe(13_000);
		// The take starts 0.9 s after the effective start: lead 900, clock backdated to it.
		expect(computeAgentCursorTimeLeadMs(13_900, nativeCaptureStartedAtMs)).toBe(900);
		expect(resolveCursorClockStartMs(13_900, true)).toBe(13_000);
	});

	it("ignores a resume without a tracked pause", () => {
		markNativeCaptureStarted(10_000);
		markNativeCaptureResumed(12_000);
		expect(nativeCaptureStartedAtMs).toBe(10_000);
	});

	it("leaves pauses during the take to the cursor clock's own accounting", () => {
		markNativeCaptureStarted(10_000);
		setIsCursorCaptureActive(true);
		markNativeCapturePaused(12_000);
		markNativeCaptureResumed(14_000);
		expect(nativeCaptureStartedAtMs).toBe(10_000);
	});

	it("tracks nothing without a start stamp, and a new start drops a pause left open", () => {
		markNativeCapturePaused(10_000);
		markNativeCaptureResumed(11_000);
		expect(nativeCaptureStartedAtMs).toBeNull();

		markNativeCaptureStarted(20_000);
		markNativeCapturePaused(20_050);
		markNativeCaptureStarted(30_000);
		markNativeCaptureResumed(31_000);
		expect(nativeCaptureStartedAtMs).toBe(30_000);
	});

	it("counts a pause still open when the take starts up to that moment", () => {
		markNativeCaptureStarted(10_000);
		markNativeCapturePaused(10_050);
		// 50 ms of video were captured before the pause.
		expect(resolveCursorClockStartMs(13_950, true)).toBe(13_900);
	});

	it("keeps human takes on the wall clock", () => {
		markNativeCaptureStarted(10_000);
		markNativeCapturePaused(10_050);
		markNativeCaptureResumed(13_050);
		expect(resolveCursorClockStartMs(13_900, false)).toBe(13_900);
	});

	it("falls back to the wall clock with no stamp, a stale stamp, or after clearing", () => {
		expect(resolveCursorClockStartMs(10_900, true)).toBe(10_900);

		markNativeCaptureStarted(10_000);
		expect(resolveCursorClockStartMs(25_000, true)).toBe(25_000);

		markNativeCapturePaused(10_050);
		clearNativeCaptureStart();
		expect(nativeCaptureStartedAtMs).toBeNull();
		markNativeCaptureResumed(13_050);
		expect(resolveCursorClockStartMs(13_900, true)).toBe(13_900);
	});
});

describe("computeAgentCursorTimeLeadMs", () => {
	it("returns the gap between the cursor clock and the native capture start", () => {
		expect(computeAgentCursorTimeLeadMs(10_900, 10_000)).toBe(900);
		expect(computeAgentCursorTimeLeadMs(10_000, 10_000)).toBe(0);
		expect(computeAgentCursorTimeLeadMs(20_000, 10_000)).toBe(10_000);
	});

	it("falls back to 0 for a missing, negative or implausible stamp", () => {
		expect(computeAgentCursorTimeLeadMs(10_900, null)).toBe(0);
		expect(computeAgentCursorTimeLeadMs(10_000, 10_900)).toBe(0);
		expect(computeAgentCursorTimeLeadMs(20_001, 10_000)).toBe(0);
		expect(computeAgentCursorTimeLeadMs(Number.NaN, 10_000)).toBe(0);
		expect(computeAgentCursorTimeLeadMs(10_900, Number.NaN)).toBe(0);
	});
});
