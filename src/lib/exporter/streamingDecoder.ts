import { WebDemuxer } from "web-demuxer";
import type { ClipRegion, SpeedRegion, TrimRegion } from "@/components/video-editor/types";
import { getEffectiveVideoStreamDurationSeconds } from "@/lib/mediaTiming";
import { buildClipTimelineSlices, getClipTimelineFrame } from "./clipTimeline";
import { createFallbackDemuxerSource, resolveMediaResourceUrl } from "./localMediaSource";

const DEFAULT_MAX_DECODE_QUEUE = 12;
const DEFAULT_MAX_PENDING_FRAMES = 32;
const STARTUP_STABILIZATION_SECONDS = 1.25;
const STARTUP_MAX_DECODE_QUEUE = 12;
const STARTUP_MAX_PENDING_FRAMES = 28;

export interface DecodedVideoInfo {
	width: number;
	height: number;
	duration: number; // seconds
	mediaStartTime?: number; // seconds
	streamStartTime?: number; // seconds
	streamDuration?: number; // seconds
	frameRate: number;
	codec: string;
	hasAudio: boolean;
	audioCodec?: string;
	audioSampleRate?: number;
}

interface StreamingVideoDecoderLoadOptions {
	useFallbackMediaSource?: boolean;
}

/** Decoder retains ownership of the VideoFrame and closes it after use. */
type OnFrameCallback = (
	frame: VideoFrame,
	exportTimestampUs: number,
	sourceTimestampMs: number,
	cursorTimestampMs: number,
	clip?: ClipRegion,
) => Promise<void>;

export function getDecodedFrameStartupOffsetUs(
	firstDecodedFrameTimestampUs: number,
	metadata: Pick<DecodedVideoInfo, "mediaStartTime" | "streamStartTime">,
): number {
	const streamStartTimeUs = Math.round(
		(metadata.streamStartTime ?? metadata.mediaStartTime ?? 0) * 1_000_000,
	);

	return Math.max(0, firstDecodedFrameTimestampUs - streamStartTimeUs);
}

export function getDecodedFrameTimelineOffsetUs(
	firstDecodedFrameTimestampUs: number,
	metadata: Pick<DecodedVideoInfo, "mediaStartTime" | "streamStartTime">,
): number {
	const mediaStartTimeUs = Math.round((metadata.mediaStartTime ?? 0) * 1_000_000);
	const streamStartTimeUs = Math.round(
		(metadata.streamStartTime ?? metadata.mediaStartTime ?? 0) * 1_000_000,
	);

	return (
		Math.max(0, streamStartTimeUs - mediaStartTimeUs) +
		getDecodedFrameStartupOffsetUs(firstDecodedFrameTimestampUs, metadata)
	);
}

/**
 * Decodes video frames via web-demuxer + VideoDecoder in a single forward pass.
 * Way faster than seeking an HTMLVideoElement per frame.
 *
 * Frames in trimmed regions are decoded (needed for P/B-frame state) but discarded.
 * Kept frames are resampled to the target frame rate in a streaming pass.
 */
export class StreamingVideoDecoder {
	private demuxer: WebDemuxer | null = null;
	private decoder: VideoDecoder | null = null;
	private cancelled = false;
	private metadata: DecodedVideoInfo | null = null;
	private pendingFrames: VideoFrame[] = [];
	private cancelClipDecode: (() => void) | null = null;
	private readonly maxDecodeQueue: number;
	private readonly maxPendingFrames: number;

	constructor(options?: {
		maxDecodeQueue?: number;
		maxPendingFrames?: number;
	}) {
		this.maxDecodeQueue = Math.max(
			1,
			Math.floor(options?.maxDecodeQueue ?? DEFAULT_MAX_DECODE_QUEUE),
		);
		this.maxPendingFrames = Math.max(
			1,
			Math.floor(options?.maxPendingFrames ?? DEFAULT_MAX_PENDING_FRAMES),
		);
	}

