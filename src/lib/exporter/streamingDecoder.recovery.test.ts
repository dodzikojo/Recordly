import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamingVideoDecoder } from "./streamingDecoder";

const mocks = vi.hoisted(() => ({
	load: vi.fn(),
	info: vi.fn(),
	config: vi.fn(),
	read: vi.fn(),
	destroy: vi.fn(),
}));
vi.mock("web-demuxer", () => ({
	WebDemuxer: class {
		load = mocks.load;
		getMediaInfo = mocks.info;
		getDecoderConfig = mocks.config;
		read = mocks.read;
		destroy = mocks.destroy;
	},
}));

const clips = [
	{
		id: "fast",
		startMs: 0,
		endMs: 500,
		sourceStartMs: 0,
		sourceEndMs: 999,
		speed: 2,
		hideCursor: true,
	},
	{ id: "backward", startMs: 500, endMs: 1500, sourceStartMs: 500, sourceEndMs: 1500, speed: 1 },
	{ id: "tail", startMs: 1500, endMs: 2500, sourceStartMs: 3000, sourceEndMs: 4000, speed: 1 },
];

describe.each(["legacy", "clips"] as const)("StreamingVideoDecoder %s recovery", (path) => {
	const frames: Array<{ timestamp: number; close: ReturnType<typeof vi.fn> }> = [];
	const decoders: FakeDecoder[] = [];
	const readers: Array<{ cancel: ReturnType<typeof vi.fn> }> = [];
	let failSoftware = false;
	let failureName = "EncodingError";
	let setupFailure = false;
	let synchronousFailure = false;
	let outputCount = 0;
	let countBeforeRetry = 0;
	let callbackFailure: Error | null = null;
	let failCallbackInSoftware = false;
	let failSoftwareConfig = false;
	let secondaryShutdownError = false;
	let blockFlush = false;
	let releaseFlush: (() => void) | undefined;
	let callbackGate: Promise<void> | null = null;
	let maxPendingFrames = 1;
	let failOnFlush = false;
	let emptySoftware = false;
	let failureAt = 1_000_000;

	class FakeDecoder {
		state: CodecState = "unconfigured";
		decodeQueueSize = 0;
		software = false;
		configure = vi.fn((config: VideoDecoderConfig) => {
			this.software = config.hardwareAcceleration === "prefer-software";
			if (setupFailure || (this.software && failSoftwareConfig))
				throw new DOMException("configuration failed", "EncodingError");
			if (this.software) {
				countBeforeRetry = outputCount;
				expect(decoders.slice(0, -1).every((d) => d.state === "closed")).toBe(true);
				expect(frames.every((f) => f.close.mock.calls.length === 1)).toBe(true);
			}
			this.state = "configured";
		});
		constructor(private callbacks: VideoDecoderInit) {
			decoders.push(this);
		}
		decode(chunk: EncodedVideoChunk) {
			if (
				!failOnFlush &&
				failureName &&
				chunk.timestamp >= failureAt &&
				(!this.software || failSoftware)
			) {
				const error = new DOMException(
					this.software ? "software failure" : "driver failure",
					failureName,
				);
				if (synchronousFailure) throw error;
				this.state = "closed";
				this.callbacks.error(error);
				if (secondaryShutdownError)
					throw new DOMException("decoder was closed", "InvalidStateError");
				return;
			}
			if (this.software && emptySoftware) return;
			const frame = { timestamp: chunk.timestamp, close: vi.fn() };
			frames.push(frame);
			this.callbacks.output(frame as unknown as VideoFrame);
		}
		async flush() {
			if (failOnFlush && (!this.software || failSoftware))
				throw new DOMException("flush failed", "EncodingError");
			if (blockFlush)
				await new Promise<void>((resolve) => {
					releaseFlush = resolve;
				});
		}
		close = vi.fn(() => {
			if (blockFlush) expect(frames.every((f) => f.close.mock.calls.length === 1)).toBe(true);
			this.state = "closed";
			releaseFlush?.();
		});
	}

	beforeEach(() => {
		frames.length = 0;
		decoders.length = 0;
		readers.length = 0;
		failSoftware = false;
		failureName = "EncodingError";
		setupFailure = false;
		synchronousFailure = false;
		outputCount = 0;
		countBeforeRetry = 0;
		callbackFailure = null;
		failCallbackInSoftware = false;
		failSoftwareConfig = false;
		secondaryShutdownError = false;
		blockFlush = false;
		releaseFlush = undefined;
		callbackGate = null;
		maxPendingFrames = 1;
		failOnFlush = false;
		emptySoftware = false;
		failureAt = 1_000_000;
		vi.clearAllMocks();
		mocks.load.mockResolvedValue(undefined);
		mocks.info.mockResolvedValue({
			duration: 4,
			streams: [
				{
					codec_type_string: "video",
					width: 640,
					height: 360,
					codec_string: "avc1.640034",
					avg_frame_rate: "8/1",
					duration: 4,
				},
			],
		});
		mocks.config.mockResolvedValue({ codec: "avc1.640034", codedWidth: 640, codedHeight: 360 });
		mocks.read.mockImplementation((_type, start: number) => {
			let index = Math.floor(start * 8);
			const reader = {
				read: async () =>
					index < (blockFlush ? 16 : 32)
						? {
								done: false,
								value: {
									timestamp: index++ * 125_000,
									type: "key",
									duration: 125_000,
									byteLength: 7,
								},
							}
						: { done: true },
				cancel: vi.fn(async () => {
					index = Infinity;
				}),
			};
			readers.push(reader);
			return { getReader: () => reader };
		});
		vi.stubGlobal("VideoDecoder", FakeDecoder);
		vi.stubGlobal("window", { location: { href: "http://localhost:5173/" } });
	});
	afterEach(() => vi.unstubAllGlobals());

	async function run(onOutput?: () => void) {
		const decoder = new StreamingVideoDecoder({ maxPendingFrames, maxDecodeQueue: 1 });
		await decoder.loadMetadata("https://example.test/recording.mp4");
		const output: Array<{ time: number; source: number; cursor: number; clip?: string }> = [];
		const promise = decoder.decodeAll(
			8,
			[],
			[],
			async (_frame, time, source, cursor, clip) => {
				if (callbackGate) await callbackGate;
				if (callbackFailure && (!failCallbackInSoftware || decoders.at(-1)?.software))
					throw callbackFailure;
				output.push({ time, source, cursor, clip: clip?.id });
				outputCount++;
				onOutput?.();
			},
			path === "clips" ? clips : undefined,
		);
		return { decoder, promise, output };
	}

	function expectReleased() {
		expect(frames.length).toBeGreaterThan(0);
		for (const frame of frames) expect(frame.close).toHaveBeenCalledTimes(1);
		for (const decoder of decoders) expect(decoder.state).toBe("closed");
		for (const reader of readers) expect(reader.cancel).toHaveBeenCalledTimes(1);
	}

	it.each([
		"EncodingError",
		"QuotaExceededError",
	])("recovers %s after output without duplicate timestamps", async (name) => {
		failureName = name;
		const { promise, output } = await run();
		await promise;
		expect(countBeforeRetry).toBeGreaterThan(0);
		expect(output).toHaveLength(path === "clips" ? 20 : 32);
		expect(new Set(output.map((f) => f.time)).size).toBe(output.length);
		output.forEach((frame, index) => {
			expect(frame.time).toBe(index * 125_000);
			expect(frame.cursor).toBe(frame.source);
		});
		if (path === "clips") {
			expect(output[3]).toMatchObject({ source: 749.25, clip: "fast" });
			expect(output[4]).toMatchObject({ source: 500, clip: "backward" });
			expect(output.at(-1)).toMatchObject({ source: 3875, clip: "tail" });
		}
		expect(decoders.filter((d) => d.software).length).toBeGreaterThan(0);
		expectReleased();
	});

	it("retries synchronous chunk decoding failures", async () => {
		synchronousFailure = true;
		const { promise } = await run();
		await promise;
		expect(countBeforeRetry).toBeGreaterThan(0);
		expectReleased();
	});

	it("preserves both failures when software also fails", async () => {
		failSoftware = true;
		const { promise } = await run();
		await expect(promise).rejects.toThrow(/VIDEO_DECODE_RECOVERY_FAILED/);
		await expect(promise).rejects.toThrow(/driver failure[\s\S]*software failure/);
		expect(decoders).toHaveLength(2);
		expectReleased();
	});

	it("keeps the first decoder error when decode also reports a shutdown error", async () => {
		secondaryShutdownError = true;
		const { promise, output } = await run();
		await promise;
		expect(output).toHaveLength(path === "clips" ? 20 : 32);
		expectReleased();
	});

	it("preserves the original decoder failure if software configuration fails", async () => {
		failSoftwareConfig = true;
		const { promise } = await run();
		await expect(promise).rejects.toThrow(/driver failure[\s\S]*configuration failed/);
		expect(decoders).toHaveLength(2);
		expectReleased();
	});

	it("recovers a decoder flush failure without duplicating committed frames", async () => {
		failOnFlush = true;
		const { promise, output } = await run();
		await promise;
		expect(countBeforeRetry).toBeGreaterThan(0);
		expect(output).toHaveLength(path === "clips" ? 20 : 32);
		expect(new Set(output.map((f) => f.time)).size).toBe(output.length);
		expectReleased();
	});

	it("fails instead of accepting a software replay with no frames", async () => {
		emptySoftware = true;
		const { promise } = await run();
		await expect(promise).rejects.toThrow(/VIDEO_DECODE_RECOVERY_FAILED/);
		expect(decoders).toHaveLength(2);
		expectReleased();
	});

	it("does not accept empty software output when the initial decoder failed before its first frame", async () => {
		emptySoftware = true;
		failureAt = 0;
		const { promise } = await run();
		await expect(promise).rejects.toThrow(/VIDEO_DECODE_RECOVERY_FAILED/);
		expect(frames).toHaveLength(0);
		expect(decoders).toHaveLength(2);
		for (const decoder of decoders) expect(decoder.state).toBe("closed");
		for (const reader of readers) expect(reader.cancel).toHaveBeenCalledTimes(1);
	});

	it("propagates a renderer failure during replay without mislabeling it as decoder failure", async () => {
		failCallbackInSoftware = true;
		callbackFailure = new DOMException("renderer failed during replay", "EncodingError");
		const { promise } = await run();
		await expect(promise).rejects.toBe(callbackFailure);
		expect(decoders).toHaveLength(2);
		expectReleased();
	});

	it("releases frames and closes the decoder before awaiting a blocked flush after callback failure", async () => {
		failureName = "";
		blockFlush = true;
		maxPendingFrames = 64;
		let rejectCallback!: (error: Error) => void;
		callbackGate = new Promise((_resolve, reject) => {
			rejectCallback = reject;
		});
		const { decoder, promise } = await run();
		try {
			await vi.waitFor(() => expect(releaseFlush).toBeTypeOf("function"), { timeout: 1000 });
			rejectCallback(new Error("render rejected"));
			await expect(promise).rejects.toThrow("render rejected");
			expectReleased();
		} finally {
			rejectCallback(new Error("test cleanup"));
			releaseFlush?.();
			decoder.cancel();
			await promise.catch(() => undefined);
		}
	});

	it.each([
		"DataError",
		"InvalidStateError",
		"NotSupportedError",
	])("does not replay %s", async (name) => {
		failureName = name;
		const { promise } = await run();
		await expect(promise).rejects.toThrow("driver failure");
		expect(decoders).toHaveLength(1);
		expectReleased();
	});

	it("does not replay setup failures and closes the unconfigured decoder", async () => {
		setupFailure = true;
		const { promise } = await run();
		await expect(promise).rejects.toThrow("configuration failed");
		expect(decoders).toHaveLength(1);
		expect(decoders[0].state).toBe("closed");
		expect(readers).toHaveLength(0);
	});

	it("does not replay a renderer callback EncodingError and releases in-flight frames", async () => {
		callbackFailure = new DOMException("renderer failed", "EncodingError");
		const { promise } = await run();
		await expect(promise).rejects.toBe(callbackFailure);
		expect(decoders).toHaveLength(1);
		expectReleased();
	});

	it("does not replay after cancellation", async () => {
		let current: StreamingVideoDecoder | undefined;
		const result = await run(() => current?.cancel());
		current = result.decoder;
		await result.promise;
		expect(decoders).toHaveLength(1);
		expectReleased();
	});

	it("does not retry AV1 which already prefers software", async () => {
		failSoftware = true;
		mocks.info.mockResolvedValue({
			duration: 4,
			streams: [
				{
					codec_type_string: "video",
					width: 640,
					height: 360,
					codec_string: "av01.0.04M.08",
					avg_frame_rate: "8/1",
					duration: 4,
				},
			],
		});
		const { promise } = await run();
		await expect(promise).rejects.toThrow("software failure");
		expect(decoders).toHaveLength(1);
		expect(decoders[0].software).toBe(true);
		expectReleased();
	});
});
