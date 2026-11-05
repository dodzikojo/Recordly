import { afterEach, describe, expect, it, vi } from "vitest";
import { VideoFrameStager } from "./videoFrameStager";

function setup() {
	const canvases: Array<{ width: number; height: number; getContext: ReturnType<typeof vi.fn> }> =
		[];
	const contexts: Array<{
		clearRect: ReturnType<typeof vi.fn>;
		drawImage: ReturnType<typeof vi.fn>;
	}> = [];
	vi.stubGlobal("document", {
		createElement: vi.fn(() => {
			const context = { clearRect: vi.fn(), drawImage: vi.fn() };
			const canvas = { width: 0, height: 0, getContext: vi.fn(() => context) };
			contexts.push(context);
			canvases.push(canvas);
			return canvas;
		}),
	});
	return { canvases, contexts };
}

afterEach(() => vi.unstubAllGlobals());

describe("decoded export frame ownership", () => {
	it("copies pixels before the caller releases the decoder frame, without retaining its surface", () => {
		const { canvases, contexts } = setup();
		const frame = {
			displayWidth: 3840,
			displayHeight: 2160,
			timestamp: 0,
			close: vi.fn(),
		} as unknown as VideoFrame;
		const stager = new VideoFrameStager();
		const result = stager.stage(frame, "scene", 640, 360);
		expect(result).toBe(canvases[0]);
		expect(result).toMatchObject({ width: 3840, height: 2160 });
		expect(canvases[0].getContext).toHaveBeenCalledWith("2d", { willReadFrequently: true });
		expect(contexts[0].drawImage).toHaveBeenCalledWith(frame, 0, 0, 3840, 2160);
		frame.close();
		stager.dispose();
		expect(frame.close).toHaveBeenCalledTimes(1);
	});

	it("refreshes a reused canvas for every frame, including equal timestamps after a seek", () => {
		const { canvases, contexts } = setup();
		const stager = new VideoFrameStager();
		const first = { displayWidth: 640, displayHeight: 360, timestamp: 0 } as VideoFrame;
		const second = { displayWidth: 640, displayHeight: 360, timestamp: 0 } as VideoFrame;
		expect(stager.stage(first, "scene", 640, 360)).toBe(
			stager.stage(second, "scene", 640, 360),
		);
		expect(canvases).toHaveLength(1);
		expect(contexts[0].drawImage.mock.calls.map((call) => call[0])).toEqual([first, second]);
	});

	it("keeps scene, wallpaper and webcam pixels independent and resizes on resolution changes", () => {
		const { canvases } = setup();
		const stager = new VideoFrameStager();
		const frame = { displayWidth: 640, displayHeight: 360 } as VideoFrame;
		const scene = stager.stage(frame, "scene", 640, 360);
		const background = stager.stage(frame, "background", 640, 360);
		const webcam = stager.stage(frame, "webcam", 640, 360);
		expect(new Set([scene, background, webcam]).size).toBe(3);
		const resized = stager.stage(
			{ displayWidth: 1920, displayHeight: 1080 } as VideoFrame,
			"scene",
			640,
			360,
		);
		expect(resized).toBe(scene);
		expect(resized).toMatchObject({ width: 1920, height: 1080 });
		expect(background).toMatchObject({ width: 640, height: 360 });
		stager.dispose();
		expect(canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
		expect(stager.stage(frame, "scene", 640, 360)).not.toBe(scene);
	});

	it("fails explicitly when a pixel copy cannot be created instead of exporting an empty scene", () => {
		vi.stubGlobal("document", { createElement: () => ({ getContext: () => null }) });
		expect(() => new VideoFrameStager().stage({} as VideoFrame, "scene", 640, 360)).toThrow(
			/canvas/i,
		);
	});
});