	async loadMetadata(
		videoUrl: string,
		options: StreamingVideoDecoderLoadOptions = {},
	): Promise<DecodedVideoInfo> {
		if (this.decoder) {
			try {
				if (this.decoder.state === "configured") {
					this.decoder.close();
				}
			} catch {
				// Ignore cleanup errors while reloading metadata.
			}
			this.decoder = null;
		}

		if (this.demuxer) {
			try {
				this.demuxer.destroy();
			} catch {
				// Ignore cleanup errors while reloading metadata.
			}
			this.demuxer = null;
		}

		const resourceUrl = await resolveMediaResourceUrl(videoUrl);

		// Relative URL so it resolves correctly in both dev (http) and packaged (file://) builds
		const wasmUrl = new URL("./wasm/web-demuxer.wasm", window.location.href).href;
		const loadMediaInfo = async (source: string | File) => {
			this.demuxer = new WebDemuxer({ wasmFilePath: wasmUrl });
			await this.demuxer.load(source);
			return this.demuxer.getMediaInfo();
		};

		let mediaInfo;
		if (options.useFallbackMediaSource) {
			mediaInfo = await loadMediaInfo(await createFallbackDemuxerSource(videoUrl));
		} else {
			try {
				mediaInfo = await loadMediaInfo(resourceUrl);
			} catch (error) {
				console.warn(
					"[StreamingVideoDecoder] Direct source load failed, retrying with a fresh media source:",
					error,
				);
				const currentDemuxer = this.demuxer;
				if (currentDemuxer) {
					try {
						(currentDemuxer as unknown as { destroy: () => void }).destroy();
					} catch {
						// Ignore cleanup errors before fallback re-init.
					}
				}
				mediaInfo = await loadMediaInfo(await createFallbackDemuxerSource(videoUrl));
			}
		}

		const videoStream = mediaInfo.streams.find((s) => s.codec_type_string === "video");
		const audioStream = mediaInfo.streams.find((s) => s.codec_type_string === "audio");
		const mediaStartTime =
			typeof mediaInfo.start_time === "number" && Number.isFinite(mediaInfo.start_time)
				? mediaInfo.start_time
				: 0;
		const streamStartTime =
			typeof videoStream?.start_time === "number" && Number.isFinite(videoStream.start_time)
				? videoStream.start_time
				: mediaStartTime;

		let frameRate = 60;
		if (videoStream?.avg_frame_rate) {
			const parts = videoStream.avg_frame_rate.split("/");
			if (parts.length === 2) {
				const num = parseInt(parts[0], 10);
				const den = parseInt(parts[1], 10);
				if (den > 0 && num > 0) frameRate = num / den;
			}
		}

		this.metadata = {
			width: videoStream?.width || 1920,
			height: videoStream?.height || 1080,
			duration: mediaInfo.duration,
			mediaStartTime,
			streamStartTime,
			streamDuration:
				typeof videoStream?.duration === "number" && Number.isFinite(videoStream.duration)
					? videoStream.duration
					: undefined,
			frameRate,
			codec: videoStream?.codec_string || "unknown",
			hasAudio: !!audioStream,
			audioCodec: audioStream?.codec_string,
			audioSampleRate:
				typeof audioStream?.sample_rate === "string"
					? Number.parseInt(audioStream.sample_rate, 10)
					: undefined,
		};

		return this.metadata;
	}

