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
	ingestAgentCursorEvents,
	MAX_AGENT_CURSOR_BATCH,
	mapCssCursorToVisualType,
} from "./agentCursor";
import { pauseCursorCapture, resetCursorCaptureClock } from "./telemetry";

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
