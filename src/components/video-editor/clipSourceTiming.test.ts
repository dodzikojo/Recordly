import { describe, expect, it } from "vitest";
import { normalizeProjectEditor } from "./projectPersistence";
import { buildTimelineItems } from "./timeline/model/timelineModel";
import { getActiveClipIdAtSourceTime } from "./audio/clipAudio";
import {
	clipsToTrims,
	getClipSourceEndMs,
	mapSourceTimeToTimelineTime,
	mapTimelineTimeToSourceTime,
	splitClipRegion,
	resizeClipRegion,
} from "./types";

describe("clip source timing", () => {
	it("keeps both source spans positive when a slow clip is split near its edge", () => {
		const result = splitClipRegion(
			{ id: "a", startMs: 0, endMs: 2002, speed: 0.5, sourceStartMs: 0, sourceEndMs: 1001 },
			2001,
			"l",
			"r",
		);
		expect(result).not.toBeNull();
		const [left, right] = result!;
		expect(getClipSourceEndMs(left)).toBe(right.sourceStartMs);
		expect(getClipSourceEndMs(left)).toBe(1000);
		expect(getClipSourceEndMs(right)).toBe(1001);
	});
	it("safely declines splits without two positive integer source spans", () => {
		expect(
			splitClipRegion(
				{ id: "tiny", startMs: 0, endMs: 2, speed: 0.5, sourceStartMs: 0, sourceEndMs: 1 },
				1,
				"l",
				"r",
			),
		).toBeNull();
	});
	it("preserves exact source ends through rounded-speed splits, moves and trims", () => {
		const clip = {
			id: "a",
			startMs: 0,
			endMs: 501,
			speed: 2,
			sourceStartMs: 1000,
			sourceEndMs: 2001,
		};
		expect(getClipSourceEndMs(clip)).toBe(2001);
		const [left, right] = splitClipRegion(clip, 250, "l", "r")!;
		expect(getClipSourceEndMs(left)).toBe(1500);
		expect(right.sourceStartMs).toBe(1500);
		expect(getClipSourceEndMs(right)).toBe(2001);
		expect(getClipSourceEndMs(resizeClipRegion(clip, 1000, 1501))).toBe(2001);
		expect(getClipSourceEndMs(resizeClipRegion(clip, 10, 501))).toBe(2001);
		expect(getClipSourceEndMs(resizeClipRegion(clip, 0, 500))).toBe(1999);
	});
	it("uses explicit source bounds for thumbnails and active source audio", () => {
		const clip = { id: "a", startMs: 3000, endMs: 5000, speed: 5, sourceStartMs: 11000 };
		const items = buildTimelineItems({
			clipRegions: [clip],
			zoomRegions: [],
			audioRegions: [],
			annotationRegions: [],
		});
		expect(items.find((item) => item.id === "a")?.sourceSpan).toEqual({
			start: 11000,
			end: 21000,
		});
		expect(getActiveClipIdAtSourceTime(16, [clip])).toBe("a");
		expect(getActiveClipIdAtSourceTime(4, [clip])).toBeNull();
	});
	it("keeps split sped-up clips on consecutive source frames", () => {
		const [left, right] = splitClipRegion(
			{ id: "a", startMs: 1000, endMs: 5000, speed: 5 },
			3000,
			"l",
			"r",
		)!;
		expect(getClipSourceEndMs(left)).toBe(11000);
		expect(mapTimelineTimeToSourceTime(3000, [left, right])).toBe(11000);
		expect(mapSourceTimeToTimelineTime(16000, [left, right])).toBe(4000);
		expect(getClipSourceEndMs(right)).toBe(21000);
	});
	it("maps a removed gap boundary to the matching coordinate system", () => {
		const clips = [
			{ id: "a", startMs: 1000, endMs: 3000, speed: 5, sourceStartMs: 1000 },
			{ id: "b", startMs: 4000, endMs: 6000, speed: 2, sourceStartMs: 15000 },
		];
		expect(mapTimelineTimeToSourceTime(3500, clips)).toBe(11000);
		expect(mapSourceTimeToTimelineTime(12000, clips)).toBe(3000);
		expect(clipsToTrims(clips, 20000)).toEqual([
			{ id: "trim-gap-1", startMs: 0, endMs: 1000 },
			{ id: "trim-gap-2", startMs: 11000, endMs: 15000 },
			{ id: "trim-gap-3", startMs: 19000, endMs: 20000 },
		]);
	});
	it("preserves source footage when moving and scales left trims by speed", () => {
		const clip = { id: "a", startMs: 1000, endMs: 5000, speed: 5, sourceStartMs: 10000 };
		expect(resizeClipRegion(clip, 2000, 6000).sourceStartMs).toBe(10000);
		expect(resizeClipRegion(clip, 2000, 5000).sourceStartMs).toBe(15000);
	});
	it("repairs the saved overlapping legacy clips without changing their speed or source starts", () => {
		const editor = normalizeProjectEditor({
			clipRegions: [
				{ id: "clip-42", startMs: 39332, endMs: 49781, speed: 5 },
				{ id: "clip-43", startMs: 49781, endMs: 51864, speed: 10 },
			],
		});
		const clips = editor.clipRegions;
		expect(getClipSourceEndMs(clips[0])).toBeLessThanOrEqual(49781);
		expect(mapSourceTimeToTimelineTime(mapTimelineTimeToSourceTime(50000, clips), clips)).toBe(
			50000,
		);
		expect(normalizeProjectEditor(JSON.parse(JSON.stringify(editor))).clipRegions).toEqual(
			clips,
		);
	});
});
