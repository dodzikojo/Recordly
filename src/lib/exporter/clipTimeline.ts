import {
	getClipSourceEndMs,
	getClipSourceStartMs,
	sortClipRegions,
	type ClipRegion,
	type SpeedRegion,
} from "@/components/video-editor/types";

export interface ClipTimelineSlice {
	clip: ClipRegion;
	sourceStartMs: number;
	sourceEndMs: number;
	outputStartMs: number;
	outputEndMs: number;
	/** Exact source/played ratio, including pinned source ends after rounded speed edits. */
	speed: number;
}

const cursorClipOrders = new WeakMap<ClipRegion[], WeakMap<ClipRegion, ClipRegion[]>>();
const cursorClipOrdersWithoutRegions = new WeakMap<ClipRegion, ClipRegion[]>();

/** Active source reuse wins; retain other hidden clips so their click tails stay masked. */
export function getClipCursorRegions(
	clips: ClipRegion[] | undefined,
	active?: ClipRegion,
): ClipRegion[] | undefined {
	if (!active) return clips;
	let byActive = clips ? cursorClipOrders.get(clips) : cursorClipOrdersWithoutRegions;
	if (!byActive) {
		byActive = new WeakMap();
		cursorClipOrders.set(clips!, byActive);
	}
	let ordered = byActive.get(active);
	if (!ordered) {
		ordered = [active, ...(clips ?? []).filter((clip) => clip !== active)];
		byActive.set(active, ordered);
	}
	return ordered;
}

/** Timeline gaps are omitted. Source intervals remain ordered and may repeat or go backwards. */
export function buildClipTimelineSlices(clips: ClipRegion[]): ClipTimelineSlice[] {
	let outputMs = 0;
	return sortClipRegions(clips).flatMap((clip) => {
		const durationMs = Math.max(0, Math.round(clip.endMs - clip.startMs));
		if (!Number.isFinite(durationMs) || durationMs === 0) return [];
		const sourceStartMs = getClipSourceStartMs(clip);
		const sourceEndMs = getClipSourceEndMs(clip);
		const slice = {
			clip,
			sourceStartMs,
			sourceEndMs,
			outputStartMs: outputMs,
			outputEndMs: outputMs + durationMs,
			speed: (sourceEndMs - sourceStartMs) / durationMs,
		};
		outputMs = slice.outputEndMs;
		return [slice];
	});
}

export function getClipTimelineFrame(
	slices: ClipTimelineSlice[],
	frameIndex: number,
	frameRate: number,
): { sourceTimestampMs: number; clip: ClipRegion } | null {
	const outputMs = (frameIndex * 1000) / frameRate;
	let low = 0;
	let high = slices.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (slices[middle].outputEndMs <= outputMs) low = middle + 1;
		else high = middle;
	}
	const slice = slices[low];
	if (!slice) return null;
	return {
		clip: slice.clip,
		sourceTimestampMs: slice.sourceStartMs + (outputMs - slice.outputStartMs) * slice.speed,
	};
}

/** Whether the source-only trim/speed pipeline reproduces the same ordered movie. */
export function clipTimelineMatchesLegacy(
	clips: ClipRegion[] | undefined,
	sourceDurationMs: number,
	trims: Array<{ startMs: number; endMs: number }> = [],
	speeds: SpeedRegion[] = [],
): boolean {
	if (!clips?.length) return true;
	if (!Number.isFinite(sourceDurationMs) || sourceDurationMs <= 0) return false;
	const boundaries = new Set([0, sourceDurationMs]);
	for (const region of [...trims, ...speeds]) {
		boundaries.add(Math.max(0, Math.min(sourceDurationMs, region.startMs)));
		boundaries.add(Math.max(0, Math.min(sourceDurationMs, region.endMs)));
	}
	const ordered = [...boundaries].sort((a, b) => a - b);
	let outputMs = 0;
	const legacy = ordered.slice(0, -1).flatMap((start, index) => {
		const end = ordered[index + 1];
		const midpoint = (start + end) / 2;
		if (trims.some((trim) => midpoint >= trim.startMs && midpoint < trim.endMs)) return [];
		const speed =
			speeds.find((region) => midpoint >= region.startMs && midpoint < region.endMs)?.speed ??
			1;
		const slice = {
			sourceStartMs: start,
			sourceEndMs: end,
			outputStartMs: outputMs,
			outputEndMs: outputMs + (end - start) / speed,
			speed,
		};
		outputMs = slice.outputEndMs;
		return [slice];
	});
	type ComparableSlice = Pick<
		ClipTimelineSlice,
		"sourceStartMs" | "sourceEndMs" | "outputStartMs" | "outputEndMs" | "speed"
	>;
	const near = (a: number, b: number) =>
		Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 0.000001;
	const mergeAdjacent = (slices: ComparableSlice[]) => {
		const merged: ComparableSlice[] = [];
		for (const slice of slices) {
			const previous = merged[merged.length - 1];
			if (
				previous &&
				near(previous.sourceEndMs, slice.sourceStartMs) &&
				near(previous.outputEndMs, slice.outputStartMs) &&
				near(previous.speed, slice.speed)
			) {
				previous.sourceEndMs = slice.sourceEndMs;
				previous.outputEndMs = slice.outputEndMs;
			} else merged.push({ ...slice });
		}
		return merged;
	};
	const actual = mergeAdjacent(buildClipTimelineSlices(clips));
	const expected = mergeAdjacent(legacy);
	return (
		actual.length === expected.length &&
		actual.every((slice, index) =>
			(
				["sourceStartMs", "sourceEndMs", "outputStartMs", "outputEndMs", "speed"] as const
			).every((key) => near(slice[key], expected[index][key])),
		)
	);
}
