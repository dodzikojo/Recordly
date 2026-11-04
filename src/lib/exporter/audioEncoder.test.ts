import { describe, expect, it, vi } from "vitest";

import { AudioProcessor, softLimitOfflineMixPeaksInPlace } from "./audioEncoder";
import type {
	AudioRegion,
	ClipRegion,
	SpeedRegion,
	TrimRegion,
} from "@/components/video-editor/types";

type OfflineRenderTestHarness = AudioProcessor & {
	decodeAudioFromUrl(url: string): Promise<AudioBuffer | null>;
	getMediaDurationSec(url: string): Promise<number>;
	loadAudioFileDemuxer(audioPath: string): Promise<unknown>;
	prepareOfflineRender(
		videoUrl: string,
		trimRegions: TrimRegion[],
		speedRegions: SpeedRegion[],
		audioRegions: AudioRegion[],
		sourceAudioFallbackPaths: string[],
		sourceAudioFallbackStartDelayMsByPath?: Record<string, number>,
		sourceAudioTrackSettings?: undefined,
		clipRegions?: ClipRegion[],
	): Promise<{
		mainBufferEntry: { buffer: AudioBuffer; gain: number } | null;
		companionEntries: Array<{ buffer: AudioBuffer; startDelaySec: number; gain: number }>;
		regionEntries: Array<{ region: AudioRegion }>;
		slices: Array<{ sourceStartMs: number; sourceEndMs: number; speed: number }>;
		outputDurationMs: number;
		mutedSourceOutputRangesSec: Array<{ startSec: number; endSec: number }>;
	}>;
	renderAndMuxOfflineAudio(
		videoUrl: string,
		trimRegions: never[],
		speedRegions: never[],
		audioRegions: never[],
		sourceAudioFallbackPaths: string[],
		sourceAudioFallbackStartDelayMsByPath: Record<string, number> | undefined,
		muxer: unknown,
	): Promise<void>;
	renderChunked(
		prepared: {
			mainBufferEntry: null;
			companionEntries: [];
			regionEntries: [];
			mutedSourceOutputRangesSec: [];
			slices: [];
			outputDurationMs: number;
			numChannels: number;
		},
		totalOutputSec: number,
		onChunk: (
			rendered: AudioBuffer,
			outputOffsetSec: number,
			chunkIndex: number,
		) => Promise<void>,
	): Promise<void>;
};

function fakeAudioBuffer(channels: Float32Array[]): AudioBuffer {
	return {
		numberOfChannels: channels.length,
		getChannelData: (channel: number) => channels[channel],
	} as AudioBuffer;
}