	async decodeAll(
		targetFrameRate: number,
		trimRegions: TrimRegion[] | undefined,
		speedRegions: SpeedRegion[] | undefined,
		onFrame: OnFrameCallback,
		clipRegions?: ClipRegion[],
	): Promise<void> {
		if (!this.demuxer || !this.metadata) {
			throw new Error("Must call loadMetadata() before decodeAll()");
		}
		if (clipRegions?.length) {
			await this.decodeClipTimeline(targetFrameRate, clipRegions, onFrame);
			return;
		}

		const decoderConfig = await this.demuxer.getDecoderConfig("video");
		const codec = this.metadata.codec.toLowerCase();
		const shouldPreferSoftwareDecode = codec.includes("av01") || codec.includes("av1");
		const effectiveVideoDuration = getEffectiveVideoStreamDurationSeconds({
			duration: this.metadata.duration,
			streamDuration: this.metadata.streamDuration,
		});
		const segments = this.splitBySpeed(
			this.computeSegments(effectiveVideoDuration, trimRegions),
			speedRegions,
		);
		const segmentOutputFrameCounts = segments.map((segment) =>
			Math.ceil(((segment.endSec - segment.startSec) / segment.speed) * targetFrameRate),
		);
		const expectedOutputFrames = segmentOutputFrameCounts.reduce(
			(sum, count) => sum + count,
			0,
		);
		const frameDurationUs = 1_000_000 / targetFrameRate;
		const epsilonSec = 0.001;
		const startupStabilizationSeconds = STARTUP_STABILIZATION_SECONDS;
		const startupFrameBudget = Math.max(
			1,
			Math.round(targetFrameRate * startupStabilizationSeconds),
		);
		let exportFrameIndex = 0;
		let loggedSteadyStateBackpressure = false;
		const backpressureWaiters = new Set<() => void>();

		const notifyBackpressureProgress = () => {
			if (backpressureWaiters.size === 0) {
				return;
			}

			const waiters = [...backpressureWaiters];
			backpressureWaiters.clear();
			for (const resolve of waiters) {
				resolve();
			}
		};

		const waitForBackpressureProgress = () =>
			new Promise<void>((resolve) => {
				backpressureWaiters.add(resolve);
			});

		console.log(
			`[StreamingVideoDecoder] Startup-safe decode backpressure active for first ${startupStabilizationSeconds}s (${startupFrameBudget} frames)`,
		);

		// Async frame queue — decoder pushes, consumer pulls
		this.pendingFrames.length = 0;
		const pendingFrames = this.pendingFrames;
		let frameResolve: ((frame: VideoFrame | null) => void) | null = null;
		let decodeError: Error | null = null;
		let decodeDone = false;
		let firstDecodedFrameTimestampUs: number | null = null;
		let decodedFrameTimelineOffsetUs = 0;

		this.decoder = new VideoDecoder({
			output: (frame: VideoFrame) => {
				if (frameResolve) {
					const resolve = frameResolve;
					frameResolve = null;
					resolve(frame);
				} else {
					pendingFrames.push(frame);
				}
				notifyBackpressureProgress();
			},
			error: (e: DOMException) => {
				decodeError = new Error(`VideoDecoder error: ${e.message}`);
				if (frameResolve) {
					const resolve = frameResolve;
					frameResolve = null;
					resolve(null);
				}
				notifyBackpressureProgress();
			},
		});
		this.decoder.ondequeue = notifyBackpressureProgress;
		const preferredDecoderConfig = shouldPreferSoftwareDecode
			? {
					...decoderConfig,
					hardwareAcceleration: "prefer-software" as const,
				}
			: decoderConfig;

		try {
			this.decoder.configure(preferredDecoderConfig);
		} catch (error) {
			if (!shouldPreferSoftwareDecode) {
				throw error;
			}
			// Fall back to default decoder config if software preference is unsupported.
			this.decoder.configure(decoderConfig);
		}

		const getNextFrame = (): Promise<VideoFrame | null> => {
			if (decodeError) throw decodeError;
			if (pendingFrames.length > 0) {
				const frame = pendingFrames.shift()!;
				notifyBackpressureProgress();
				return Promise.resolve(frame);
			}
			if (decodeDone) return Promise.resolve(null);
			return new Promise((resolve) => {
				frameResolve = resolve;
			});
		};

		// One forward stream through the whole file.
		// Pass explicit range because some containers are truncated when no end is provided.
		const readEndSec =
			Math.max(
				this.metadata.duration + (this.metadata.mediaStartTime ?? 0),
				(this.metadata.streamDuration ?? this.metadata.duration) +
					(this.metadata.streamStartTime ?? this.metadata.mediaStartTime ?? 0),
			) + 0.5;
		const reader = this.demuxer.read("video", 0, readEndSec).getReader();

		// Feed chunks to decoder in background with backpressure
		const feedPromise = (async () => {
			try {
				while (!this.cancelled) {
					const { done, value: chunk } = await reader.read();
					if (done || !chunk) break;

					if (!loggedSteadyStateBackpressure && exportFrameIndex >= startupFrameBudget) {
						loggedSteadyStateBackpressure = true;
						console.log(
							"[StreamingVideoDecoder] Switched to steady-state decode backpressure",
						);
					}

					const decodeQueueLimit =
						exportFrameIndex < startupFrameBudget
							? Math.min(this.maxDecodeQueue, STARTUP_MAX_DECODE_QUEUE)
							: this.maxDecodeQueue;
					const pendingFrameLimit =
						exportFrameIndex < startupFrameBudget
							? Math.min(this.maxPendingFrames, STARTUP_MAX_PENDING_FRAMES)
							: this.maxPendingFrames;

					// Backpressure on both decode queue and decoded frame backlog.
					while (
						(this.decoder!.decodeQueueSize > decodeQueueLimit ||
							pendingFrames.length > pendingFrameLimit) &&
						!this.cancelled
					) {
						await waitForBackpressureProgress();
					}
					if (this.cancelled) break;

					this.decoder!.decode(chunk);
				}

				if (!this.cancelled && this.decoder!.state === "configured") {
					await this.decoder!.flush();
				}
			} catch (e) {
				decodeError = e instanceof Error ? e : new Error(String(e));
			} finally {
				decodeDone = true;
				if (frameResolve) {
					const resolve = frameResolve;
					frameResolve = null;
					resolve(null);
				}
				notifyBackpressureProgress();
			}
		})();

		// Route decoded frames into segments by timestamp, then deliver with VFR→CFR resampling
		let segmentIdx = 0;
		let segmentFrameIndex = 0;
		let lastDecodedFrameSec: number | null = null;
		let heldFrame: VideoFrame | null = null;
		let heldFrameSec = 0;

		const emitHeldFrameForTarget = async (segment: {
			startSec: number;
			endSec: number;
			speed: number;
		}) => {
			if (!heldFrame) return false;
			const segmentFrameCount = segmentOutputFrameCounts[segmentIdx];
			if (segmentFrameIndex >= segmentFrameCount) return false;

			const segmentDurationSec = segment.endSec - segment.startSec;
			const sourceTimeSec =
				segment.startSec + (segmentFrameIndex / segmentFrameCount) * segmentDurationSec;
			if (sourceTimeSec >= segment.endSec - epsilonSec) return false;

			const sourceTimestampMs = sourceTimeSec * 1000;
			await onFrame(
				heldFrame,
				exportFrameIndex * frameDurationUs,
				sourceTimestampMs,
				sourceTimestampMs,
			);
			segmentFrameIndex++;
			exportFrameIndex++;
			return true;
		};

		while (!this.cancelled && segmentIdx < segments.length) {
			const frame = await getNextFrame();
			if (!frame) break;

			if (firstDecodedFrameTimestampUs === null) {
				firstDecodedFrameTimestampUs = frame.timestamp;
				decodedFrameTimelineOffsetUs = getDecodedFrameTimelineOffsetUs(
					firstDecodedFrameTimestampUs,
					this.metadata,
				);
			}

			const normalizedFrameTimeSec = Math.max(
				0,
				(frame.timestamp - firstDecodedFrameTimestampUs + decodedFrameTimelineOffsetUs) /
					1_000_000,
			);
			const frameTimeSec: number =
				lastDecodedFrameSec === null
					? normalizedFrameTimeSec
					: Math.max(lastDecodedFrameSec, normalizedFrameTimeSec);
			lastDecodedFrameSec = frameTimeSec;

			// Finalize completed segments before handling this frame.
			while (
				segmentIdx < segments.length &&
				frameTimeSec >= segments[segmentIdx].endSec - epsilonSec
			) {
				const segment = segments[segmentIdx];
				while (!this.cancelled && (await emitHeldFrameForTarget(segment))) {
					// Keep emitting remaining output frames for this segment from the last known frame.
				}

				segmentIdx++;
				segmentFrameIndex = 0;
				if (
					heldFrame &&
					segmentIdx < segments.length &&
					heldFrameSec < segments[segmentIdx].startSec - epsilonSec
				) {
					heldFrame.close();
					heldFrame = null;
				}
			}

			if (segmentIdx >= segments.length) {
				frame.close();
				continue;
			}

			const currentSegment = segments[segmentIdx];

			// Before current segment (trimmed region or pre-roll).
			if (frameTimeSec < currentSegment.startSec - epsilonSec) {
				frame.close();
				continue;
			}

			if (!heldFrame) {
				heldFrame = frame;
				heldFrameSec = frameTimeSec;
				continue;
			}

			// Any target timestamp before this midpoint is closer to heldFrame than current frame.
			const handoffBoundarySec = (heldFrameSec + frameTimeSec) / 2;
			while (!this.cancelled) {
				const segmentFrameCount = segmentOutputFrameCounts[segmentIdx];
				if (segmentFrameIndex >= segmentFrameCount) {
					break;
				}

				const segmentDurationSec = currentSegment.endSec - currentSegment.startSec;
				const sourceTimeSec =
					currentSegment.startSec +
					(segmentFrameIndex / segmentFrameCount) * segmentDurationSec;
				if (sourceTimeSec >= currentSegment.endSec - epsilonSec) {
					break;
				}
				if (sourceTimeSec > handoffBoundarySec) {
					break;
				}

				const sourceTimestampMs = sourceTimeSec * 1000;
				await onFrame(
					heldFrame,
					exportFrameIndex * frameDurationUs,
					sourceTimestampMs,
					sourceTimestampMs,
				);
				segmentFrameIndex++;
				exportFrameIndex++;
			}

			heldFrame.close();
			heldFrame = frame;
			heldFrameSec = frameTimeSec;
		}

		// Flush remaining output frames for the last decoded frame.
		if (heldFrame && segmentIdx < segments.length) {
			while (!this.cancelled && segmentIdx < segments.length) {
				const segment = segments[segmentIdx];
				if (heldFrameSec < segment.startSec - epsilonSec) {
					break;
				}

				while (!this.cancelled && (await emitHeldFrameForTarget(segment))) {
					// Keep emitting output frames for the active segment.
				}

				segmentIdx++;
				segmentFrameIndex = 0;
				if (
					segmentIdx < segments.length &&
					heldFrameSec < segments[segmentIdx].startSec - epsilonSec
				) {
					break;
				}
			}
			heldFrame.close();
			heldFrame = null;
		} else if (heldFrame) {
			heldFrame.close();
			heldFrame = null;
		}

		// Drain leftover decoded frames
		while (!decodeDone) {
			const frame = await getNextFrame();
			if (!frame) break;
			frame.close();
		}

		try {
			reader.cancel();
		} catch {
			/* already closed */
		}
		await feedPromise;
		for (const f of pendingFrames) f.close();
		pendingFrames.length = 0;

		if (this.decoder?.state === "configured") {
			this.decoder.close();
		}
		this.decoder = null;

		const requiredEndSec = segments.length > 0 ? segments[segments.length - 1].endSec : 0;
		if (
			!this.cancelled &&
			lastDecodedFrameSec !== null &&
			requiredEndSec - lastDecodedFrameSec > 1 &&
			exportFrameIndex < expectedOutputFrames
		) {
			throw new Error(
				`Video decode ended early at ${lastDecodedFrameSec.toFixed(3)}s (needed ${requiredEndSec.toFixed(3)}s; rendered ${exportFrameIndex}/${expectedOutputFrames} frames).`,
			);
		}
	}

