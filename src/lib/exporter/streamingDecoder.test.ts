import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDecodedFrameStartupOffsetUs,
	getDecodedFrameTimelineOffsetUs,
	StreamingVideoDecoder,
} from "./streamingDecoder";

const {
	mockDemuxerLoad,
	mockDemuxerGetMediaInfo,
	mockDemuxerDestroy,
	mockDemuxerGetDecoderConfig,
	mockDemuxerRead,
} = vi.hoisted(() => ({
	mockDemuxerLoad: vi.fn(),
	mockDemuxerGetMediaInfo: vi.fn(async () => ({
		duration: 4,
		start_time: 0,
		streams: [
			{
				codec_type_string: "video",
				width: 1920,
				height: 1080,
				avg_frame_rate: "30/1",
				codec_string: "avc1.640034",
				start_time: 0,
				duration: 4,
			},
		],
	})),
	mockDemuxerDestroy: vi.fn(),
	mockDemuxerGetDecoderConfig: vi.fn(),
	mockDemuxerRead: vi.fn(),
}));

vi.mock("web-demuxer", () => ({
	WebDemuxer: class MockWebDemuxer {
		load = mockDemuxerLoad;
		getMediaInfo = mockDemuxerGetMediaInfo;
		destroy = mockDemuxerDestroy;
		getDecoderConfig = mockDemuxerGetDecoderConfig;
		read = mockDemuxerRead;
	},
}));

