import { describe, expect, it } from "vitest";
import {
	buildClipTimelineSlices,
	clipTimelineMatchesLegacy,
	getClipTimelineFrame,
	getClipCursorRegions,
} from "./clipTimeline";
import { getVisibleCursorTelemetry } from "@/components/video-editor/cursorVisibility";

const clips = [
	{ id: "last", startMs: 18000, endMs: 19000, sourceStartMs: 9000, sourceEndMs: 10000, speed: 1 },
	{ id: "fast", startMs: 1000, endMs: 7944, sourceStartMs: 5480, sourceEndMs: 19367, speed: 2 },
	{
		id: "reuse",
		startMs: 7944,
		endMs: 18011,
		sourceStartMs: 18081,
		sourceEndMs: 28148,
		speed: 1,
	},
];

describe("ordered export clip timeline", () => {
	it("selects the visible repeated clip while retaining hidden click-tail masking and its cache", () => {
		const hidden = {
			id: "hidden",
			startMs: 0,
			endMs: 1000,
			sourceStartMs: 0,
			speed: 1,
			hideCursor: true,
		};
		const visible = { id: "visible", startMs: 1000, endMs: 2000, sourceStartMs: 0, speed: 1 };
		const next = { id: "next", startMs: 2000, endMs: 3000, sourceStartMs: 1000, speed: 1 };
		const regions = [hidden, visible, next];
		const samples = [{ timeMs: 900, cx: 0.5, cy: 0.5, interactionType: "click" as const }];
		const active = getClipCursorRegions(regions, visible);
		expect(getVisibleCursorTelemetry(samples, active, 500)).toEqual(samples);
		expect(getClipCursorRegions(regions, visible)).toBe(active);
		const afterHidden = getClipCursorRegions(regions, next);
		expect(
			getVisibleCursorTelemetry(samples, afterHidden, 1100)[0].interactionType,
		).toBeUndefined();
		expect(
			getVisibleCursorTelemetry(samples, getClipCursorRegions(regions, hidden), 500),
		).toEqual([]);
	});

	it("retains legacy acceleration for normal clips, equivalent adjacent cuts and ordinary trim/speed edits", () => {
		expect(
			clipTimelineMatchesLegacy([{ id: "all", startMs: 0, endMs: 4000, speed: 1 }], 4000),
		).toBe(true);
		expect(
			clipTimelineMatchesLegacy(
				[
					{ id: "a", startMs: 0, endMs: 1000, speed: 1 },
					{ id: "b", startMs: 1000, endMs: 4000, speed: 1 },
				],
				4000,
			),
		).toBe(true);
		expect(
			clipTimelineMatchesLegacy(
				[
					{
						id: "a",
						startMs: 0,
						endMs: 1000,
						sourceStartMs: 0,
						sourceEndMs: 2000,
						speed: 2,
					},
					{
						id: "b",
						startMs: 3000,
						endMs: 4000,
						sourceStartMs: 3000,
						sourceEndMs: 4000,
						speed: 1,
					},
				],
				4000,
				[{ startMs: 2000, endMs: 3000 }],
				[{ id: "speed", startMs: 0, endMs: 2000, speed: 2 }],
			),
		).toBe(true);
		expect(clipTimelineMatchesLegacy(clips, 30000)).toBe(false);
		expect(
			clipTimelineMatchesLegacy(
				[
					{
						id: "pinned",
						startMs: 0,
						endMs: 1000,
						sourceStartMs: 0,
						sourceEndMs: 1999,
						speed: 2,
					},
				],
				1999,
				[],
				[{ id: "s", startMs: 0, endMs: 1999, speed: 2 }],
			),
		).toBe(false);
	});

	it("keeps reused and reordered source spans at their authored played lengths, omitting gaps", () => {
		const slices = buildClipTimelineSlices(clips);
		expect(slices.map((slice) => slice.clip.id)).toEqual(["fast", "reuse", "last"]);
		expect(slices.map((slice) => [slice.outputStartMs, slice.outputEndMs])).toEqual([
			[0, 6944],
			[6944, 17011],
			[17011, 18011],
		]);
		expect(slices[0].sourceEndMs).toBe(19367);
		expect(slices[0].speed).toBeCloseTo(13887 / 6944);
	});

	it("uses one global frame grid across sub-frame clips and selects the active repeated clip", () => {
		const slices = buildClipTimelineSlices(
			Array.from({ length: 10 }, (_, index) => ({
				id: String(index),
				startMs: index * 11,
				endMs: (index + 1) * 11,
				sourceStartMs: 1000,
				sourceEndMs: 1022,
				speed: 2,
				hideCursor: index % 2 === 0,
			})),
		);
		const count = Math.ceil((slices.at(-1)!.outputEndMs / 1000) * 30);
		expect(count).toBe(4);
		expect(
			Array.from(
				{ length: count },
				(_, index) => getClipTimelineFrame(slices, index, 30)?.clip.id,
			),
		).toEqual(["0", "3", "6", "9"]);
		expect(getClipTimelineFrame(slices, 3, 30)).toMatchObject({
			sourceTimestampMs: 1002,
			clip: { hideCursor: false },
		});
		expect(getClipTimelineFrame(slices, 4, 30)).toBeNull();
	});
});