	/** Restart at a preceding keyframe only when the edited sequence moves backwards. */
	private async decodeClipTimeline(
		frameRate: number,
		clips: ClipRegion[],
		onFrame: OnFrameCallback,
	): Promise<void> {
		const slices = buildClipTimelineSlices(clips);
		const count = Math.ceil(((slices[slices.length - 1]?.outputEndMs ?? 0) / 1000) * frameRate);
		let session: Awaited<ReturnType<StreamingVideoDecoder["startClipDecodeSession"]>> | null =
			null;
		let lastSourceMs = -Infinity;
		try {
			for (let index = 0; index < count && !this.cancelled; index++) {
				const target = getClipTimelineFrame(slices, index, frameRate)!;
				if (!session || target.sourceTimestampMs < lastSourceMs) {
					await session?.close();
					if (this.cancelled) break;
					session = await this.startClipDecodeSession(target.sourceTimestampMs / 1000);
				}
				lastSourceMs = target.sourceTimestampMs;
				const frame = await session.frameAt(target.sourceTimestampMs / 1000);
				if (this.cancelled) break;
				if (!frame) throw new Error("Video decode produced no frame for the edited clip");
				await onFrame(
					frame,
					(index * 1_000_000) / frameRate,
					target.sourceTimestampMs,
					target.sourceTimestampMs,
					target.clip,
				);
			}
		} finally {
			await session?.close();
		}
	}