describe("AudioProcessor offline render preparation", () => {
	it("keeps the source-copy path for equivalent unedited clips", async () => {
		const processor = new AudioProcessor() as unknown as OfflineRenderTestHarness;
		const render = vi.spyOn(processor, "renderAndMuxOfflineAudio").mockResolvedValue(undefined);
		vi.spyOn(processor, "getMediaDurationSec").mockResolvedValue(2);
		await processor.process(
			null,
			{} as never,
			"video.mp4",
			[],
			[],
			undefined,
			[],
			[],
			undefined,
			undefined,
			[{ id: "all", startMs: 0, endMs: 2000, speed: 1 }],
		);
		expect(render).not.toHaveBeenCalled();
	});

	it("preserves repeated source audio and the final narration at the exact clip duration", async () => {
		const processor = new AudioProcessor() as unknown as OfflineRenderTestHarness;
		vi.spyOn(processor, "decodeAudioFromUrl").mockResolvedValue({
			duration: 20,
			numberOfChannels: 1,
		} as AudioBuffer);
		const prepared = await processor.prepareOfflineRender(
			"video.mp4",
			[],
			[],
			[
				{
					id: "voice",
					audioPath: "voice.wav",
					startMs: 6500,
					endMs: 8000,
					volume: 1,
					speed: 1.25,
				},
			],
			[],
			undefined,
			undefined,
			[
				{
					id: "a",
					startMs: 1000,
					endMs: 2000,
					sourceStartMs: 0,
					sourceEndMs: 1999,
					speed: 2,
				},
				{
					id: "b",
					startMs: 5000,
					endMs: 7000,
					sourceStartMs: 1000,
					sourceEndMs: 3000,
					speed: 1,
					muted: true,
				},
				{
					id: "last",
					startMs: 7000,
					endMs: 8000,
					sourceStartMs: 18000,
					sourceEndMs: 19000,
					speed: 1,
				},
			],
		);
		expect(prepared.outputDurationMs).toBe(4000);
		expect(
			prepared.slices.map((slice) => [slice.sourceStartMs, slice.sourceEndMs, slice.speed]),
		).toEqual([
			[0, 1999, 1.999],
			[1000, 3000, 1],
			[18000, 19000, 1],
		]);
		expect(prepared.mutedSourceOutputRangesSec).toEqual([{ startSec: 1, endSec: 3 }]);
		expect(prepared.regionEntries[0].region).toMatchObject({
			startMs: 2500,
			endMs: 4000,
			speed: 1.25,
		});
	});

	it("uses clip-aware mixing even for repeated clips at normal speed with no other edits", async () => {
		const processor = new AudioProcessor() as unknown as OfflineRenderTestHarness;
		const render = vi.spyOn(processor, "renderAndMuxOfflineAudio").mockResolvedValue(undefined);
		await processor.process(
			null,
			{} as never,
			"video.mp4",
			[],
			[],
			undefined,
			[],
			[],
			undefined,
			undefined,
			[
				{ id: "a", startMs: 0, endMs: 1000, sourceStartMs: 0, speed: 1 },
				{ id: "b", startMs: 1000, endMs: 2000, sourceStartMs: 0, speed: 1 },
			],
		);
		expect(render).toHaveBeenCalledOnce();
	});

	it("keeps imported narration whole and at its edited start across sped-up clips and cuts", async () => {
		const processor = new AudioProcessor() as unknown as OfflineRenderTestHarness;
		vi.spyOn(processor, "decodeAudioFromUrl").mockResolvedValue({
			duration: 28,
			numberOfChannels: 1,
		} as AudioBuffer);
		vi.spyOn(processor, "getMediaDurationSec").mockResolvedValue(60);
		const prepared = await (
			processor as unknown as {
				prepareOfflineRender(
					video: string,
					trims: TrimRegion[],
					speeds: SpeedRegion[],
					audio: AudioRegion[],
					paths: string[],
					delays: undefined,
					gains: undefined,
					clips: ClipRegion[],
				): Promise<{
					regionEntries: Array<{ region: AudioRegion }>;
					outputDurationMs: number;
				}>;
			}
		).prepareOfflineRender(
			"video.mp4",
			[{ id: "cut", startMs: 11000, endMs: 30000 }],
			[{ id: "speed", startMs: 1000, endMs: 11000, speed: 5 }],
			[{ id: "voice", startMs: 1000, endMs: 29000, audioPath: "voice.wav", volume: 1 }],
			[],
			undefined,
			undefined,
			[
				{ id: "a", startMs: 1000, endMs: 3000, speed: 5 },
				{ id: "b", startMs: 30000, endMs: 60000, speed: 1 },
			],
		);
		expect(prepared.regionEntries[0].region).toMatchObject({ startMs: 0, endMs: 28000 });
	});
	it("keeps embedded source audio separate from external companion sidecars", async () => {
		const processor = new AudioProcessor() as unknown as OfflineRenderTestHarness;
		const mainBuffer = { duration: 10, numberOfChannels: 2 } as AudioBuffer;
		const micBuffer = { duration: 9.5, numberOfChannels: 1 } as AudioBuffer;

		const decodeAudioFromUrl = vi
			.spyOn(processor, "decodeAudioFromUrl")
			.mockImplementation(async (url: string) => {
				if (url === "file:///tmp/recording.mp4") {
					return mainBuffer;
				}
				if (url === "/tmp/recording.mic.wav") {
					return micBuffer;
				}
				return null;
			});
		vi.spyOn(processor, "getMediaDurationSec").mockResolvedValue(10);

		const prepared = await processor.prepareOfflineRender(
			"file:///tmp/recording.mp4",
			[],
			[],
			[],
			["/tmp/recording.mp4", "/tmp/recording.mic.wav"],
		);

		expect(prepared.mainBufferEntry?.buffer).toBe(mainBuffer);
		expect(prepared.mainBufferEntry?.gain).toBe(1);
		expect(prepared.companionEntries).toHaveLength(1);
		expect(prepared.companionEntries[0]?.buffer).toBe(micBuffer);
		expect(prepared.companionEntries[0]?.gain).toBe(1);
		expect(decodeAudioFromUrl).toHaveBeenCalledWith("file:///tmp/recording.mp4");
		expect(decodeAudioFromUrl).toHaveBeenCalledWith("/tmp/recording.mic.wav");
		expect(decodeAudioFromUrl).not.toHaveBeenCalledWith("/tmp/recording.mp4");
	});

	it("does not treat a single embedded fallback path as an external sidecar", async () => {
		const processor = new AudioProcessor() as unknown as OfflineRenderTestHarness;
		const loadAudioFileDemuxer = vi.spyOn(processor, "loadAudioFileDemuxer");
		const renderAndMuxOfflineAudio = vi
			.spyOn(processor, "renderAndMuxOfflineAudio")
			.mockResolvedValue();

		await processor.process(
			null,
			{} as never,
			"file:///tmp/recording.mp4",
			[],
			[],
			undefined,
			[],
			["/tmp/recording.mp4"],
		);

		expect(loadAudioFileDemuxer).not.toHaveBeenCalled();
		expect(renderAndMuxOfflineAudio).not.toHaveBeenCalled();
	});

	it("uses recorded companion start-delay metadata instead of inferring from duration gap", async () => {
		const processor = new AudioProcessor() as unknown as OfflineRenderTestHarness;
		const mainBuffer = { duration: 600, numberOfChannels: 2 } as AudioBuffer;
		const micBuffer = { duration: 565, numberOfChannels: 1 } as AudioBuffer;

		vi.spyOn(processor, "decodeAudioFromUrl").mockImplementation(async (url: string) => {
			if (url === "file:///tmp/recording.mp4") {
				return mainBuffer;
			}
			if (url === "/tmp/recording.mic.webm") {
				return micBuffer;
			}
			return null;
		});

		const prepared = await processor.prepareOfflineRender(
			"file:///tmp/recording.mp4",
			[],
			[],
			[],
			["/tmp/recording.mic.webm"],
			{ "/tmp/recording.mic.webm": 3_500 },
		);

		expect(prepared.companionEntries[0]?.startDelaySec).toBeCloseTo(3.5);
	});

	it("avoids the single-sidecar fast path when companion timing metadata is present", async () => {
		const processor = new AudioProcessor() as unknown as OfflineRenderTestHarness;
		const loadAudioFileDemuxer = vi.spyOn(processor, "loadAudioFileDemuxer");
		const renderAndMuxOfflineAudio = vi
			.spyOn(processor, "renderAndMuxOfflineAudio")
			.mockResolvedValue();

		await processor.process(
			null,
			{} as never,
			"file:///tmp/recording.mp4",
			[],
			[],
			undefined,
			[],
			["/tmp/recording.mic.webm"],
			{ "/tmp/recording.mic.webm": 2_000 },
		);

		expect(loadAudioFileDemuxer).not.toHaveBeenCalled();
		expect(renderAndMuxOfflineAudio).toHaveBeenCalled();
	});

	it("avoids the single-sidecar fast path for legacy mac mic sidecars that still need embedded audio", async () => {
		const processor = new AudioProcessor() as unknown as OfflineRenderTestHarness;
		const loadAudioFileDemuxer = vi.spyOn(processor, "loadAudioFileDemuxer");
		const renderAndMuxOfflineAudio = vi
			.spyOn(processor, "renderAndMuxOfflineAudio")
			.mockResolvedValue();

		await processor.process(
			{} as never,
			{} as never,
			"file:///tmp/recording.mp4",
			[],
			[],
			undefined,
			[],
			["/tmp/recording.mic.m4a"],
		);

		expect(loadAudioFileDemuxer).not.toHaveBeenCalled();
		expect(renderAndMuxOfflineAudio).toHaveBeenCalled();
	});

	it("soft-limits mixed peaks before encoding or WAV conversion", () => {
		const samples = new Float32Array([
			-1.6,
			-0.5,
			Number.NEGATIVE_INFINITY,
			Number.NaN,
			0,
			0.5,
			0.95,
			Number.POSITIVE_INFINITY,
			1.6,
		]);
		const changed = softLimitOfflineMixPeaksInPlace(fakeAudioBuffer([samples]));

		expect(changed).toBe(true);
		expect(samples[0]).toBeGreaterThanOrEqual(-0.986);
		expect(samples[1]).toBe(-0.5);
		expect(samples[2]).toBe(0);
		expect(samples[3]).toBe(0);
		expect(samples[5]).toBe(0.5);
		expect(samples[6]).toBeLessThan(0.95);
		expect(samples[6]).toBeGreaterThan(0.9);
		expect(samples[7]).toBe(0);
		expect(samples[8]).toBeLessThanOrEqual(0.986);
	});

	it("runs the offline mix limiter for every rendered chunk", async () => {
		const processor = new AudioProcessor() as unknown as OfflineRenderTestHarness;
		const renderedSamples = new Float32Array([1.4]);
		const renderedBuffer = fakeAudioBuffer([renderedSamples]);
		const originalOfflineAudioContext = globalThis.OfflineAudioContext;
		(
			globalThis as unknown as { OfflineAudioContext: typeof OfflineAudioContext }
		).OfflineAudioContext = class {
			constructor() {}

			startRendering() {
				return Promise.resolve(renderedBuffer);
			}
		} as unknown as typeof OfflineAudioContext;

		try {
			let observedPeak = Number.POSITIVE_INFINITY;
			await processor.renderChunked(
				{
					mainBufferEntry: null,
					companionEntries: [],
					regionEntries: [],
					mutedSourceOutputRangesSec: [],
					slices: [],
					outputDurationMs: 100,
					numChannels: 1,
				},
				0.1,
				async (rendered) => {
					observedPeak = rendered.getChannelData(0)[0] ?? 0;
				},
			);

			expect(observedPeak).toBeLessThanOrEqual(0.986);
		} finally {
			(
				globalThis as unknown as { OfflineAudioContext: typeof OfflineAudioContext }
			).OfflineAudioContext = originalOfflineAudioContext;
		}
	});
});
