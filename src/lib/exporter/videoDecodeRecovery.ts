export interface VideoDecodeFailureContext {
	decoderConfig: VideoDecoderConfig;
	chunkIndex?: number;
	chunk?: EncodedVideoChunk;
	decoderState?: CodecState;
}

function failureCode(error: unknown): string {
	const name = error instanceof DOMException ? error.name : "";
	switch (name) {
		case "EncodingError":
			return "VIDEO_DECODE_ENCODING_ERROR";
		case "QuotaExceededError":
			return "VIDEO_DECODER_RESOURCE_EXHAUSTED";
		case "NotSupportedError":
			return "VIDEO_CODEC_UNSUPPORTED";
		case "InvalidStateError":
			return "VIDEO_DECODER_INVALID_STATE";
		default:
			return "VIDEO_DECODE_FAILED";
	}
}

/** Only failures originating in decoder operations are eligible for replay. */
export class VideoDecodeFailure extends Error {
	readonly code: string;
	constructor(
		error: unknown,
		context: VideoDecodeFailureContext,
		readonly phase: "configure" | "decode" = "decode",
	) {
		const code = failureCode(error);
		const details = [`codec=${context.decoderConfig.codec}`];
		if (context.decoderConfig.hardwareAcceleration)
			details.push(`hardwareAcceleration=${context.decoderConfig.hardwareAcceleration}`);
		if (context.chunkIndex !== undefined) details.push(`chunkIndex=${context.chunkIndex}`);
		if (context.chunk)
			details.push(
				`chunkTimestampUs=${context.chunk.timestamp}`,
				`sourceTimeSec=${(context.chunk.timestamp / 1_000_000).toFixed(3)}`,
			);
		if (context.decoderState) details.push(`decoderState=${context.decoderState}`);
		super(
			`[${code}] VideoDecoder error: ${error instanceof Error ? error.message : String(error)} (${details.join(", ")})`,
		);
		this.code = code;
		(this as Error & { cause?: unknown }).cause = error;
	}
}

function recoveryFailure(initial: unknown, software: unknown): Error {
	const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
	const error = new Error(
		[
			"[VIDEO_DECODE_RECOVERY_FAILED] Default decoding and the software retry both failed.",
			`Initial decoder failure: ${describe(initial)}`,
			`Software decoder failure: ${describe(software)}`,
			"Chunk positions are the last submitted input, not necessarily the exact failing frame. Source corruption is not confirmed.",
		].join("\n"),
	);
	(error as Error & { cause?: unknown }).cause = { initial, software };
	return error;
}

/** Replay decode state once, retaining output already successfully handed to the compositor. */
export async function withVideoDecodeRecovery<T extends unknown[]>(options: {
	codec: string;
	isCancelled: () => boolean;
	onFrame: (...args: T) => Promise<void>;
	attempt: (onFrame: (...args: T) => Promise<void>, forceSoftware: boolean) => Promise<void>;
}): Promise<void> {
	let emittedFrames = 0;
	let callbackFailed = false;
	const deliver = async (...args: T) => {
		try {
			await options.onFrame(...args);
		} catch (error) {
			callbackFailed = true;
			throw error;
		}
	};
	try {
		await options.attempt(async (...args) => {
			await deliver(...args);
			emittedFrames++;
		}, false);
	} catch (initial) {
		if (
			options.isCancelled() ||
			callbackFailed ||
			/av01|av1/i.test(options.codec) ||
			!(initial instanceof VideoDecodeFailure) ||
			initial.phase !== "decode" ||
			!["VIDEO_DECODE_ENCODING_ERROR", "VIDEO_DECODER_RESOURCE_EXHAUSTED"].includes(
				initial.code,
			)
		)
			throw initial;
		console.warn(
			"[StreamingVideoDecoder] Decoder failed; replaying with software decoding",
			initial,
		);
		let replayedFrames = 0;
		try {
			await options.attempt(async (...args) => {
				if (replayedFrames++ < emittedFrames) return;
				await deliver(...args);
			}, true);
			if (!options.isCancelled() && replayedFrames < emittedFrames)
				throw new Error("Software replay ended before previously exported frames");
		} catch (software) {
			if (callbackFailed || options.isCancelled()) throw software;
			throw recoveryFailure(initial, software);
		}
	}
}
