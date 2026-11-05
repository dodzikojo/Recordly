import { describe, expect, it } from "vitest";
import {
	calculateAxisScale,
	calculateTimelineScale,
	createInitialRange,
	getTimelineContentEndMs,
	formatPlayheadTime,
	formatTimeLabel,
	normalizeWheelDeltaToPixels,
} from "./time";

describe("timeline core/time", () => {
	it("creates fallback range for empty or invalid duration", () => {
		expect(createInitialRange(0)).toEqual({ start: 0, end: 1000 });
		expect(createInitialRange(-10)).toEqual({ start: 0, end: 1000 });
		expect(createInitialRange(2500)).toEqual({ start: 0, end: 2500 });
	});

	it("fits the opening view to a short edit of a long recording", () => {
		const end = getTimelineContentEndMs([{ endMs: 12_000 }, { endMs: 36_796 }], 1_064_618);
		expect(createInitialRange(1_064_618, end)).toEqual({ start: 0, end: 36_796 });
	});

	it("includes trailing audio/effects and preserves gaps rather than summing clip lengths", () => {
		expect(
			getTimelineContentEndMs(
				[{ endMs: 10_000 }, { endMs: 25_000 }, { endMs: 40_000 }],
				60_000,
			),
		).toBe(40_000);
	});

	it("keeps the full recording view when there are no timed items", () => {
		expect(getTimelineContentEndMs([], 60_000)).toBe(60_000);
		expect(createInitialRange(60_000, 60_000)).toEqual({ start: 0, end: 60_000 });
	});

	it("ignores invalid item endpoints and keeps the view inside timeline bounds", () => {
		expect(
			getTimelineContentEndMs(
				[{ endMs: NaN }, { endMs: Infinity }, { endMs: -1 }, { endMs: 12_000 }],
				60_000,
			),
		).toBe(12_000);
		expect(getTimelineContentEndMs([{ endMs: 90_000 }], 60_000)).toBe(60_000);
		expect(getTimelineContentEndMs([{ endMs: NaN }], 60_000)).toBe(60_000);
	});

	it("computes scale defaults and caps", () => {
		expect(calculateTimelineScale(0)).toEqual({
			minItemDurationMs: 100,
			defaultItemDurationMs: 1000,
			minVisibleRangeMs: 300,
		});
		expect(calculateTimelineScale(1).defaultItemDurationMs).toBe(100);
		expect(calculateTimelineScale(100).defaultItemDurationMs).toBe(5000);
		expect(calculateTimelineScale(10_000).defaultItemDurationMs).toBe(30000);
	});

	it("formats timeline labels in fractional, whole-second, and hour modes", () => {
		expect(formatTimeLabel(1234, 100)).toBe("0:01.23");
		expect(formatTimeLabel(1234, 500)).toBe("0:01.2");
		expect(formatTimeLabel(61_900, 1000)).toBe("1:01");
		expect(formatTimeLabel(3_661_999, 1000)).toBe("1:01:01");
	});

	it("formats playhead labels for sub-minute and minute timelines", () => {
		expect(formatPlayheadTime(1234)).toBe("1.2s");
		expect(formatPlayheadTime(61_400)).toBe("1:01.4");
	});

	it("normalizes wheel delta by deltaMode", () => {
		expect(normalizeWheelDeltaToPixels(2, 0)).toBe(2);
		expect(normalizeWheelDeltaToPixels(2, 1)).toBe(32);
		expect(normalizeWheelDeltaToPixels(2, 2)).toBe(480);
		expect(normalizeWheelDeltaToPixels(-3, 1)).toBe(-48);
	});

	it("picks fine and coarse axis scales based on visible range", () => {
		const tiny = calculateAxisScale(1);
		const typical = calculateAxisScale(2000);
		const huge = calculateAxisScale(24 * 60 * 60 * 1000);

		expect(tiny.intervalMs).toBeGreaterThan(0);
		expect(tiny.gridMs).toBeGreaterThan(0);
		expect(typical.intervalMs).toBeGreaterThanOrEqual(tiny.intervalMs);
		expect(huge.intervalMs).toBeGreaterThanOrEqual(typical.intervalMs);
	});
});