	private async startClipDecodeSession(startSec: number) {
		const metadata = this.metadata!;
		const config = await this.demuxer!.getDecoderConfig("video");
		const pending = this.pendingFrames;
		let held: VideoFrame | null = null;
		let heldSec = 0;
		let lookahead: VideoFrame | null = null;
		let done = false;
		let stopped = false;
		let error: Error | null = null;
		let firstTimestampUs: number | null = null;
		let timelineOffsetUs = 0;
		let frameWaiter: ((frame: VideoFrame | null) => void) | null = null;
		const finishWaiting = () => {
			const resolve = frameWaiter;
			frameWaiter = null;
			resolve?.(null);
		};
		const capacityWaiters = new Set<() => void>();
		const notify = () => {
			for (const resolve of capacityWaiters) resolve();
			capacityWaiters.clear();
		};
		const decoder = new VideoDecoder({
			output: (frame) => {
				if (stopped || this.cancelled) frame.close();
				else if (frameWaiter) {
					const resolve = frameWaiter;
					frameWaiter = null;
					resolve(frame);
				} else pending.push(frame);
				notify();
			},
			error: (cause) => {
				error = new Error(`VideoDecoder error: ${cause.message}`);
				finishWaiting();
				notify();
			},
		});
		decoder.ondequeue = notify;
		this.decoder = decoder;
		try {
			const software = /av01|av1/.test(metadata.codec.toLowerCase());
			try {
				decoder.configure(
					software ? { ...config, hardwareAcceleration: "prefer-software" } : config,
				);
			} catch (cause) {
				if (!software) throw cause;
				decoder.configure(config);
			}
		} catch (cause) {
			decoder.close();
			this.decoder = null;
			throw cause;
		}
		const endSec =
			Math.max(
				metadata.duration + (metadata.mediaStartTime ?? 0),
				(metadata.streamDuration ?? metadata.duration) +
					(metadata.streamStartTime ?? metadata.mediaStartTime ?? 0),
			) + 0.5;
		// web-demuxer defaults to backward keyframe seeking, keeping decoder pre-roll.
		let reader: ReadableStreamDefaultReader<EncodedVideoChunk>;
		try {
			reader = this.demuxer!.read(
				"video",
				Math.max(0, startSec + (metadata.mediaStartTime ?? 0)),
				endSec,
			).getReader();
		} catch (cause) {
			decoder.close();
			this.decoder = null;
			throw cause;
		}
		let cancelRead: Promise<void> | null = null;
		const stop = () => {
			stopped = true;
			notify();
			finishWaiting();
			cancelRead ??= reader.cancel().catch(() => {
				// A reader that has already ended needs no further cancellation.
			});
		};
		this.cancelClipDecode = stop;
		const feed = (async () => {
			try {
				while (!stopped && !this.cancelled && !error) {
					const { done: readDone, value } = await reader.read();
					if (readDone || !value) break;
					while (
						!stopped &&
						!this.cancelled &&
						!error &&
						(decoder.decodeQueueSize > this.maxDecodeQueue ||
							pending.length > this.maxPendingFrames)
					) {
						await new Promise<void>((resolve) => capacityWaiters.add(resolve));
					}
					if (stopped || this.cancelled || error) break;
					decoder.decode(value);
				}
				if (!stopped && !this.cancelled && !error && decoder.state === "configured")
					await decoder.flush();
			} catch (cause) {
				if (!stopped) error = cause instanceof Error ? cause : new Error(String(cause));
			} finally {
				done = true;
				finishWaiting();
				notify();
			}
		})();
		const next = async (): Promise<VideoFrame | null> => {
			if (error) throw error;
			const frame = pending.shift();
			if (frame) {
				notify();
				return frame;
			}
			if (done || stopped || this.cancelled) return null;
			const result = await new Promise<VideoFrame | null>((resolve) => {
				frameWaiter = resolve;
			});
			if (error) {
				result?.close();
				throw error;
			}
			return result;
		};
		const frameSec = (frame: VideoFrame) => {
			if (firstTimestampUs === null) {
				firstTimestampUs = frame.timestamp;
				timelineOffsetUs = getDecodedFrameTimelineOffsetUs(frame.timestamp, metadata);
			}
			return Math.max(0, (frame.timestamp - firstTimestampUs + timelineOffsetUs) / 1_000_000);
		};
		return {
			frameAt: async (targetSec: number) => {
				if (!held) {
					held = await next();
					if (!held) return null;
					heldSec = frameSec(held);
				}
				while (!stopped && !this.cancelled) {
					lookahead ??= await next();
					if (!lookahead) {
						if (targetSec - heldSec > 1)
							throw new Error(
								`Video decode ended early at ${heldSec.toFixed(3)}s (needed ${targetSec.toFixed(3)}s).`,
							);
						return held;
					}
					const nextSec = Math.max(heldSec, frameSec(lookahead));
					if (targetSec <= (heldSec + nextSec) / 2) return held;
					held.close();
					held = lookahead;
					heldSec = nextSec;
					lookahead = null;
				}
				return null;
			},
			close: async () => {
				stop();
				// Hardware flush can wait for surfaces retained by these frames. Release
				// them and abort the decoder before waiting for the feeder to finish.
				held?.close();
				held = null;
				lookahead?.close();
				lookahead = null;
				for (const frame of pending) frame.close();
				pending.length = 0;
				if (decoder.state !== "closed") decoder.close();
				await cancelRead;
				await feed;
				if (this.decoder === decoder) this.decoder = null;
				if (this.cancelClipDecode === stop) this.cancelClipDecode = null;
			},
		};
	}

