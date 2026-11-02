import { describe, expect, it } from "vitest";
import {
	FRESH_TAKE_SETTLE_FALLBACK_MS,
	FRESH_TAKE_ZOOM_QUIET_MS,
	isFreshTakeSettled,
} from "./useFreshTakeSettled";

const VIDEO = "file:///recordings/take-1.mp4";

describe("isFreshTakeSettled", () => {
	it("uses the documented timing constants", () => {
		expect(FRESH_TAKE_SETTLE_FALLBACK_MS).toBe(8000);
		expect(FRESH_TAKE_ZOOM_QUIET_MS).toBe(750);
	});

	it("is false while the preview is not ready", () => {
		expect(
			isFreshTakeSettled({
				videoPath: VIDEO,
				isPreviewReady: false,
				pendingAutoZoomPath: null,
				msSincePreviewReady: 60_000,
			}),
		).toBe(false);
	});

	it("is true once the preview is ready and the pending auto-zoom path is cleared", () => {
		expect(
			isFreshTakeSettled({
				videoPath: VIDEO,
				isPreviewReady: true,
				pendingAutoZoomPath: null,
				msSincePreviewReady: 0,
			}),
		).toBe(true);
	});

	it("is true when the pending path belongs to a different video", () => {
		expect(
			isFreshTakeSettled({
				videoPath: VIDEO,
				isPreviewReady: true,
				pendingAutoZoomPath: "file:///recordings/other.mp4",
				msSincePreviewReady: 0,
			}),
		).toBe(true);
	});

	it("waits while the auto-zooms are still pending, until the 8 s fallback", () => {
		const base = {
			videoPath: VIDEO,
			isPreviewReady: true,
			pendingAutoZoomPath: VIDEO,
		};
		expect(isFreshTakeSettled({ ...base, msSincePreviewReady: 7_999 })).toBe(false);
		expect(isFreshTakeSettled({ ...base, msSincePreviewReady: 8_000 })).toBe(true);
	});

	it("is false without a video path", () => {
		expect(
			isFreshTakeSettled({
				videoPath: null,
				isPreviewReady: true,
				pendingAutoZoomPath: null,
				msSincePreviewReady: 60_000,
			}),
		).toBe(false);
	});
});
