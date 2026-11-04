import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioProcessor } from "./audioEncoder";

const mocks = vi.hoisted(() => ({
	load: vi.fn(),
	info: vi.fn(),
	config: vi.fn(),
	destroy: vi.fn(),
	revoke: vi.fn(),
}));
vi.mock("web-demuxer", () => ({
	WebDemuxer: class {
		load = mocks.load;
		getMediaInfo = mocks.info;
		getDecoderConfig = mocks.config;
		destroy = mocks.destroy;
	},
}));
vi.mock("./localMediaSource", () => ({
	resolveMediaElementSource: async () => ({
		src: "http://localhost/video",
		revoke: mocks.revoke,
	}),
}));

type AudioDecodeAccess = {
	decodeAudioFromUrl(url: string): Promise<AudioBuffer | null>;
	bulkDecodeFromUrl(url: string, sampleRate: number): Promise<AudioBuffer | null>;
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("window", { location: { href: "http://localhost/" } });
	mocks.load.mockResolvedValue(undefined);
	mocks.config.mockRejectedValue(new Error("Audio configuration unavailable"));
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("silent screen recording audio detection", () => {
	it("does not fetch the entire video for bulk audio decoding when no audio stream exists", async () => {
		mocks.info.mockResolvedValue({
			streams: [{ codec_type_string: "video", width: 3840, height: 2160 }],
		});
		const processor = new AudioProcessor() as unknown as AudioDecodeAccess;
		const bulk = vi.spyOn(processor, "bulkDecodeFromUrl").mockResolvedValue({} as AudioBuffer);
		expect(await processor.decodeAudioFromUrl("large-screen-recording.mp4")).toBeNull();
		expect(bulk).not.toHaveBeenCalled();
		expect(mocks.config).not.toHaveBeenCalled();
		expect(mocks.destroy).toHaveBeenCalledOnce();
		expect(mocks.revoke).toHaveBeenCalledOnce();
	});

	it("keeps bulk fallback when the streaming demuxer misdetects a WAV as an invalid video", async () => {
		mocks.info.mockResolvedValue({
			streams: [{ codec_type_string: "video", width: 0, height: 0 }],
		});
		const processor = new AudioProcessor() as unknown as AudioDecodeAccess;
		const audio = {} as AudioBuffer;
		const bulk = vi.spyOn(processor, "bulkDecodeFromUrl").mockResolvedValue(audio);
		expect(await processor.decodeAudioFromUrl("narration.raw.wav")).toBe(audio);
		expect(bulk).toHaveBeenCalledWith("narration.raw.wav", 48000);
	});

	it("keeps bulk fallback for an actual audio stream with an unsupported streaming codec", async () => {
		mocks.info.mockResolvedValue({ streams: [{ codec_type_string: "audio" }] });
		const processor = new AudioProcessor() as unknown as AudioDecodeAccess;
		const audio = {} as AudioBuffer;
		const bulk = vi.spyOn(processor, "bulkDecodeFromUrl").mockResolvedValue(audio);
		expect(await processor.decodeAudioFromUrl("narration.wav")).toBe(audio);
		expect(bulk).toHaveBeenCalledWith("narration.wav", 48000);
	});
});