	private computeSegments(
		totalDuration: number,
		trimRegions?: TrimRegion[],
	): Array<{ startSec: number; endSec: number }> {
		if (!trimRegions || trimRegions.length === 0) {
			return [{ startSec: 0, endSec: totalDuration }];
		}

		const sorted = [...trimRegions].sort((a, b) => a.startMs - b.startMs);
		const segments: Array<{ startSec: number; endSec: number }> = [];
		let cursor = 0;

		for (const trim of sorted) {
			const trimStart = trim.startMs / 1000;
			const trimEnd = trim.endMs / 1000;
			if (cursor < trimStart) {
				segments.push({ startSec: cursor, endSec: trimStart });
			}
			cursor = Math.max(cursor, trimEnd);
		}

		if (cursor < totalDuration) {
			segments.push({ startSec: cursor, endSec: totalDuration });
		}

		return segments;
	}

	getEffectiveDuration(
		trimRegions?: TrimRegion[],
		speedRegions?: SpeedRegion[],
		clipRegions?: ClipRegion[],
	): number {
		if (!this.metadata) throw new Error("Must call loadMetadata() first");
		if (clipRegions?.length) {
			const slices = buildClipTimelineSlices(clipRegions);
			return (slices[slices.length - 1]?.outputEndMs ?? 0) / 1000;
		}
		const trimSegments = this.computeSegments(
			getEffectiveVideoStreamDurationSeconds({
				duration: this.metadata.duration,
				streamDuration: this.metadata.streamDuration,
			}),
			trimRegions,
		);
		const speedSegments = this.splitBySpeed(trimSegments, speedRegions);
		return speedSegments.reduce((sum, seg) => sum + (seg.endSec - seg.startSec) / seg.speed, 0);
	}

