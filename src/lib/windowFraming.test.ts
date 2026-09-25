import { describe, expect, it } from "vitest";
import {
	DEFAULT_WINDOW_FRAMING_SETTINGS,
	calculateTopInsetDipFromGuidePosition,
	calculateWindowFramingCropRegion,
	normalizeWindowFramingSettings,
} from "./windowFraming";

describe("normalizeWindowFramingSettings", () => {
	it("returns fresh defaults for missing and invalid values", () => {
		expect(normalizeWindowFramingSettings(undefined)).toEqual(DEFAULT_WINDOW_FRAMING_SETTINGS);
		expect(normalizeWindowFramingSettings({ enabled: "yes", topInsetDip: "80" })).toEqual({
			enabled: false,
			topInsetDip: 0,
		});
	});

	it("rounds and clamps the remembered top inset", () => {
		expect(normalizeWindowFramingSettings({ enabled: true, topInsetDip: 84.6 })).toEqual({
			enabled: true,
			topInsetDip: 85,
		});
		expect(normalizeWindowFramingSettings({ enabled: true, topInsetDip: -20 })).toEqual({
			enabled: true,
			topInsetDip: 0,
		});
		expect(normalizeWindowFramingSettings({ enabled: true, topInsetDip: 900 })).toEqual({
			enabled: true,
			topInsetDip: 300,
		});
	});
});

describe("calculateTopInsetDipFromGuidePosition", () => {
	it("subtracts the detected native frame before converting the guide to logical pixels", () => {
		expect(
			calculateTopInsetDipFromGuidePosition({
				guideRatio: 0.2,
				frameBounds: { x: 0, y: 0, width: 1600, height: 1000 },
				clientBounds: { x: 8, y: 40, width: 1584, height: 952 },
				dpiScale: 1.5,
			}),
		).toBe(107);
	});

	it("clamps guide positions to the supported inset range", () => {
		const geometry = {
			frameBounds: { x: 0, y: 0, width: 800, height: 600 },
			clientBounds: null,
			dpiScale: 1,
		};
		expect(calculateTopInsetDipFromGuidePosition({ ...geometry, guideRatio: -1 })).toBe(0);
		expect(calculateTopInsetDipFromGuidePosition({ ...geometry, guideRatio: 1 })).toBe(300);
	});
});

describe("calculateWindowFramingCropRegion", () => {
	it("combines the detected client area with a DPI-scaled top inset", () => {
		expect(
			calculateWindowFramingCropRegion({
				frameBounds: { x: 100, y: 40, width: 1600, height: 1000 },
				clientBounds: { x: 108, y: 80, width: 1584, height: 952 },
				dpiScale: 1.5,
				topInsetDip: 80,
			}),
		).toEqual({
			x: 8 / 1600,
			y: 160 / 1000,
			width: 1584 / 1600,
			height: 832 / 1000,
		});
	});

	it("uses the inset for custom-titlebar windows whose client area fills the frame", () => {
		expect(
			calculateWindowFramingCropRegion({
				frameBounds: { x: -800, y: 0, width: 800, height: 600 },
				clientBounds: { x: -800, y: 0, width: 800, height: 600 },
				dpiScale: 1,
				topInsetDip: 96,
			}),
		).toEqual({ x: 0, y: 0.16, width: 1, height: 0.84 });
	});

	it("intersects partially off-frame client geometry", () => {
		expect(
			calculateWindowFramingCropRegion({
				frameBounds: { x: -20, y: -10, width: 1000, height: 700 },
				clientBounds: { x: -30, y: 20, width: 1020, height: 680 },
				dpiScale: 1,
				topInsetDip: 0,
			}),
		).toEqual({ x: 0, y: 30 / 700, width: 1, height: 670 / 700 });
	});

	it("falls back to the frame for manual inset when client detection is unavailable", () => {
		expect(
			calculateWindowFramingCropRegion({
				frameBounds: { x: 0, y: 0, width: 1280, height: 720 },
				clientBounds: null,
				dpiScale: 1.25,
				topInsetDip: 80,
			}),
		).toEqual({ x: 0, y: 100 / 720, width: 1, height: 620 / 720 });
	});

	it("caps excessive inset while leaving visible content", () => {
		expect(
			calculateWindowFramingCropRegion({
				frameBounds: { x: 0, y: 0, width: 400, height: 200 },
				clientBounds: { x: 4, y: 24, width: 392, height: 172 },
				dpiScale: 2,
				topInsetDip: 300,
			}),
		).toEqual({ x: 0.01, y: 0.975, width: 0.98, height: 0.005 });
	});

	it("rejects invalid and non-overlapping geometry", () => {
		expect(
			calculateWindowFramingCropRegion({
				frameBounds: { x: 0, y: 0, width: 0, height: 720 },
				clientBounds: null,
				dpiScale: 1,
				topInsetDip: 80,
			}),
		).toBeNull();
		expect(
			calculateWindowFramingCropRegion({
				frameBounds: { x: 0, y: 0, width: 800, height: 600 },
				clientBounds: { x: 1000, y: 0, width: 800, height: 600 },
				dpiScale: 1,
				topInsetDip: 0,
			}),
		).toBeNull();
	});
});
