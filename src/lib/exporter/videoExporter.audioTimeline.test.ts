import { describe, expect, it, vi } from "vitest";
import { VideoExporter } from "./videoExporter";

const processAudio = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock("./audioEncoder", () => ({
	isAacAudioEncodingSupported: async () => true,
	AudioProcessor: class {
		process = processAudio;
		setOnProgress() {}
		cancel() {}
	},
}));
vi.mock("./streamingDecoder", () => ({
	StreamingVideoDecoder: class {
		loadMetadata = async () => ({ duration: 20, width: 640, height: 360, hasAudio: false });
		getEffectiveDuration = () => 3;
		decodeAll = async () => undefined;
		getDemuxer = () => ({});
		destroy() {}
	},
}));
vi.mock("./frameRenderer", () => ({
	FrameRenderer: class {
		initialize = async () => undefined;
		preflightWebcamBackgroundBlur = async () => undefined;
		destroy() {}
	},
}));
vi.mock("./muxer", () => ({
	VideoMuxer: class {
		initialize = async () => undefined;
		finalize = async () => ({ mode: "buffer", blob: new Blob() });
		cancel() {}
	},
}));

describe("legacy MP4 narration clock", () => {
	it("passes clips into the AAC audio mixer so narration is placed on edited time", async () => {
		const clips = [{ id: "fast", startMs: 0, endMs: 3000, sourceStartMs: 10000, speed: 2 }];
		const exporter = new VideoExporter({
			videoUrl: "https://example.test/recording.mp4",
			width: 640,
			height: 360,
			frameRate: 30,
			bitrate: 1_000_000,
			wallpaper: "#111111",
			zoomRegions: [],
			showShadow: false,
			shadowIntensity: 0,
			backgroundBlur: 0,
			cropRegion: { x: 0, y: 0, width: 1, height: 1 },
			clipRegions: clips,
			audioRegions: [
				{ id: "voice", startMs: 2000, endMs: 3000, audioPath: "voice.wav", volume: 1 },
			],
		});
		const access = exporter as unknown as {
			initializeEncoder(): Promise<void>;
			shouldUseExperimentalNativeExport(): boolean;
		};
		vi.spyOn(access, "initializeEncoder").mockResolvedValue(undefined);
		vi.spyOn(access, "shouldUseExperimentalNativeExport").mockReturnValue(false);
		expect((await exporter.export()).success).toBe(true);
		expect(processAudio).toHaveBeenCalledOnce();
		expect(processAudio.mock.calls[0][10]).toBe(clips);
	});
});
