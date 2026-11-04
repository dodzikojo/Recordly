import { describe, expect, it } from "vitest";
import { planBulkClipSettings } from "./clipBatchEditing";
import { getVisibleCursorTelemetry, isCursorHiddenAtSourceTime } from "./cursorVisibility";
import {
	createEditorHistoryStack,
	recordEditorHistorySnapshot,
	undoEditorHistoryStack,
} from "./editorHistory";
import { normalizeProjectEditor } from "./projectPersistence";
import { resizeClipRegion, splitClipRegion, type ClipRegion } from "./types";

const hidden: ClipRegion = {
	id: "a",
	startMs: 4000,
	endMs: 4500,
	speed: 2,
	sourceStartMs: 1000,
	hideCursor: true,
};
const samples = [{ timeMs: 1500, cx: 0.5, cy: 0.5, interactionType: "click" as const }];

describe("clip cursor visibility", () => {
	it("defaults missing and invalid legacy values to visible and round-trips hidden clips", () => {
		const editor = normalizeProjectEditor({
			clipRegions: [
				hidden,
				{ id: "b", startMs: 6000, endMs: 7000, speed: 1 },
				{
					id: "c",
					startMs: 8000,
					endMs: 9000,
					speed: 1,
					hideCursor: "yes",
				} as unknown as ClipRegion,
			],
		});
		expect(editor.clipRegions.map((clip) => clip.hideCursor)).toEqual([true, false, false]);
		expect(normalizeProjectEditor(JSON.parse(JSON.stringify(editor))).clipRegions).toEqual(
			editor.clipRegions,
		);
	});

	it("uses original media time with inclusive starts and exclusive ends", () => {
		expect(isCursorHiddenAtSourceTime([hidden], 999)).toBe(false);
		expect(isCursorHiddenAtSourceTime([hidden], 1000)).toBe(true);
		expect(isCursorHiddenAtSourceTime([hidden], 1999)).toBe(true);
		expect(isCursorHiddenAtSourceTime([hidden], 2000)).toBe(false);
		expect(isCursorHiddenAtSourceTime([hidden], 4000)).toBe(false);
		expect(isCursorHiddenAtSourceTime([], 1500)).toBe(false);
	});

	it("keeps visibility attached across splits, moves and speed changes", () => {
		const split = splitClipRegion(hidden, 4250, "l", "r")!;
		expect(split.every((clip) => clip.hideCursor)).toBe(true);
		const moved = resizeClipRegion(hidden, 8000, 8500);
		expect(isCursorHiddenAtSourceTime([moved], 1500)).toBe(true);
		const editor = normalizeProjectEditor({ clipRegions: [hidden] });
		const sped = planBulkClipSettings(
			{
				...editor,
				selectedClipId: "a",
				selectedZoomId: null,
				selectedAnnotationId: null,
				selectedAudioId: null,
			},
			["a"],
			{ speed: 5 },
		);
		expect(sped.ok).toBe(true);
		if (sped.ok) expect(isCursorHiddenAtSourceTime(sped.state.clipRegions, 1500)).toBe(true);
	});

	it("suppresses pointer and click telemetry for hidden frames and temporal samples", () => {
		expect(getVisibleCursorTelemetry(samples, [hidden], 1500)).toEqual([]);
		expect(getVisibleCursorTelemetry(samples, [], 999)).toBe(samples);
		expect(
			getVisibleCursorTelemetry(samples, [hidden], 2000)[0].interactionType,
		).toBeUndefined();
		expect(getVisibleCursorTelemetry(samples, [hidden], 999, 1000)).toEqual([]);
		expect(getVisibleCursorTelemetry(samples, [hidden], 1500, 2000)).toEqual([]);
		const clips = [hidden];
		const masked = getVisibleCursorTelemetry(samples, clips, 2000);
		expect(getVisibleCursorTelemetry(samples, clips, 2200)).toBe(masked);
		expect(samples[0].interactionType).toBe("click");
	});

	it("applies only cursor hiding to selected clips as one undoable edit", () => {
		const editor = normalizeProjectEditor({
			clipRegions: [
				{ ...hidden, hideCursor: false },
				{ id: "b", startMs: 6000, endMs: 7000, speed: 1 },
			],
		});
		const snapshot = {
			...editor,
			selectedClipId: "a",
			selectedZoomId: null,
			selectedAnnotationId: null,
			selectedAudioId: null,
		};
		const result = planBulkClipSettings(snapshot, ["a"], { hideCursor: true });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.state.clipRegions).toEqual([
			{ ...editor.clipRegions[0], hideCursor: true },
			editor.clipRegions[1],
		]);
		const stack = createEditorHistoryStack();
		recordEditorHistorySnapshot(stack, snapshot);
		recordEditorHistorySnapshot(stack, result.state);
		expect(undoEditorHistoryStack(stack)?.clipRegions).toEqual(editor.clipRegions);
	});
});
