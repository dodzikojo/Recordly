import { describe, expect, it } from "vitest";
import {
	planBulkClipDelete,
	planBulkClipSettings,
	planClipGroupMove,
	sanitizeClipSelection,
	selectAllClips,
	selectClip,
	type ClipSelection,
} from "./clipBatchEditing";
import type { EditorHistorySnapshot } from "./editorHistory";
import { normalizeProjectEditor } from "./projectPersistence";
import { planRippleClipDelete } from "./rippleDelete";
import {
	DEFAULT_ANNOTATION_STYLE,
	getClipSourceEndMs,
	getClipSourceStartMs,
	type AnnotationRegion,
	type AudioRegion,
	type ClipRegion,
	type ZoomRegion,
} from "./types";

const clip = (id: string, startMs: number, endMs: number, speed = 1): ClipRegion => ({
	id,
	startMs,
	endMs,
	speed,
});
const zoom = (id: string, startMs: number, endMs: number): ZoomRegion => ({
	id,
	startMs,
	endMs,
	depth: 2,
	focus: { cx: 0.5, cy: 0.5 },
});
const annotation = (id: string, startMs: number, endMs: number): AnnotationRegion => ({
	id,
	startMs,
	endMs,
	type: "text",
	content: id,
	position: { x: 50, y: 50 },
	size: { width: 20, height: 20 },
	style: DEFAULT_ANNOTATION_STYLE,
	zIndex: 1,
});
const audio = (id: string, startMs: number, endMs: number): AudioRegion => ({
	id,
	startMs,
	endMs,
	audioPath: "voice.wav",
	volume: 1,
	trackIndex: 2,
});
function state(overrides: Partial<EditorHistorySnapshot> = {}): EditorHistorySnapshot {
	return {
		clipRegions: [clip("a", 1000, 2000), clip("b", 3000, 4000), clip("c", 5000, 6000)],
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
const empty: ClipSelection = { ids: [], primaryId: null, anchorId: null };
const spans = (regions: { id: string; startMs: number; endMs: number }[]) =>
	regions.map(({ id, startMs, endMs }) => [id, startMs, endMs]);

describe("clip selection transitions", () => {
	const clips = [
		clip("d", 6000, 7000),
		clip("b", 2000, 3000),
		clip("a", 0, 1000),
		clip("c", 4000, 5000),
	];
	it("removes stale/duplicate IDs, orders by timeline and repairs primary/anchor", () => {
		expect(
			sanitizeClipSelection(
				{ ids: ["d", "missing", "a", "d"], primaryId: "missing", anchorId: "missing" },
				clips,
			),
		).toEqual({ ids: ["a", "d"], primaryId: "d", anchorId: "d" });
		expect(
			sanitizeClipSelection({ ids: ["missing"], primaryId: "a", anchorId: "a" }, clips),
		).toEqual(empty);
	});
	it("plain click replaces the set; toggle adds/removes and preserves a usable primary", () => {
		const first = selectClip(empty, clips, "a");
		expect(first).toEqual({ ids: ["a"], primaryId: "a", anchorId: "a" });
		const added = selectClip(first, clips, "d", { toggle: true });
		expect(added).toEqual({ ids: ["a", "d"], primaryId: "d", anchorId: "d" });
		expect(selectClip(added, clips, "d", { toggle: true })).toMatchObject({
			ids: ["a"],
			primaryId: "a",
		});
		expect(selectClip(added, clips, "b")).toEqual({
			ids: ["b"],
			primaryId: "b",
			anchorId: "b",
		});
		expect(selectClip(first, clips, "a", { toggle: true })).toEqual(empty);
	});
	it("uses a stable anchor for inclusive Shift ranges and additive Ctrl+Shift ranges", () => {
		const first = selectClip(empty, clips, "b");
		const extended = selectClip(first, clips, "d", { range: true });
		expect(extended).toEqual({ ids: ["b", "c", "d"], primaryId: "d", anchorId: "b" });
		expect(selectClip(extended, clips, "a", { range: true })).toEqual({
			ids: ["a", "b"],
			primaryId: "a",
			anchorId: "b",
		});
		expect(selectClip(extended, clips, "a", { range: true, toggle: true }).ids).toEqual([
			"a",
			"b",
			"c",
			"d",
		]);
	});
	it("preserves an existing group on pointer-down but permits click/modifier transitions", () => {
		const selected = selectAllClips(selectClip(empty, clips, "a"), clips);
		expect(selectClip(selected, clips, "c", { preserve: true })).toEqual(selected);
		expect(selectClip(selected, clips, "c", { preserve: true, toggle: true }).ids).toEqual([
			"a",
			"b",
			"d",
		]);
		expect(selectClip(selected, clips, "c").ids).toEqual(["c"]);
		expect(
			selectClip(selectClip(empty, clips, "a"), clips, "c", { preserve: true }).ids,
		).toEqual(["c"]);
	});
	it("falls back safely without an anchor, ignores unknown clicks, and selects all", () => {
		expect(selectClip(empty, clips, "c", { range: true })).toEqual({
			ids: ["c"],
			primaryId: "c",
			anchorId: "c",
		});
		expect(selectClip(empty, clips, "missing")).toEqual(empty);
		expect(selectAllClips(selectClip(empty, clips, "c"), clips)).toEqual({
			ids: ["a", "b", "c", "d"],
			primaryId: "c",
			anchorId: "c",
		});
		expect(selectAllClips(empty, [])).toEqual(empty);
	});
});

describe("group move planning", () => {
	it("clamps one delta at zero while preserving spacing, source positions and speed", () => {
		const original = state({ clipRegions: [clip("b", 3000, 4000, 2), clip("a", 1000, 2000)] });
		const result = planClipGroupMove(original, ["a", "b", "b", "stale"], -5000)!;
		expect(result.deltaMs).toBe(-1000);
		expect(spans(result.state.clipRegions)).toEqual([
			["b", 2000, 3000],
			["a", 0, 1000],
		]);
		expect(result.state.clipRegions.map(getClipSourceStartMs)).toEqual([3000, 1000]);
		expect(result.state.clipRegions.map(getClipSourceEndMs)).toEqual([5000, 2000]);
		expect(original.clipRegions[0].startMs).toBe(3000);
	});
	it("stops at the nearest obstacle in either direction and never jumps over it", () => {
		const original = state();
		expect(planClipGroupMove(original, ["a", "c"], 10000)!.deltaMs).toBe(1000);
		expect(planClipGroupMove(original, ["b"], -10000)!.deltaMs).toBe(-1000);
		expect(planClipGroupMove(original, ["b"], 10000)!.deltaMs).toBe(1000);
	});
	it("allows extending right when no unselected clips obstruct the group", () => {
		expect(planClipGroupMove(state(), ["b", "c"], 15000)!.deltaMs).toBe(15000);
	});
	it("moves each wholly contained visual once and keeps spanning effects/audio/source timings independent", () => {
		const original = state({
			zoomRegions: [
				zoom("owned-a", 1100, 1900),
				zoom("owned-b", 3000, 4000),
				zoom("spanning", 1500, 3500),
			],
			annotationRegions: [
				annotation("owned", 3100, 3900),
				annotation("spanning", 1500, 3500),
			],
			audioRegions: [audio("owned", 1100, 1900), audio("narration", 0, 9000)],
			autoCaptions: [{ id: "caption", startMs: 1100, endMs: 1900, text: "Hi" }],
			speedRegions: [{ id: "speed", startMs: 1100, endMs: 1900, speed: 2 }],
		});
		const moved = planClipGroupMove(original, ["a", "b", "a"], 500)!.state;
		expect(spans(moved.zoomRegions)).toEqual([
			["owned-a", 1600, 2400],
			["owned-b", 3500, 4500],
			["spanning", 1500, 3500],
		]);
		expect(spans(moved.annotationRegions)).toEqual([
			["owned", 3600, 4400],
			["spanning", 1500, 3500],
		]);
		expect(moved.audioRegions).toBe(original.audioRegions);
		expect(moved.autoCaptions).toBe(original.autoCaptions);
		expect(moved.speedRegions).toBe(original.speedRegions);
	});
	it("returns null for stale selections, invalid deltas and movement blocked at contact", () => {
		expect(planClipGroupMove(state(), ["stale"], 1000)).toBeNull();
		expect(planClipGroupMove(state(), ["a"], Number.NaN)).toBeNull();
		expect(planClipGroupMove(state(), ["a"], Number.POSITIVE_INFINITY)).toBeNull();
		expect(planClipGroupMove(state(), ["a"], 0)).toBeNull();
		expect(
			planClipGroupMove(
				state({ clipRegions: [clip("a", 0, 1000), clip("b", 1000, 2000)] }),
				["a"],
				5000,
			),
		).toBeNull();
	});
	it("sanitizes optional selection metadata without adding it to legacy snapshots", () => {
		const original = {
			...state(),
			selectedClipIds: ["a", "missing", "b", "a"],
			clipSelectionAnchorId: "missing",
		};
		const moved = planClipGroupMove(original, ["a", "b"], 500)!.state as typeof original;
		expect(moved.selectedClipIds).toEqual(["a", "b"]);
		expect(moved.clipSelectionAnchorId).toBe("b");
		expect(planClipGroupMove(state(), ["a"], 500)!.state).not.toHaveProperty("selectedClipIds");
	});
});

describe("bulk ripple deletion", () => {
	it("collapses the selected span union once and preserves intentional gaps/source anchors", () => {
		const original = state({
			clipRegions: [
				clip("d", 8000, 9000, 2),
				clip("b", 3000, 4000),
				clip("a", 1000, 2000),
				clip("c", 5000, 6000),
			],
		});
		const deleted = planBulkClipDelete(original, ["a", "c", "a", "missing"])!;
		expect(spans(deleted.clipRegions)).toEqual([
			["d", 6000, 7000],
			["b", 2000, 3000],
		]);
		expect(deleted.clipRegions.map(getClipSourceStartMs)).toEqual([8000, 3000]);
		expect(deleted.clipRegions.map(getClipSourceEndMs)).toEqual([10000, 4000]);
		expect(original.clipRegions[0].startMs).toBe(8000);
	});
	it("removes visuals/audio inside the cut union, clips crossing visuals and preserves narration duration", () => {
		const original = state({
			clipRegions: [clip("a", 1000, 2000), clip("b", 2000, 3000), clip("c", 4000, 5000)],
			zoomRegions: [
				zoom("inside-union", 1500, 2500),
				zoom("cross", 500, 4500),
				zoom("gap", 3200, 3800),
			],
			annotationRegions: [annotation("inside", 1100, 2900)],
			audioRegions: [audio("inside", 1500, 2500), audio("narration", 1500, 6500)],
			selectedZoomId: "inside-union",
			selectedAnnotationId: "inside",
			selectedAudioId: "inside",
		});
		const result = planBulkClipDelete(original, ["a", "b"])!;
		expect(spans(result.zoomRegions)).toEqual([
			["cross", 500, 2500],
			["gap", 1200, 1800],
		]);
		expect(result.annotationRegions).toEqual([]);
		expect(spans(result.audioRegions)).toEqual([["narration", 1000, 6000]]);
		expect(result.selectedZoomId).toBeNull();
		expect(result.selectedAnnotationId).toBeNull();
		expect(result.selectedAudioId).toBeNull();
	});
	it("deletes source captions/speeds in source-span union without retiming kept words", () => {
		const original = state({
			clipRegions: [
				{ ...clip("a", 1000, 2000, 2), sourceStartMs: 10000 },
				{ ...clip("b", 3000, 4000), sourceStartMs: 12000 },
				clip("c", 5000, 6000),
			],
			autoCaptions: [
				{ id: "deleted", startMs: 11000, endMs: 12500, text: "cut" },
				{
					id: "kept",
					startMs: 14000,
					endMs: 15000,
					text: "keep",
					words: [{ text: "keep", startMs: 14000, endMs: 15000 }],
				},
			],
			speedRegions: [
				{ id: "deleted", startMs: 11000, endMs: 12500, speed: 2 },
				{ id: "kept", startMs: 14000, endMs: 15000, speed: 2 },
			],
		});
		const result = planBulkClipDelete(original, ["a", "b"])!;
		expect(result.autoCaptions).toEqual([original.autoCaptions[1]]);
		expect(result.speedRegions).toEqual([original.speedRegions[1]]);
	});
	it("matches the existing single-delete planner and supports deleting every clip explicitly", () => {
		const original = state({
			zoomRegions: [zoom("z", 1500, 3500)],
			audioRegions: [audio("n", 0, 8000)],
		});
		expect(planBulkClipDelete(original, ["b"])).toEqual(planRippleClipDelete(original, "b"));
		const result = planBulkClipDelete(original, ["a", "b", "c"])!;
		expect(result.clipRegions).toEqual([]);
		expect(result.selectedClipId).toBeNull();
		expect(planBulkClipDelete(original, ["missing"])).toBeNull();
	});
	it("uses union duration even if legacy selected spans overlap", () => {
		const result = planBulkClipDelete(
			state({
				clipRegions: [clip("a", 1000, 3000), clip("b", 2000, 4000), clip("c", 6000, 7000)],
			}),
			["a", "b"],
		)!;
		expect(spans(result.clipRegions)).toEqual([["c", 3000, 4000]]);
	});
	it("clears removed optional selection IDs/anchor and retains a surviving primary", () => {
		const original = {
			...state(),
			selectedClipIds: ["a", "b", "c"],
			clipSelectionAnchorId: "a",
		};
		const result = planBulkClipDelete(original, ["a", "b"])! as typeof original;
		expect(result.selectedClipIds).toEqual(["c"]);
		expect(result.selectedClipId).toBe("c");
		expect(result.clipSelectionAnchorId).toBe("c");
		const all = planBulkClipDelete(original, ["a", "b", "c"])! as typeof original;
		expect(all.selectedClipIds).toEqual([]);
		expect(all.clipSelectionAnchorId).toBeNull();
	});
});

describe("bulk settings planning", () => {
	it("changes only requested fields on selected clips and leaves defaults/unselected arrays alone", () => {
		const original = state();
		const result = planBulkClipSettings(original, ["a", "c", "missing"], { muted: true });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.state.clipRegions).toEqual([
			{ ...original.clipRegions[0], muted: true },
			original.clipRegions[1],
			{ ...original.clipRegions[2], muted: true },
		]);
		expect(result.state.zoomRegions).toBe(original.zoomRegions);
		expect(original.clipRegions[0].muted).toBeUndefined();
		const hidden = planBulkClipSettings(result.state, ["a"], { showSourceAudio: false });
		expect(hidden.ok && hidden.state.clipRegions[0]).toMatchObject({
			muted: true,
			showSourceAudio: false,
		});
	});
	it("preserves source duration at each selected clip speed without rippling starts", () => {
		const original = state({ clipRegions: [clip("a", 1000, 2000, 2), clip("b", 4000, 5000)] });
		const result = planBulkClipSettings(original, ["b", "a", "a"], { speed: 2, muted: false });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(spans(result.state.clipRegions)).toEqual([
			["a", 1000, 2000],
			["b", 4000, 4500],
		]);
		expect(result.state.clipRegions.map(getClipSourceStartMs)).toEqual(
			original.clipRegions.map(getClipSourceStartMs),
		);
		expect(result.state.clipRegions.map(getClipSourceEndMs)).toEqual(
			original.clipRegions.map(getClipSourceEndMs),
		);
	});
	it("retains nondivisible source durations across speed changes and saved project roundtrips", () => {
		const original = state({
			clipRegions: [clip("a", 1000, 2001), clip("b", 5000, 6003)],
		});
		const sped = planBulkClipSettings(original, ["a", "b"], { speed: 2 });
		expect(sped.ok).toBe(true);
		if (!sped.ok) return;
		expect(sped.state.clipRegions.map(getClipSourceEndMs)).toEqual([2001, 6003]);
		expect(sped.state.clipRegions.map((region) => region.endMs - region.startMs)).toEqual([
			501, 502,
		]);
		const reopened = normalizeProjectEditor(JSON.parse(JSON.stringify(sped.state)));
		expect(reopened.clipRegions.map(getClipSourceEndMs)).toEqual([2001, 6003]);
		const restored = planBulkClipSettings(
			{ ...sped.state, clipRegions: reopened.clipRegions },
			["a", "b"],
			{ speed: 1 },
		);
		expect(restored.ok).toBe(true);
		if (!restored.ok) return;
		expect(spans(restored.state.clipRegions)).toEqual(spans(original.clipRegions));
		expect(
			restored.state.clipRegions.map(
				(region) => getClipSourceEndMs(region) - getClipSourceStartMs(region),
			),
		).toEqual([1001, 1003]);
	});
	it("validates selected clips against one another and unselected clips atomically", () => {
		const original = state();
		expect(planBulkClipSettings(original, ["a", "b"], { speed: 0.25, muted: true })).toEqual({
			ok: false,
			reason: "clip-overlap",
		});
		expect(
			original.clipRegions.every(
				(region) => region.speed === 1 && region.muted === undefined,
			),
		).toBe(true);
	});
	it("scales each zoom from its original owning clip once, preserving single-speed semantics", () => {
		const original = state({
			zoomRegions: [
				zoom("a-zoom", 1100, 1500),
				zoom("b-zoom", 3200, 3800),
				zoom("gap", 2200, 2600),
			],
			annotationRegions: [annotation("a", 1100, 1500)],
		});
		const result = planBulkClipSettings(original, ["a", "b"], { speed: 2 });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(spans(result.state.zoomRegions)).toEqual([
			["a-zoom", 1050, 1250],
			["b-zoom", 3100, 3400],
			["gap", 2200, 2600],
		]);
		expect(result.state.annotationRegions).toBe(original.annotationRegions);
	});
	it("checks final zoom positions rather than rejecting a transient collision", () => {
		const original = state({
			clipRegions: [clip("a", 0, 1000, 2), clip("b", 2000, 3000, 2)],
			zoomRegions: [zoom("a-zoom", 900, 1200), zoom("b-zoom", 2200, 2300)],
		});
		// Scaling only A would collide with B's original zoom. Both final zooms touch.
		const final = planBulkClipSettings(original, ["a", "b"], { speed: 1 });
		expect(final.ok).toBe(true);
		if (!final.ok) return;
		expect(spans(final.state.zoomRegions)).toEqual([
			["a-zoom", 1800, 2400],
			["b-zoom", 2400, 2600],
		]);
		expect(planBulkClipSettings(original, ["b", "a"], { speed: 1 })).toEqual(final);
	});
	it("rejects final zoom collisions and invalid speeds without applying other settings", () => {
		const original = state({
			clipRegions: [clip("a", 0, 1000), clip("b", 5000, 6000)],
			zoomRegions: [zoom("inside", 800, 1000), zoom("outside", 1200, 1800)],
		});
		expect(planBulkClipSettings(original, ["a"], { speed: 0.5, muted: true })).toEqual({
			ok: false,
			reason: "zoom-overlap",
		});
		for (const speed of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(planBulkClipSettings(original, ["a"], { speed, muted: true })).toEqual({
				ok: false,
				reason: "invalid-speed",
			});
		}
		expect(original.clipRegions[0].muted).toBeUndefined();
	});
});
