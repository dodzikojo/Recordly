import { describe, expect, it } from "vitest";
import { isEmptyClipEdit } from "./emptyClipEdit";
import { normalizeProjectEditor } from "./projectPersistence";
import { trimsToClips } from "./types";

describe("explicitly empty clip edits", () => {
	it("uses existing full-source trim metadata without mistaking an uninitialized source for empty", () => {
		expect(isEmptyClipEdit([], [], 1000)).toBe(false);
		expect(isEmptyClipEdit([], [{ id: "empty", startMs: 0, endMs: 1000 }], 1000)).toBe(true);
	});
	it("keeps the empty edit across project normalization and legacy clip bootstrap", () => {
		const normalized = normalizeProjectEditor({
			clipRegions: [],
			trimRegions: [{ id: "empty", startMs: 0, endMs: 1000 }],
		});
		expect(isEmptyClipEdit(normalized.clipRegions, normalized.trimRegions, 1000)).toBe(true);
		expect(trimsToClips(normalized.trimRegions, 1000)).toEqual([]);
	});
});
