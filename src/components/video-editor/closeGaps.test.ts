import { describe, expect, it } from "vitest";
import {
	createEditorHistoryStack,
	recordEditorHistorySnapshot,
	redoEditorHistoryStack,
	undoEditorHistoryStack,
	type EditorHistorySnapshot,
} from "./editorHistory";
import { findTimelineGaps, planCloseTimelineGaps, resolveGapClosureSourceTime } from "./closeGaps";
import { normalizeProjectEditor } from "./projectPersistence";
import {
	DEFAULT_ANNOTATION_STYLE,
	getClipSourceEndMs,
	getClipSourceStartMs,
	mapTimelineTimeToSourceTime,
} from "./types";

const state = (): EditorHistorySnapshot => ({
	clipRegions: [
		{ id: "a", startMs: 1000, endMs: 2000, speed: 2, muted: true },
		{ id: "b", startMs: 3000, endMs: 4000, speed: 1, sourceStartMs: 6000 },
		{ id: "c", startMs: 6000, endMs: 8000, speed: 0.5 },
	],
	zoomRegions: [],
	annotationRegions: [],
	audioRegions: [],
	autoCaptions: [],
	speedRegions: [],
	selectedClipId: null,
	selectedZoomId: null,
	selectedAnnotationId: null,
	selectedAudioId: null,
});

