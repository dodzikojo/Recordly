import { describe, expect, it } from "vitest";
import {
	createEditorHistoryStack,
	recordEditorHistorySnapshot,
	undoEditorHistoryStack,
	redoEditorHistoryStack,
	type EditorHistorySnapshot,
} from "./editorHistory";
import { normalizeProjectEditor } from "./projectPersistence";
import {
	clipsToTrims,
	getClipSourceEndMs,
	getClipSourceStartMs,
	mapTimelineTimeToSourceTime,
	DEFAULT_ANNOTATION_STYLE,
	type AudioRegion,
	type ZoomRegion,
} from "./types";
import { planRippleClipDelete, mapTimelineRegionsToSource } from "./rippleDelete";

function state(overrides: Partial<EditorHistorySnapshot> = {}): EditorHistorySnapshot {
	return {
		clipRegions: [
			{ id: "a", startMs: 0, endMs: 2000, speed: 1 },
			{ id: "b", startMs: 2000, endMs: 3000, speed: 5, sourceStartMs: 2000 },
			{ id: "c", startMs: 3000, endMs: 5000, speed: 2, sourceStartMs: 10000 },
		],
		zoomRegions: [],
		annotationRegions: [],
		audioRegions: [],
		autoCaptions: [],
		speedRegions: [],
		selectedClipId: "b",
		selectedZoomId: null,
		selectedAnnotationId: null,
		selectedAudioId: null,
		...overrides,
	};
}

const zoom = (id: string, startMs: number, endMs: number): ZoomRegion => ({
	id,
	startMs,
	endMs,
	depth: 2,
	focus: { cx: 0.5, cy: 0.5 },
});
const audio = (id: string, startMs: number, endMs: number): AudioRegion => ({
	id,
	startMs,
	endMs,
	audioPath: "voice.wav",
	volume: 1,
	trackIndex: 2,
});

