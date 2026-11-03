import { describe, expect, it } from "vitest";
import {
	isTimelineShortcutTargetBlocked,
	resolveDeleteSelectionTarget,
} from "./timelineSelectionUtils";

describe("timelineSelectionUtils", () => {
	it("closes a selected gap before any stale item selection", () => {
		expect(
			resolveDeleteSelectionTarget({
				selectAllBlocksActive: true,
				selectedKeyframeId: "old",
				selectedZoomId: "old",
				selectedGap: { startMs: 1000, endMs: 2000 },
			}),
		).toBe("gap");
	});

	it("protects editable controls and dialogs from timeline shortcuts", () => {
		const target = (matches: boolean) =>
			({ closest: () => (matches ? {} : null) }) as unknown as Element;
		expect(isTimelineShortcutTargetBlocked(target(true))).toBe(true);
		expect(isTimelineShortcutTargetBlocked(target(false))).toBe(false);
		expect(isTimelineShortcutTargetBlocked(null)).toBe(false);
	});
	it("treats zoom select-all as a zoom deletion target", () => {
		expect(
			resolveDeleteSelectionTarget({
				selectAllBlocksActive: true,
				selectedKeyframeId: "kf-1",
				selectedZoomId: "z-1",
				selectedClipId: "c-1",
				selectedAnnotationId: "a-1",
				selectedAudioId: "au-1",
			}),
		).toBe("zoom");
	});

	it("follows selection priority order", () => {
		expect(
			resolveDeleteSelectionTarget({
				selectAllBlocksActive: false,
				selectedKeyframeId: "kf-1",
				selectedZoomId: "z-1",
			}),
		).toBe("keyframe");
		expect(
			resolveDeleteSelectionTarget({
				selectAllBlocksActive: false,
				selectedKeyframeId: null,
				selectedZoomId: "z-1",
				selectedClipId: "c-1",
			}),
		).toBe("zoom");
		expect(
			resolveDeleteSelectionTarget({
				selectAllBlocksActive: false,
				selectedKeyframeId: null,
				selectedZoomId: null,
				selectedClipId: "c-1",
				selectedAnnotationId: "a-1",
			}),
		).toBe("clip");
	});

	it("returns none when nothing is selected", () => {
		expect(
			resolveDeleteSelectionTarget({
				selectAllBlocksActive: false,
				selectedKeyframeId: null,
				selectedZoomId: null,
			}),
		).toBe("none");
	});
});
