import { describe, expect, it } from "vitest";
import {
	clampTimelinePanelHeight,
	getTimelinePanelBounds,
	normalizeTimelinePanelHeight,
} from "./timelinePanelLayout";

describe("timeline panel sizing", () => {
	it("uses a usable default for absent or corrupt remembered heights", () => {
		for (const value of [undefined, null, "400", -20, 0, NaN, Infinity]) {
			expect(normalizeTimelinePanelHeight(value)).toBe(240);
		}
		expect(normalizeTimelinePanelHeight(381.6)).toBe(382);
	});

	it("reserves space for the preview while allowing a larger timeline", () => {
		expect(getTimelinePanelBounds(800)).toEqual({ min: 160, max: 560 });
		expect(clampTimelinePanelHeight(500, 800)).toBe(500);
		expect(clampTimelinePanelHeight(900, 800)).toBe(560);
		expect(clampTimelinePanelHeight(20, 800)).toBe(160);
	});

	it("fits a remembered large height into a smaller window without hiding the panel", () => {
		expect(clampTimelinePanelHeight(600, 500)).toBe(260);
		expect(getTimelinePanelBounds(120)).toEqual({ min: 120, max: 120 });
		expect(clampTimelinePanelHeight(600, 120)).toBe(120);
		expect(getTimelinePanelBounds(0)).toEqual({ min: 0, max: 0 });
	});
});
