import { describe, expect, it } from "vitest";
import { calculateWorkAreaCropRegion, normalizeScreenCropRegion } from "./screenCrop";

describe("calculateWorkAreaCropRegion", () => {
	it("converts a bottom taskbar into a normalized crop", () => {
		expect(
			calculateWorkAreaCropRegion(
				{ x: 0, y: 0, width: 1920, height: 1080 },
				{ x: 0, y: 0, width: 1920, height: 1032 },
			),
		).toEqual({ x: 0, y: 0, width: 1, height: 1032 / 1080 });
	});

	it("handles taskbars on the top, left, and right edges", () => {
		expect(
			calculateWorkAreaCropRegion(
				{ x: -2560, y: -100, width: 2560, height: 1440 },
				{ x: -2480, y: -60, width: 2420, height: 1400 },
			),
		).toEqual({
			x: 80 / 2560,
			y: 40 / 1440,
			width: 2420 / 2560,
			height: 1400 / 1440,
		});
	});

	it("returns null when the work area does not exclude meaningful pixels", () => {
		expect(
			calculateWorkAreaCropRegion(
				{ x: 0, y: 0, width: 1920, height: 1080 },
				{ x: 0, y: 0, width: 1920, height: 1080 },
			),
		).toBeNull();
		expect(
			calculateWorkAreaCropRegion(
				{ x: 0, y: 0, width: 1920, height: 1080 },
				{ x: 0, y: 0, width: 1920, height: 1079 },
			),
		).toBeNull();
	});

	it("rejects invalid or non-overlapping geometry", () => {
		expect(
			calculateWorkAreaCropRegion(
				{ x: 0, y: 0, width: 0, height: 1080 },
				{ x: 0, y: 0, width: 1920, height: 1040 },
			),
		).toBeNull();
		expect(
			calculateWorkAreaCropRegion(
				{ x: 0, y: 0, width: 1920, height: 1080 },
				{ x: 3000, y: 0, width: 1920, height: 1040 },
			),
		).toBeNull();
	});
});

describe("normalizeScreenCropRegion", () => {
	it("clamps persisted crop geometry inside the source", () => {
		expect(normalizeScreenCropRegion({ x: -1, y: 0.1, width: 2, height: 2 })).toEqual({
			x: 0,
			y: 0.1,
			width: 1,
			height: 0.9,
		});
	});

	it("returns null for missing, invalid, or full-frame values", () => {
		expect(normalizeScreenCropRegion(undefined)).toBeNull();
		expect(normalizeScreenCropRegion({ x: 0, y: 0, width: 1, height: 1 })).toBeNull();
		expect(normalizeScreenCropRegion({ x: 0, y: 0, width: 0, height: 1 })).toBeNull();
	});
});