	private splitBySpeed(
		segments: Array<{ startSec: number; endSec: number }>,
		speedRegions?: SpeedRegion[],
	): Array<{ startSec: number; endSec: number; speed: number }> {
		if (!speedRegions || speedRegions.length === 0)
			return segments.map((s) => ({ ...s, speed: 1 }));

		const result: Array<{ startSec: number; endSec: number; speed: number }> = [];
		for (const segment of segments) {
			const overlapping = speedRegions
				.filter(
					(sr) =>
						sr.startMs / 1000 < segment.endSec && sr.endMs / 1000 > segment.startSec,
				)
				.sort((a, b) => a.startMs - b.startMs);

			if (overlapping.length === 0) {
				result.push({ ...segment, speed: 1 });
				continue;
			}

			let cursor = segment.startSec;
			for (const sr of overlapping) {
				const srStart = Math.max(sr.startMs / 1000, segment.startSec);
				const srEnd = Math.min(sr.endMs / 1000, segment.endSec);
				if (cursor < srStart) {
					result.push({ startSec: cursor, endSec: srStart, speed: 1 });
				}
				const effectiveStart = Math.max(cursor, srStart);
				if (srEnd > effectiveStart) {
					result.push({
						startSec: effectiveStart,
						endSec: srEnd,
						speed: sr.speed,
					});
				}
				cursor = Math.max(cursor, srEnd);
			}
			if (cursor < segment.endSec)
				result.push({ startSec: cursor, endSec: segment.endSec, speed: 1 });
		}
		return result.filter((s) => s.endSec - s.startSec > 0.0001);
	}

	cancel(): void {
		this.cancelled = true;
		this.cancelClipDecode?.();
	}

	getDemuxer() {
		return this.demuxer;
	}

	destroy(): void {
		this.cancelled = true;
		this.cancelClipDecode?.();

		if (this.decoder) {
			try {
				if (this.decoder.state === "configured") this.decoder.close();
			} catch {
				/* ignore */
			}
			this.decoder = null;
		}

		if (this.demuxer) {
			try {
				this.demuxer.destroy();
			} catch {
				/* ignore */
			}
			this.demuxer = null;
		}

		for (const frame of this.pendingFrames) {
			try {
				frame.close();
			} catch {
				/* ignore */
			}
		}
		this.pendingFrames.length = 0;
	}
}