describe("StreamingVideoDecoder ordered clips", () => {
	const frames: Array<{ timestamp: number; close: ReturnType<typeof vi.fn> }> = [];
	const readers: Array<{ cancel: ReturnType<typeof vi.fn> }> = [];
	const decoderCloses: Array<ReturnType<typeof vi.fn>> = [];
	beforeEach(() => {
		frames.length = 0;
		readers.length = 0;
		decoderCloses.length = 0;
		mockDemuxerLoad.mockResolvedValue(undefined);
		mockDemuxerGetDecoderConfig.mockResolvedValue({ codec: "avc1.640034" });
		vi.stubGlobal("window", { location: { href: "http://localhost:5173/" } });
		vi.stubGlobal(
			"VideoDecoder",
			class {
				state = "unconfigured";
				decodeQueueSize = 0;
				close = vi.fn(() => {
					this.state = "closed";
				});
				constructor(private callbacks: { output: (frame: unknown) => void }) {
					decoderCloses.push(this.close);
				}
				configure() {
					this.state = "configured";
				}
				decode(chunk: { timestamp: number }) {
					const frame = { timestamp: chunk.timestamp, close: vi.fn() };
					frames.push(frame);
					this.callbacks.output(frame);
				}
				async flush() {}
			},
		);
		mockDemuxerRead.mockImplementation((_type, start: number) => {
			let time = Math.floor(start) * 1_000_000;
			const reader = {
				read: async () => {
					const timestamp = time;
					time += 250_000;
					return timestamp < 4_000_000
						? { done: false, value: { timestamp } }
						: { done: true };
				},
				cancel: vi.fn(async () => {
					time = Infinity;
				}),
			};
			readers.push(reader);
			return { getReader: () => reader };
		});
	});
	afterEach(() => vi.unstubAllGlobals());
	const clips = [
		{
			id: "fast",
			startMs: 0,
			endMs: 1000,
			sourceStartMs: 0,
			sourceEndMs: 1999,
			speed: 2,
			hideCursor: true,
		},
		{
			id: "reuse",
			startMs: 1000,
			endMs: 2000,
			sourceStartMs: 1000,
			sourceEndMs: 2000,
			speed: 1,
		},
		{
			id: "last",
			startMs: 3000,
			endMs: 4000,
			sourceStartMs: 3000,
			sourceEndMs: 4000,
			speed: 1,
		},
	];

	it("preserves the repeated interval, pinned source ends, raw timestamps and final clip", async () => {
		const decoder = new StreamingVideoDecoder({ maxPendingFrames: 2 });
		await decoder.loadMetadata("https://example.test/video.mp4");
		expect(decoder.getEffectiveDuration([], [], clips)).toBe(3);
		const output: Array<{ timestamp: number; source: number; id?: string; decoded: number }> =
			[];
		await decoder.decodeAll(
			4,
			[],
			[],
			async (frame, timestamp, source, cursor, clip) => {
				expect(cursor).toBe(source);
				output.push({ timestamp, source, id: clip?.id, decoded: frame.timestamp });
			},
			clips,
		);
		expect(output).toHaveLength(12);
		expect(output[3].source).toBe(1499.25);
		expect(output[4]).toMatchObject({
			source: 1000,
			timestamp: 1_000_000,
			id: "reuse",
			decoded: 1_000_000,
		});
		expect(output.at(-1)).toMatchObject({
			source: 3750,
			timestamp: 2_750_000,
			id: "last",
			decoded: 3_750_000,
		});
		expect(mockDemuxerRead.mock.calls.slice(-2).map((call) => call[1])).toEqual([0, 1]);
		expect(frames.every((frame) => frame.close.mock.calls.length === 1)).toBe(true);
		expect(decoderCloses.every((close) => close.mock.calls.length === 1)).toBe(true);
	});

	it("does not add a frame per sub-frame cut", async () => {
		const decoder = new StreamingVideoDecoder();
		await decoder.loadMetadata("https://example.test/video.mp4");
		const tiny = Array.from({ length: 10 }, (_, i) => ({
			id: String(i),
			startMs: i * 11,
			endMs: (i + 1) * 11,
			sourceStartMs: i * 100,
			speed: 1,
		}));
		const callback = vi.fn(async () => {});
		await decoder.decodeAll(30, [], [], callback, tiny);
		expect(callback).toHaveBeenCalledTimes(4);
	});

	it.each([
		"cancel",
		"callback failure",
	])("closes all frames, readers and decoders after %s", async (mode) => {
		const decoder = new StreamingVideoDecoder({ maxPendingFrames: 1 });
		await decoder.loadMetadata("https://example.test/video.mp4");
		const run = decoder.decodeAll(
			30,
			[],
			[],
			async () => {
				if (mode === "cancel") decoder.cancel();
				else throw new Error("callback failed");
			},
			clips,
		);
		if (mode === "cancel") await run;
		else await expect(run).rejects.toThrow("callback failed");
		expect(frames.every((frame) => frame.close.mock.calls.length === 1)).toBe(true);
		expect(readers.every((reader) => reader.cancel.mock.calls.length === 1)).toBe(true);
		expect(decoderCloses.every((close) => close.mock.calls.length === 1)).toBe(true);
	});

	it("retains source trim/speed duration for projects without clips", async () => {
		const decoder = new StreamingVideoDecoder();
		await decoder.loadMetadata("https://example.test/video.mp4");
		expect(
			decoder.getEffectiveDuration(
				[{ id: "trim", startMs: 0, endMs: 1000 }],
				[{ id: "speed", startMs: 1000, endMs: 3000, speed: 2 }],
				[],
			),
		).toBe(2);
	});

	it("closes retained frames and decoder before awaiting a surface-blocked flush", async () => {
		let releaseFlush: (() => void) | undefined;
		const flush = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					releaseFlush = resolve;
				}),
		);
		vi.stubGlobal(
			"VideoDecoder",
			class {
				state = "unconfigured";
				decodeQueueSize = 0;
				constructor(private callbacks: { output: (frame: unknown) => void }) {}
				configure() {
					this.state = "configured";
				}
				decode(chunk: { timestamp: number }) {
					const frame = { timestamp: chunk.timestamp, close: vi.fn() };
					frames.push(frame);
					this.callbacks.output(frame);
				}
				flush = flush;
				close() {
					expect(frames.every((frame) => frame.close.mock.calls.length === 1)).toBe(true);
					this.state = "closed";
					releaseFlush?.();
				}
			},
		);
		const decoder = new StreamingVideoDecoder();
		await decoder.loadMetadata("https://example.test/video.mp4");
		let complete = false;
		const callback = vi.fn(async () => {
			await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce(), {
				timeout: 300,
				interval: 10,
			});
		});
		const run = decoder
			.decodeAll(4, [], [], callback, [{ id: "short", startMs: 0, endMs: 1000, speed: 1 }])
			.then(() => {
				complete = true;
			});
		try {
			await vi.waitFor(() => expect(complete).toBe(true), { timeout: 300, interval: 10 });
			expect(flush).toHaveBeenCalledOnce();
			expect(callback).toHaveBeenCalledTimes(4);
		} finally {
			// Release a blocked old implementation so a failing regression leaves no pending work.
			releaseFlush?.();
			await run;
			decoder.destroy();
		}
	});

	it("resumes feeding on dequeue when the codec buffers frames before producing output", async () => {
		vi.stubGlobal(
			"VideoDecoder",
			class {
				state = "unconfigured";
				decodeQueueSize = 0;
				ondequeue: (() => void) | null = null;
				buffered: Array<{ timestamp: number }> = [];
				submitted = 0;
				constructor(private callbacks: { output: (frame: unknown) => void }) {}
				configure() {
					this.state = "configured";
				}
				decode(chunk: { timestamp: number }) {
					this.submitted++;
					this.decodeQueueSize++;
					this.buffered.push(chunk);
					setTimeout(() => {
						if (this.state === "closed") return;
						this.decodeQueueSize--;
						this.ondequeue?.();
						if (this.submitted >= 5) this.outputBuffered();
					}, 0);
				}
				outputBuffered() {
					for (const chunk of this.buffered.splice(0)) {
						const frame = { timestamp: chunk.timestamp, close: vi.fn() };
						frames.push(frame);
						this.callbacks.output(frame);
					}
				}
				async flush() {
					this.outputBuffered();
				}
				close() {
					this.state = "closed";
				}
			},
		);
		const decoder = new StreamingVideoDecoder({ maxDecodeQueue: 2 });
		await decoder.loadMetadata("https://example.test/video.mp4");
		let complete = false;
		const callback = vi.fn(async () => {});
		const run = decoder
			.decodeAll(4, [], [], callback, [{ id: "short", startMs: 0, endMs: 1000, speed: 1 }])
			.then(() => {
				complete = true;
			});
		try {
			await vi.waitFor(() => expect(complete).toBe(true), { timeout: 300, interval: 10 });
			expect(callback).toHaveBeenCalledTimes(4);
			expect(frames.every((frame) => frame.close.mock.calls.length === 1)).toBe(true);
		} finally {
			decoder.cancel();
			await run;
			decoder.destroy();
		}
	});
});

