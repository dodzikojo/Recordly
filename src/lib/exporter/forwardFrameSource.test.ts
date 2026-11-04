import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForwardFrameSource } from "./forwardFrameSource";

const { read, destroy } = vi.hoisted(() => ({ read: vi.fn(), destroy: vi.fn() }));
vi.mock("web-demuxer", () => ({
	WebDemuxer: class {
		load = vi.fn(async () => {});
		getMediaInfo = vi.fn(async () => ({
			duration: 4,
			streams: [{ codec_type_string: "video", codec_string: "avc1.640034", duration: 4 }],
		}));
		getDecoderConfig = vi.fn(async () => ({ codec: "avc1.640034" }));
		read = read;
		destroy = destroy;
	},
}));

describe("ForwardFrameSource clip reuse", () => {
	const frames: Array<{ timestamp: number; close: ReturnType<typeof vi.fn> }> = [];
	const closes: Array<ReturnType<typeof vi.fn>> = [];
	let blockFlush = false;
	const flushReleases: Array<() => void> = [];
	beforeEach(() => {
		frames.length = 0;
		closes.length = 0;
		blockFlush = false;
		flushReleases.length = 0;
		read.mockClear();
		vi.stubGlobal("window", { location: { href: "http://localhost:5173/" } });
		vi.stubGlobal(
			"VideoFrame",
			class {
				timestamp: number;
				close = vi.fn();
				constructor(source: { timestamp: number }) {
					this.timestamp = source.timestamp;
					frames.push(this);
				}
			},
		);
		vi.stubGlobal(
			"VideoDecoder",
			class {
				state = "unconfigured";
				decodeQueueSize = 0;
				close = vi.fn(() => {
					this.state = "closed";
					for (const release of flushReleases.splice(0)) release();
				});
				constructor(private callbacks: VideoDecoderInit) {
					closes.push(this.close);
				}
				configure() {
					this.state = "configured";
				}
				decode(chunk: { timestamp: number }) {
					const frame = { timestamp: chunk.timestamp, close: vi.fn() };
					frames.push(frame);
					this.callbacks.output(frame as unknown as VideoFrame);
				}
				async flush() {
					if (blockFlush)
						await new Promise<void>((resolve) => flushReleases.push(resolve));
				}
			},
		);
		read.mockImplementation((_type, start: number) => {
			let timestamp = Math.floor(start) * 1_000_000;
			return {
				getReader: () => ({
					read: async () => {
						const value = { timestamp };
						timestamp += 250_000;
						return value.timestamp < 4_000_000
							? { done: false, value }
							: { done: true };
					},
					cancel: async () => {
						timestamp = Infinity;
					},
				}),
			};
		});
	});
	afterEach(() => vi.unstubAllGlobals());

	it("keeps default forward-only callers strict", async () => {
		const source = new ForwardFrameSource();
		await source.initialize("https://example.test/webcam.mp4");
		(await source.getFrameAtTime(2))?.close();
		await expect(source.getFrameAtTime(1)).rejects.toThrow(
			"only supports increasing timestamps",
		);
		await source.destroy();
		expect(frames.every((frame) => frame.close.mock.calls.length === 1)).toBe(true);
	});

	it("restarts at a keyframe for backwards webcam cuts, preserving source time and frame ownership", async () => {
		const source = new ForwardFrameSource();
		await source.initialize("https://example.test/webcam.mp4");
		const first = await source.getFrameAtTime(2.5, true);
		expect(first?.timestamp).toBe(2_500_000);
		first?.close();
		const repeated = await source.getFrameAtTime(1.25, true);
		expect(repeated?.timestamp).toBe(1_250_000);
		repeated?.close();
		expect(read.mock.calls.map((call) => call[1])).toEqual([0, 1.25]);
		await source.destroy();
		expect(closes.every((close) => close.mock.calls.length === 1)).toBe(true);
		expect(frames.every((frame) => frame.close.mock.calls.length === 1)).toBe(true);
	});

	it.each([
		"restart",
		"destroy",
	])("releases retained webcam surfaces before awaiting the feeder during %s", async (action) => {
		blockFlush = true;
		const source = new ForwardFrameSource();
		await source.initialize("https://example.test/webcam.mp4");
		(await source.getFrameAtTime(2.5, true))?.close();
		await vi.waitFor(() => expect(flushReleases).toHaveLength(1));
		let complete = false;
		const operation = (
			action === "restart"
				? source.getFrameAtTime(1, true).then((frame) => frame?.close())
				: source.destroy()
		).then(() => {
			complete = true;
		});
		try {
			await vi.waitFor(() => expect(complete).toBe(true), { timeout: 300, interval: 10 });
		} finally {
			blockFlush = false;
			for (const release of flushReleases.splice(0)) release();
			await operation;
			await source.destroy();
		}
		expect(frames.every((frame) => frame.close.mock.calls.length === 1)).toBe(true);
	});

	it.each([
		"cancel",
		"destroy",
	])("does not resurrect decoding when %s arrives during a backwards restart", async (action) => {
		const source = new ForwardFrameSource();
		await source.initialize("https://example.test/webcam.mp4");
		(await source.getFrameAtTime(2.5, true))?.close();
		const restarted = source.getFrameAtTime(1, true);
		if (action === "cancel") source.cancel();
		else await source.destroy();
		expect(await restarted).toBeNull();
		expect(read).toHaveBeenCalledOnce();
		await source.destroy();
		expect(closes).toHaveLength(1);
		expect(frames.every((frame) => frame.close.mock.calls.length === 1)).toBe(true);
	});
});