describe("ripple clip deletion", () => {
	it("closes the deleted span using its played duration and preserves original frames", () => {
		const original = state();
		const result = planRippleClipDelete(original, "b")!;
		expect(result.clipRegions.map((c) => [c.id, c.startMs, c.endMs])).toEqual([
			["a", 0, 2000],
			["c", 2000, 4000],
		]);
		expect(result.clipRegions[1].speed).toBe(2);
		expect(getClipSourceStartMs(result.clipRegions[1])).toBe(10000);
		expect(getClipSourceEndMs(result.clipRegions[1])).toBe(14000);
		expect(mapTimelineTimeToSourceTime(2500, result.clipRegions)).toBe(11000);
		expect(clipsToTrims(result.clipRegions, 15000)).toEqual([
			{ id: "trim-gap-1", startMs: 2000, endMs: 10000 },
			{ id: "trim-gap-2", startMs: 14000, endMs: 15000 },
		]);
		expect(original.clipRegions[2].startMs).toBe(3000);
	});

	it("pins legacy implicit source positions before moving clips", () => {
		const result = planRippleClipDelete(
			state({
				clipRegions: [
					{ id: "a", startMs: 0, endMs: 1000, speed: 1 },
					{ id: "b", startMs: 1000, endMs: 2000, speed: 1 },
					{ id: "c", startMs: 2000, endMs: 4000, speed: 1, muted: true },
				],
			}),
			"b",
		)!;
		expect(result.clipRegions[1]).toMatchObject({
			startMs: 1000,
			endMs: 3000,
			sourceStartMs: 2000,
			muted: true,
		});
	});

	it("deletes the first or last clip without moving earlier content", () => {
		expect(planRippleClipDelete(state(), "a")!.clipRegions[0]).toMatchObject({
			id: "b",
			startMs: 0,
			endMs: 1000,
			sourceStartMs: 2000,
		});
		expect(planRippleClipDelete(state(), "c")!.clipRegions).toEqual(
			state().clipRegions.slice(0, 2),
		);
		expect(planRippleClipDelete(state(), "missing")).toBeNull();
	});

	it("preserves other intentional gaps and accepts unsorted clip arrays", () => {
		const original = state();
		original.clipRegions[2].startMs += 500;
		original.clipRegions[2].endMs += 500;
		original.clipRegions.reverse();
		const result = planRippleClipDelete(original, "b")!;
		expect(result.clipRegions.find((c) => c.id === "c")).toMatchObject({
			startMs: 2500,
			endMs: 4500,
			sourceStartMs: 10000,
		});
	});

	it("removes effects inside the cut, shifts later ones, and trims crossing effects", () => {
		const result = planRippleClipDelete(
			state({
				zoomRegions: [
					zoom("before", 500, 1000),
					zoom("inside", 2200, 2800),
					zoom("after", 3200, 4200),
					zoom("left", 1500, 2500),
					zoom("right", 2500, 3500),
					zoom("across", 1000, 4000),
				],
			}),
			"b",
		)!;
		expect(result.zoomRegions.map((r) => [r.id, r.startMs, r.endMs])).toEqual([
			["before", 500, 1000],
			["after", 2200, 3200],
			["left", 1500, 2000],
			["right", 2000, 2500],
			["across", 1000, 3000],
		]);
	});

	it("moves later audio while preserving the length of narration crossing a cut", () => {
		const result = planRippleClipDelete(
			state({
				audioRegions: [
					audio("narration", 1000, 11000),
					audio("starts-in-cut", 2500, 6500),
					audio("later", 3500, 7500),
					audio("inside", 2200, 2800),
				],
			}),
			"b",
		)!;
		expect(result.audioRegions.map((r) => [r.id, r.startMs, r.endMs])).toEqual([
			["narration", 1000, 11000],
			["starts-in-cut", 2000, 6000],
			["later", 2500, 6500],
		]);
	});

	it("keeps captions and legacy speeds in source coordinates", () => {
		const original = state({
			autoCaptions: [
				{ id: "deleted", startMs: 3000, endMs: 4000, text: "removed" },
				{
					id: "kept",
					startMs: 11000,
					endMs: 12000,
					text: "kept",
					words: [{ text: "kept", startMs: 11000, endMs: 12000 }],
				},
			],
			speedRegions: [
				{ id: "deleted", startMs: 3000, endMs: 4000, speed: 2 },
				{ id: "kept", startMs: 11000, endMs: 12000, speed: 2 },
			],
		});
		const result = planRippleClipDelete(original, "b")!;
		expect(result.autoCaptions).toEqual([original.autoCaptions[1]]);
		expect(result.speedRegions).toEqual([original.speedRegions[1]]);
	});

	it("round-trips moved clips without changing source bounds", () => {
		const result = planRippleClipDelete(state(), "b")!;
		const reopened = normalizeProjectEditor(JSON.parse(JSON.stringify(result)));
		expect(reopened.clipRegions.map(getClipSourceStartMs)).toEqual([0, 10000]);
		expect(reopened.clipRegions.map(getClipSourceEndMs)).toEqual([2000, 14000]);
	});

	it("maps moved annotation times back to the original footage for preview and export", () => {
		const annotation = {
			id: "moved",
			startMs: 3500,
			endMs: 4000,
			type: "text" as const,
			content: "Hello",
			position: { x: 50, y: 50 },
			size: { width: 20, height: 20 },
			style: DEFAULT_ANNOTATION_STYLE,
			zIndex: 1,
		};
		const result = planRippleClipDelete(state({ annotationRegions: [annotation] }), "b")!;
		expect(result.annotationRegions[0]).toMatchObject({
			startMs: 2500,
			endMs: 3000,
			position: annotation.position,
		});
		expect(
			mapTimelineRegionsToSource(result.annotationRegions, result.clipRegions)[0],
		).toMatchObject({ startMs: 11000, endMs: 12000, content: "Hello" });
	});

	it("restores the entire edit in one Undo and reapplies it in one Redo", () => {
		const original = state({
			zoomRegions: [zoom("z", 3500, 4000)],
			audioRegions: [audio("a", 3500, 4500)],
		});
		const plan = planRippleClipDelete(original, "b")!;
		const history = createEditorHistoryStack();
		recordEditorHistorySnapshot(history, original);
		recordEditorHistorySnapshot(history, plan);
		expect(undoEditorHistoryStack(history, plan)).toEqual(original);
		expect(redoEditorHistoryStack(history, original)).toEqual(plan);
	});
});
