import { describe, expect, it } from "vitest";
import { getClipSourceEndMs } from "./types";

import {
	type BlockedClipSpeedChange,
	formatClipSpeedLabel,
	planClipSpeedChange,
} from "./clipSpeedChange";

describe("formatClipSpeedLabel", () => {
	it("returns labels only for non-default positive speeds", () => {
		expect(formatClipSpeedLabel(1)).toBeNull();
		expect(formatClipSpeedLabel(0)).toBeNull();
		expect(formatClipSpeedLabel(-1)).toBeNull();
		expect(formatClipSpeedLabel(Number.POSITIVE_INFINITY)).toBeNull();
		expect(formatClipSpeedLabel(Number.NaN)).toBeNull();
		expect(formatClipSpeedLabel(0.5)).toBe("0.5x");
		expect(formatClipSpeedLabel(2)).toBe("2x");
	});
});

describe("planClipSpeedChange", () => {
	it("does not grow source duration when a rounded speed change is reversed", () => {
		const first = planClipSpeedChange({
			clipRegions: [{ id: "a", startMs: 0, endMs: 1001, speed: 1 }],
			zoomRegions: [],
			selectedClipId: "a",
			speed: 2,
		});
		if (!first || "blockedReason" in first) throw new Error("Unexpected blocked edit");
		expect(getClipSourceEndMs(first.clipRegions[0])).toBe(1001);
		const restored = planClipSpeedChange({ ...first, selectedClipId: "a", speed: 1 });
		if (!restored || "blockedReason" in restored) throw new Error("Unexpected blocked edit");
		expect(restored.clipRegions[0].endMs).toBe(1001);
	});
	it("returns null for missing clips and invalid speeds", () => {
		const clipRegions = [{ id: "clip-1", startMs: 0, endMs: 5_000, speed: 1 }];

		expect(
			planClipSpeedChange({
				clipRegions,
				zoomRegions: [],
				selectedClipId: "missing",
				speed: 0.5,
			}),
		).toBeNull();

		for (const speed of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(
				planClipSpeedChange({
					clipRegions,
					zoomRegions: [],
					selectedClipId: "clip-1",
					speed,
				}),
			).toBeNull();
		}
	});

	it("extends an isolated clip when slowing it down", () => {
		const result = planClipSpeedChange({
			clipRegions: [{ id: "clip-1", startMs: 0, endMs: 5_000, speed: 1 }],
			zoomRegions: [],
			selectedClipId: "clip-1",
			speed: 0.5,
		});

		expect(result).toEqual({
			clipRegions: [
				{ id: "clip-1", startMs: 0, endMs: 10_000, speed: 0.5, sourceEndMs: 5000 },
			],
			zoomRegions: [],
		});
	});

	it("shortens an isolated clip when speeding it up", () => {
		const result = planClipSpeedChange({
			clipRegions: [{ id: "clip-1", startMs: 0, endMs: 6_000, speed: 1 }],
			zoomRegions: [],
			selectedClipId: "clip-1",
			speed: 2,
		});

		expect(result).toEqual({
			clipRegions: [{ id: "clip-1", startMs: 0, endMs: 3_000, speed: 2, sourceEndMs: 6000 }],
			zoomRegions: [],
		});
	});

	it("treats invalid stored clip speed as 1x", () => {
		const result = planClipSpeedChange({
			clipRegions: [{ id: "clip-1", startMs: 0, endMs: 4_000, speed: Number.NaN }],
			zoomRegions: [],
			selectedClipId: "clip-1",
			speed: 0.5,
		});

		expect(result).toEqual({
			clipRegions: [
				{ id: "clip-1", startMs: 0, endMs: 8_000, speed: 0.5, sourceEndMs: 4000 },
			],
			zoomRegions: [],
		});
	});

	it("blocks slow speed changes that would overlap the next clip", () => {
		const result = planClipSpeedChange({
			clipRegions: [
				{ id: "clip-1", startMs: 0, endMs: 5_000, speed: 1 },
				{ id: "clip-2", startMs: 5_000, endMs: 10_000, speed: 1 },
			],
			zoomRegions: [],
			selectedClipId: "clip-1",
			speed: 0.5,
		}) as BlockedClipSpeedChange;

		expect(result.blockedReason).toBe("clip-overlap");
	});

	it("scales zoom regions inside the changed clip", () => {
		const result = planClipSpeedChange({
			clipRegions: [{ id: "clip-1", startMs: 1_000, endMs: 5_000, speed: 1 }],
			zoomRegions: [
				{
					id: "zoom-1",
					startMs: 2_000,
					endMs: 3_000,
					depth: 2,
					focus: { cx: 0.5, cy: 0.5 },
				},
			],
			selectedClipId: "clip-1",
			speed: 0.5,
		});

		expect(result).toEqual({
			clipRegions: [
				{ id: "clip-1", startMs: 1_000, endMs: 9_000, speed: 0.5, sourceEndMs: 5000 },
			],
			zoomRegions: [
				{
					id: "zoom-1",
					startMs: 3_000,
					endMs: 5_000,
					depth: 2,
					focus: { cx: 0.5, cy: 0.5 },
				},
			],
		});
	});

	it("does not scale zoom regions that start outside the changed clip", () => {
		const result = planClipSpeedChange({
			clipRegions: [{ id: "clip-1", startMs: 2_000, endMs: 6_000, speed: 1 }],
			zoomRegions: [
				{
					id: "zoom-before",
					startMs: 1_000,
					endMs: 1_500,
					depth: 2,
					focus: { cx: 0.5, cy: 0.5 },
				},
				{
					id: "zoom-after",
					startMs: 6_000,
					endMs: 6_500,
					depth: 2,
					focus: { cx: 0.5, cy: 0.5 },
				},
			],
			selectedClipId: "clip-1",
			speed: 0.5,
		});

		expect(result).toEqual({
			clipRegions: [
				{ id: "clip-1", startMs: 2_000, endMs: 10_000, speed: 0.5, sourceEndMs: 6000 },
			],
			zoomRegions: [
				{
					id: "zoom-before",
					startMs: 1_000,
					endMs: 1_500,
					depth: 2,
					focus: { cx: 0.5, cy: 0.5 },
				},
				{
					id: "zoom-after",
					startMs: 6_000,
					endMs: 6_500,
					depth: 2,
					focus: { cx: 0.5, cy: 0.5 },
				},
			],
		});
	});

	it("blocks speed changes that would make scaled zooms overlap unchanged zooms", () => {
		const result = planClipSpeedChange({
			clipRegions: [{ id: "clip-1", startMs: 0, endMs: 5_000, speed: 1 }],
			zoomRegions: [
				{
					id: "zoom-1",
					startMs: 2_000,
					endMs: 3_000,
					depth: 2,
					focus: { cx: 0.5, cy: 0.5 },
				},
				{
					id: "zoom-2",
					startMs: 5_500,
					endMs: 6_500,
					depth: 3,
					focus: { cx: 0.5, cy: 0.5 },
				},
			],
			selectedClipId: "clip-1",
			speed: 0.5,
		}) as BlockedClipSpeedChange;

		expect(result.blockedReason).toBe("zoom-overlap");
	});
});