const mockReadLocalFile = vi.fn();
const mockGetLocalMediaUrl = vi.fn(async (filePath: string) => ({
	success: true,
	url: `http://127.0.0.1:4321/video?path=${encodeURIComponent(filePath)}`,
}));

describe("StreamingVideoDecoder local media loading", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		mockDemuxerLoad.mockReset();
		mockDemuxerGetMediaInfo.mockClear();
		mockDemuxerDestroy.mockClear();
		mockDemuxerGetDecoderConfig.mockClear();
		mockReadLocalFile.mockReset();
		mockGetLocalMediaUrl.mockReset();
		mockGetLocalMediaUrl.mockImplementation(async (filePath: string) => ({
			success: true,
			url: `http://127.0.0.1:4321/video?path=${encodeURIComponent(filePath)}`,
		}));
		Object.assign(globalThis, {
			window: {
				location: {
					href: "http://localhost:5173/",
				},
				electronAPI: {
					readLocalFile: mockReadLocalFile,
					getLocalMediaUrl: mockGetLocalMediaUrl,
				},
			},
		});
	});

	it("loads loopback media-server URLs directly into WebDemuxer", async () => {
		const decoder = new StreamingVideoDecoder();
		await decoder.loadMetadata("http://127.0.0.1:43123/video?path=%2Ftmp%2Fcapture.mp4");

		expect(window.electronAPI.readLocalFile).not.toHaveBeenCalled();
		expect(mockDemuxerLoad).toHaveBeenCalledWith(
			"http://127.0.0.1:43123/video?path=%2Ftmp%2Fcapture.mp4",
		);
	});

	it("resolves absolute local paths to range-streamed media URLs", async () => {
		const decoder = new StreamingVideoDecoder();
		await decoder.loadMetadata("/tmp/capture.mp4");

		expect(window.electronAPI.getLocalMediaUrl).toHaveBeenCalledWith("/tmp/capture.mp4");
		expect(mockDemuxerLoad).toHaveBeenCalledWith(
			"http://127.0.0.1:4321/video?path=%2Ftmp%2Fcapture.mp4",
		);
	});

	it("retries the range-streamed URL when direct local loading fails", async () => {
		mockDemuxerLoad.mockReset();
		mockDemuxerLoad
			.mockRejectedValueOnce(new Error("get_media_info failed: Failed after 3 attempts"))
			.mockResolvedValueOnce(undefined);
		const decoder = new StreamingVideoDecoder();
		await decoder.loadMetadata("/tmp/fallback.mp4");

		expect(mockDemuxerLoad).toHaveBeenNthCalledWith(
			2,
			"http://127.0.0.1:4321/video?path=%2Ftmp%2Ffallback.mp4",
		);
		expect(window.electronAPI.readLocalFile).not.toHaveBeenCalled();
	});

	it("keeps an explicit local retry on the range-streamed URL", async () => {
		const decoder = new StreamingVideoDecoder();
		await decoder.loadMetadata("/tmp/retry.mp4", {
			useFallbackMediaSource: true,
		});

		expect(mockDemuxerLoad).toHaveBeenCalledWith(
			"http://127.0.0.1:4321/video?path=%2Ftmp%2Fretry.mp4",
		);
		expect(window.electronAPI.readLocalFile).not.toHaveBeenCalled();
	});
});