describe("closing existing timeline gaps", () => {
	it("keeps the current source frame only when retained footage contains it", () => {
		const clips = planCloseTimelineGaps(state())!.clipRegions;
		expect(resolveGapClosureSourceTime(1500.25, clips)).toBe(1500.25);
		expect(resolveGapClosureSourceTime(0, clips)).toBe(1000);
		expect(resolveGapClosureSourceTime(4500, clips)).toBe(6000);
		expect(resolveGapClosureSourceTime(9000, clips)).toBe(6999);
		expect(resolveGapClosureSourceTime(7000, clips)).toBe(6999);
	});
	it("finds leading and interior gaps in timeline order, never an unused source tail", () => {
		const clips = state().clipRegions.reverse();
		expect(findTimelineGaps(clips)).toEqual([
			{ startMs: 0, endMs: 1000 },
			{ startMs: 2000, endMs: 3000 },
			{ startMs: 4000, endMs: 6000 },
		]);
		expect(clips[0].id).toBe("c");
		expect(findTimelineGaps([])).toEqual([]);
		expect(
			findTimelineGaps([
				{ id: "a", startMs: 0, endMs: 1000, speed: 1 },
				{ id: "b", startMs: 1000, endMs: 2000, speed: 1 },
			]),
		).toEqual([]);
	});

	it("uses covered interval ends when clips overlap", () => {
		expect(
			findTimelineGaps([
				{ id: "a", startMs: 0, endMs: 2000, speed: 1 },
				{ id: "b", startMs: 500, endMs: 1000, speed: 1 },
				{ id: "c", startMs: 2500, endMs: 3000, speed: 1 },
			]),
		).toEqual([{ startMs: 2000, endMs: 2500 }]);
	});

	it("closes exactly one gap while preserving other gaps and all source bounds", () => {
		const original = state();
		const result = planCloseTimelineGaps(original, { startMs: 2000, endMs: 3000 })!;
		expect(result.clipRegions.map((c) => [c.startMs, c.endMs])).toEqual([
			[1000, 2000],
			[2000, 3000],
			[5000, 7000],
		]);
		expect(result.clipRegions.map(getClipSourceStartMs)).toEqual(
			original.clipRegions.map(getClipSourceStartMs),
		);
		expect(result.clipRegions.map(getClipSourceEndMs)).toEqual(
			original.clipRegions.map(getClipSourceEndMs),
		);
		expect(result.clipRegions[0].muted).toBe(true);
		expect(result.clipRegions[2].sourceStartMs).toBe(6000);
		expect(mapTimelineTimeToSourceTime(6000, result.clipRegions)).toBe(6500);
		expect(original.clipRegions[2].startMs).toBe(6000);
	});

	it("closes all gaps atomically, pins legacy sped-up source starts, and is idempotent", () => {
		const original = state();
		original.clipRegions.reverse();
		const result = planCloseTimelineGaps(original)!;
		expect(result.clipRegions.map((c) => [c.id, c.startMs, c.endMs])).toEqual([
			["c", 2000, 4000],
			["b", 1000, 2000],
			["a", 0, 1000],
		]);
		expect(result.clipRegions.map(getClipSourceStartMs)).toEqual([6000, 6000, 1000]);
		expect(result.clipRegions.map(getClipSourceEndMs)).toEqual([7000, 7000, 3000]);
		expect(findTimelineGaps(result.clipRegions)).toEqual([]);
		expect(planCloseTimelineGaps(result)).toBeNull();
	});

	it("rejects stale, partial, occupied and trailing spans instead of removing footage", () => {
		for (const gap of [
			{ startMs: 2000, endMs: 2500 },
			{ startMs: 1000, endMs: 2000 },
			{ startMs: 8000, endMs: 10000 },
			{ startMs: 3000, endMs: 2000 },
		])
			expect(planCloseTimelineGaps(state(), gap)).toBeNull();
		const gap = { startMs: 2000, endMs: 3000 };
		const closed = planCloseTimelineGaps(state(), gap)!;
		expect(planCloseTimelineGaps(closed, gap)).toBeNull();
	});

	it("retimes visuals without deleting those inside an empty gap", () => {
		const original = state();
		original.zoomRegions = [
			{ id: "inside", startMs: 2100, endMs: 2900, depth: 2, focus: { cx: 0.5, cy: 0.5 } },
			{ id: "across", startMs: 1500, endMs: 3500, depth: 2, focus: { cx: 0.5, cy: 0.5 } },
		];
		original.annotationRegions = [
			{
				id: "label",
				startMs: 2500,
				endMs: 2800,
				type: "text",
				content: "Keep",
				position: { x: 50, y: 50 },
				size: { width: 20, height: 20 },
				style: DEFAULT_ANNOTATION_STYLE,
				zIndex: 1,
			},
		];
		const result = planCloseTimelineGaps(original, { startMs: 2000, endMs: 3000 })!;
		expect(result.zoomRegions.map((r) => [r.id, r.startMs, r.endMs])).toEqual([
			["inside", 2000, 2001],
			["across", 1500, 2500],
		]);
		expect(result.annotationRegions[0]).toMatchObject({
			id: "label",
			startMs: 2000,
			endMs: 2001,
			content: "Keep",
		});
	});

	it("keeps every imported audio region and its duration, volume and tempo", () => {
		const original = state();
		original.audioRegions = [
			["narration", 1500, 10000],
			["inside", 2100, 2800],
			["later", 6500, 11000],
		].map(([id, startMs, endMs]) => ({
			id: String(id),
			startMs: Number(startMs),
			endMs: Number(endMs),
			audioPath: "voice.wav",
			volume: 0.6,
			trackIndex: 2,
		}));
		const result = planCloseTimelineGaps(original, { startMs: 2000, endMs: 3000 })!;
		expect(result.audioRegions.map((r) => [r.id, r.startMs, r.endMs])).toEqual([
			["narration", 1500, 10000],
			["inside", 2000, 2700],
			["later", 5500, 10000],
		]);
		expect(result.audioRegions[0].volume).toBe(0.6);
	});

	it("leaves source captions, word timings and source speed regions anchored", () => {
		const original = state();
		original.autoCaptions = [
			{
				id: "cue",
				startMs: 2100,
				endMs: 2900,
				text: "Keep",
				words: [{ text: "Keep", startMs: 2100, endMs: 2900 }],
			},
		];
		original.speedRegions = [{ id: "s", startMs: 2100, endMs: 2900, speed: 2 }];
		const result = planCloseTimelineGaps(original)!;
		expect(result.autoCaptions).toEqual(original.autoCaptions);
		expect(result.speedRegions).toEqual(original.speedRegions);
	});

	it("round-trips positions and source bounds and restores all gaps in one undo", () => {
		const original = state();
		const result = planCloseTimelineGaps(original)!;
		const reopened = normalizeProjectEditor(JSON.parse(JSON.stringify(result)));
		expect(reopened.clipRegions).toMatchObject(result.clipRegions);
		const history = createEditorHistoryStack();
		recordEditorHistorySnapshot(history, original);
		recordEditorHistorySnapshot(history, result);
		expect(undoEditorHistoryStack(history, result)).toEqual(original);
		expect(redoEditorHistoryStack(history, original)).toEqual(result);
	});
});
