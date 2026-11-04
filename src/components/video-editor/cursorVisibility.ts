import {
	getClipSourceEndMs,
	getClipSourceStartMs,
	type ClipRegion,
	type CursorTelemetryPoint,
} from "./types";

const maskedClicks = new WeakMap<
	CursorTelemetryPoint[],
	WeakMap<readonly ClipRegion[], CursorTelemetryPoint[]>
>();

export function isCursorHiddenAtSourceTime(
	clips: readonly ClipRegion[] | undefined,
	timeMs: number,
): boolean {
	return (
		clips?.find(
			(clip) => timeMs >= getClipSourceStartMs(clip) && timeMs < getClipSourceEndMs(clip),
		)?.hideCursor === true
	);
}

/** Frame-center gating prevents temporal blur samples leaking a cursor into a hidden clip. */
export function getVisibleCursorTelemetry(
	samples: CursorTelemetryPoint[] | undefined,
	clips: readonly ClipRegion[] | undefined,
	timeMs: number,
	frameCenterTimeMs = timeMs,
): CursorTelemetryPoint[] {
	if (
		isCursorHiddenAtSourceTime(clips, timeMs) ||
		isCursorHiddenAtSourceTime(clips, frameCenterTimeMs)
	)
		return [];
	if (!samples || !clips?.some((clip) => clip.hideCursor)) return samples ?? [];
	let byClips = maskedClicks.get(samples);
	if (!byClips) {
		byClips = new WeakMap();
		maskedClicks.set(samples, byClips);
	}
	let visible = byClips.get(clips);
	if (!visible) {
		visible = samples.map((point) =>
			point.interactionType && isCursorHiddenAtSourceTime(clips, point.timeMs)
				? { ...point, interactionType: undefined }
				: point,
		);
		byClips.set(clips, visible);
	}
	return visible;
}