describe("getDecodedFrameStartupOffsetUs", () => {
	it("ignores positive stream start metadata when the first decoded frame matches it", () => {
		expect(
			getDecodedFrameStartupOffsetUs(4_978_000, {
				streamStartTime: 4.978,
			}),
		).toBe(0);
	});

	it("returns only the startup gap beyond the stream start timestamp", () => {
		expect(
			getDecodedFrameStartupOffsetUs(5_128_000, {
				streamStartTime: 4.978,
			}),
		).toBe(150_000);
	});

	it("falls back to media start time and then zero when stream metadata is missing", () => {
		expect(
			getDecodedFrameStartupOffsetUs(250_000, {
				mediaStartTime: 0.1,
			}),
		).toBe(150_000);

		expect(getDecodedFrameStartupOffsetUs(250_000, {})).toBe(250_000);
	});
});

describe("getDecodedFrameTimelineOffsetUs", () => {
	it("preserves a non-zero stream start time when decoded timestamps match the stream start", () => {
		expect(
			getDecodedFrameTimelineOffsetUs(6_741_667, {
				mediaStartTime: 0,
				streamStartTime: 6.741667,
			}),
		).toBe(6_741_667);
	});

	it("includes both the stream start offset and any startup gap beyond it", () => {
		expect(
			getDecodedFrameTimelineOffsetUs(5_128_000, {
				mediaStartTime: 0,
				streamStartTime: 4.978,
			}),
		).toBe(5_128_000);
	});

	it("falls back to a media-relative startup gap when stream metadata is missing", () => {
		expect(
			getDecodedFrameTimelineOffsetUs(250_000, {
				mediaStartTime: 0.1,
			}),
		).toBe(150_000);
	});
});
