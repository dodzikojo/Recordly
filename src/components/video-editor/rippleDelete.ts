import type { EditorHistorySnapshot } from "./editorHistory";
import {
	getClipSourceEndMs,
	getClipSourceStartMs,
	mapTimelineTimeToSourceTime,
	type ClipRegion,
} from "./types";

type TimedRegion = { startMs: number; endMs: number };

/** Renderer inputs use source time; editing controls and persisted overlays use timeline time. */
export function mapTimelineRegionsToSource<T extends TimedRegion>(
	regions: T[],
	clips: ClipRegion[],
): T[] {
	return regions.map((region) => ({
		...region,
		startMs: mapTimelineTimeToSourceTime(region.startMs, clips),
		endMs: mapTimelineTimeToSourceTime(region.endMs, clips),
	}));
}

export function planRippleClipDelete(
	state: EditorHistorySnapshot,
	clipId: string,
): EditorHistorySnapshot | null {
	const deleted = state.clipRegions.find((clip) => clip.id === clipId);
	if (!deleted) return null;
	const { startMs, endMs } = deleted;
	const durationMs = endMs - startMs;
	if (!(durationMs > 0)) return null;
	const collapseTime = (time: number) =>
		time <= startMs ? time : Math.max(startMs, time - durationMs);
	const inside = (region: TimedRegion, start: number, end: number) =>
		region.startMs >= start && region.endMs <= end;
	const rippleRegions = <T extends TimedRegion>(regions: T[]): T[] =>
		regions
			.filter((region) => !inside(region, startMs, endMs))
			.map((region) => ({
				...region,
				startMs: collapseTime(region.startMs),
				endMs: collapseTime(region.endMs),
			}));
	const clipRegions = state.clipRegions
		.filter((clip) => clip.id !== clipId)
		.map((clip) =>
			clip.startMs >= endMs
				? {
						...clip,
						// Pin the original media position before changing a legacy timeline start.
						sourceStartMs: getClipSourceStartMs(clip),
						startMs: clip.startMs - durationMs,
						endMs: clip.endMs - durationMs,
					}
				: clip,
		);
	const zoomRegions = rippleRegions(state.zoomRegions);
	const annotationRegions = rippleRegions(state.annotationRegions);
	// Narration spanning the cut remains independent: move its placed start without
	// shortening or retiming its media. Short overlays contained in the cut are removed.
	const audioRegions = state.audioRegions
		.filter((region) => !inside(region, startMs, endMs))
		.map((region) => {
			const start = collapseTime(region.startMs);
			return { ...region, startMs: start, endMs: start + region.endMs - region.startMs };
		});
	const sourceStart = getClipSourceStartMs(deleted);
	const sourceEnd = getClipSourceEndMs(deleted);
	return {
		...state,
		clipRegions,
		zoomRegions,
		annotationRegions,
		audioRegions,
		// Captions, word timings and legacy speed regions already follow raw media.
		autoCaptions: state.autoCaptions.filter((cue) => !inside(cue, sourceStart, sourceEnd)),
		speedRegions: state.speedRegions.filter(
			(region) => !inside(region, sourceStart, sourceEnd),
		),
		selectedClipId: state.selectedClipId === clipId ? null : state.selectedClipId,
		selectedZoomId: zoomRegions.some((region) => region.id === state.selectedZoomId)
			? state.selectedZoomId
			: null,
		selectedAnnotationId: annotationRegions.some(
			(region) => region.id === state.selectedAnnotationId,
		)
			? state.selectedAnnotationId
			: null,
		selectedAudioId: audioRegions.some((region) => region.id === state.selectedAudioId)
			? state.selectedAudioId
			: null,
	};
}
