import { describe, expect, it } from "vitest";
import { normalizeExistingRegionSpan, normalizeRegionSpan, spansOverlap } from "./spans";

describe("timeline core/spans", () => {
	it("preserves an authored 1 ms visual after gap collapse during passive normalization", () => {
		expect(
			normalizeExistingRegionSpan({
				startMs: 2000,
				endMs: 2001,
				totalMs: 10000,
				minDurationMs: 100,
			}),
		).toEqual({ start: 2000, end: 2001 });
	});

	it("keeps independent narration duration beyond the video end", () => {
		expect(
			normalizeExistingRegionSpan(
				{ startMs: 2000, endMs: 12000, totalMs: 5000, minDurationMs: 100 },
				true,
			),
		).toEqual({ start: 2000, end: 12000 });
	});

	it("still repairs zero-duration and invalid existing regions", () => {
		expect(
			normalizeExistingRegionSpan({
				startMs: 100,
				endMs: 100,
				totalMs: 1000,
				minDurationMs: 100,
			}),
		).toEqual({ start: 100, end: 200 });
		expect(
			normalizeExistingRegionSpan(
				{ startMs: Number.NaN, endMs: Number.NaN, totalMs: 1000, minDurationMs: 100 },
				true,
			),
		).toEqual({ start: 0, end: 100 });
	});
	it("treats adjacent spans as non-overlapping", () => {
		expect(spansOverlap({ start: 0, end: 100 }, { start: 100, end: 200 })).toBe(false);
	});

	it("detects strict overlap and containment", () => {
		expect(spansOverlap({ start: 0, end: 101 }, { start: 100, end: 200 })).toBe(true);
		expect(spansOverlap({ start: 50, end: 150 }, { start: 75, end: 100 })).toBe(true);
	});

	it("normalizes region to bounds and enforces min duration", () => {
		expect(
			normalizeRegionSpan({ startMs: -50, endMs: 10, totalMs: 1000, minDurationMs: 100 }),
		).toEqual({ start: 0, end: 100 });
	});

	it("clamps start when requested end exceeds total", () => {
		expect(
			normalizeRegionSpan({ startMs: 980, endMs: 1200, totalMs: 1000, minDurationMs: 100 }),
		).toEqual({ start: 900, end: 1000 });
	});

	it("keeps already valid spans unchanged", () => {
		expect(
			normalizeRegionSpan({ startMs: 100, endMs: 300, totalMs: 1000, minDurationMs: 50 }),
		).toEqual({ start: 100, end: 300 });
	});

	it("never exceeds total when min duration is larger than total", () => {
		expect(
			normalizeRegionSpan({ startMs: 100, endMs: 300, totalMs: 80, minDurationMs: 100 }),
		).toEqual({ start: 0, end: 80 });
	});
});
