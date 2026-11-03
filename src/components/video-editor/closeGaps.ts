import type { EditorHistorySnapshot } from "./editorHistory";
import { getClipSourceEndMs, getClipSourceStartMs, type ClipRegion } from "./types";

export type TimelineGap = { startMs: number; endMs: number };

/** Hold a retained raw frame, or park at the closest playable source boundary. */
export function resolveGapClosureSourceTime(sourceTimeMs: number, clips: ClipRegion[]): number {
	let closestMs = 0;
	let closestDistance = Number.POSITIVE_INFINITY;
	for (const clip of [...clips].sort((a, b) => a.startMs - b.startMs)) {
		const startMs = getClipSourceStartMs(clip);
		const endMs = getClipSourceEndMs(clip);
		if (sourceTimeMs >= startMs && sourceTimeMs < endMs) return sourceTimeMs;
		for (const boundary of [startMs, Math.max(startMs, endMs - 1)]) {
			const distance = Math.abs(sourceTimeMs - boundary);
			if (distance < closestDistance) {
				closestDistance = distance;
				closestMs = boundary;
			}
		}
	}
	return closestMs;
}

/** Only empty space preceding footage is a gap; the unused source tail is not. */
export function findTimelineGaps(clips: ClipRegion[]): TimelineGap[] {
	const gaps: TimelineGap[] = [];
	let coveredUntilMs = 0;
	for (const clip of [...clips].sort((a, b) => a.startMs - b.startMs)) {
		if (clip.startMs > coveredUntilMs) {
			gaps.push({ startMs: coveredUntilMs, endMs: clip.startMs });
		}
		coveredUntilMs = Math.max(coveredUntilMs, clip.endMs);
	}
	return gaps;
}

/** Omit selectedGap to close all current gaps as a single edit. */
export function planCloseTimelineGaps(
	state: EditorHistorySnapshot,
	selectedGap?: TimelineGap,
): EditorHistorySnapshot | null {
	const currentGaps = findTimelineGaps(state.clipRegions);
	const gaps = selectedGap
		? currentGaps.filter(
				(gap) => gap.startMs === selectedGap.startMs && gap.endMs === selectedGap.endMs,
			)
		: currentGaps;
	// Validate the entire selected span against current footage, never a cached width.
	if (gaps.length === 0) return null;
	const collapseTime = (time: number) =>
		time -
		gaps.reduce(
			(removed, gap) => removed + Math.max(0, Math.min(time, gap.endMs) - gap.startMs),
			0,
		);
	const collapseVisuals = <T extends TimelineGap>(regions: T[]): T[] =>
		regions.map((region) => {
			const startMs = collapseTime(region.startMs);
			return {
				...region,
				startMs,
				// A visual in empty space stays editable instead of disappearing.
				endMs: Math.max(startMs + 1, collapseTime(region.endMs)),
			};
		});
	return {
		...state,
		clipRegions: state.clipRegions.map((clip) => {
			const startMs = collapseTime(clip.startMs);
			if (startMs === clip.startMs) return clip;
			return {
				...clip,
				sourceStartMs: getClipSourceStartMs(clip),
				startMs,
				endMs: startMs + clip.endMs - clip.startMs,
			};
		}),
		zoomRegions: collapseVisuals(state.zoomRegions),
		annotationRegions: collapseVisuals(state.annotationRegions),
		// Imported narration has its own clock: ripple placement, never media duration.
		audioRegions: state.audioRegions.map((region) => {
			const startMs = collapseTime(region.startMs);
			return { ...region, startMs, endMs: startMs + region.endMs - region.startMs };
		}),
		// Captions/word timings and legacy speed regions are already source-anchored.
	};
}
