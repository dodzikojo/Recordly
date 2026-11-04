import type { EditorHistorySnapshot } from "./editorHistory";
import { getClipSourceEndMs, getClipSourceStartMs, type ClipRegion } from "./types";

export type ClipSelection = {
	ids: string[];
	primaryId: string | null;
	anchorId: string | null;
};

export type ClipSelectionModifiers = { toggle?: boolean; range?: boolean; preserve?: boolean };

type TimedRegion = { startMs: number; endMs: number };
type SelectionSnapshot = EditorHistorySnapshot & {
	selectedClipIds?: string[];
	clipSelectionAnchorId?: string | null;
};

const emptySelection = (): ClipSelection => ({ ids: [], primaryId: null, anchorId: null });
const orderedClips = (clips: readonly ClipRegion[]) =>
	[...clips].sort((left, right) => left.startMs - right.startMs);
const inside = (region: TimedRegion, container: TimedRegion) =>
	region.startMs >= container.startMs && region.endMs <= container.endMs;
const overlaps = (left: TimedRegion, right: TimedRegion) =>
	left.startMs < right.endMs && left.endMs > right.startMs;

export function sanitizeClipSelection(
	selection: ClipSelection,
	clips: readonly ClipRegion[],
): ClipSelection {
	const selected = new Set(selection.ids);
	const sorted = orderedClips(clips);
	const ids = sorted.filter((clip) => selected.has(clip.id)).map((clip) => clip.id);
	if (!ids.length) return emptySelection();
	const primaryId =
		selection.primaryId && ids.includes(selection.primaryId)
			? selection.primaryId
			: ids[ids.length - 1];
	return {
		ids,
		primaryId,
		anchorId: sorted.some((clip) => clip.id === selection.anchorId)
			? selection.anchorId
			: primaryId,
	};
}

export function selectClip(
	selection: ClipSelection,
	clips: readonly ClipRegion[],
	id: string,
	modifiers: ClipSelectionModifiers = {},
): ClipSelection {
	const current = sanitizeClipSelection(selection, clips);
	const sorted = orderedClips(clips);
	const targetIndex = sorted.findIndex((clip) => clip.id === id);
	if (targetIndex < 0) return current;
	if (modifiers.preserve && !modifiers.toggle && !modifiers.range && current.ids.includes(id)) {
		return current;
	}
	if (modifiers.range) {
		const anchorId = current.anchorId ?? current.primaryId ?? id;
		const anchorIndex = sorted.findIndex((clip) => clip.id === anchorId);
		const range = sorted.slice(
			Math.min(anchorIndex, targetIndex),
			Math.max(anchorIndex, targetIndex) + 1,
		);
		return sanitizeClipSelection(
			{
				ids: [...(modifiers.toggle ? current.ids : []), ...range.map((clip) => clip.id)],
				primaryId: id,
				anchorId,
			},
			clips,
		);
	}
	if (modifiers.toggle) {
		return sanitizeClipSelection(
			{
				ids: current.ids.includes(id)
					? current.ids.filter((selectedId) => selectedId !== id)
					: [...current.ids, id],
				primaryId: id,
				anchorId: id,
			},
			clips,
		);
	}
	return { ids: [id], primaryId: id, anchorId: id };
}

export function selectAllClips(
	selection: ClipSelection,
	clips: readonly ClipRegion[],
): ClipSelection {
	const current = sanitizeClipSelection(selection, clips);
	const ids = orderedClips(clips).map((clip) => clip.id);
	if (!ids.length) return emptySelection();
	return {
		ids,
		primaryId: current.primaryId ?? ids[0],
		anchorId: current.anchorId ?? current.primaryId ?? ids[0],
	};
}

function sanitizeSnapshotSelection(state: SelectionSnapshot): EditorHistorySnapshot {
	if (state.selectedClipIds === undefined) return state;
	const selection = sanitizeClipSelection(
		{
			ids: state.selectedClipIds,
			primaryId: state.selectedClipId,
			anchorId: state.clipSelectionAnchorId ?? null,
		},
		state.clipRegions,
	);
	return {
		...state,
		selectedClipIds: selection.ids,
		selectedClipId: selection.primaryId,
		clipSelectionAnchorId: selection.anchorId,
	} as SelectionSnapshot;
}

/** Plan from drag-start state on every pointer move, never from a previous preview. */
export function planClipGroupMove(
	state: EditorHistorySnapshot,
	ids: readonly string[],
	requestedDeltaMs: number,
): { state: EditorHistorySnapshot; deltaMs: number } | null {
	if (!Number.isFinite(requestedDeltaMs) || requestedDeltaMs === 0) return null;
	const selectedIds = new Set(ids);
	const selected = state.clipRegions.filter((clip) => selectedIds.has(clip.id));
	if (!selected.length) return null;
	const obstacles = state.clipRegions.filter((clip) => !selectedIds.has(clip.id));
	let minimumDelta = Math.max(...selected.map((clip) => -clip.startMs));
	let maximumDelta = Number.POSITIVE_INFINITY;
	for (const clip of selected) {
		for (const obstacle of obstacles) {
			if (obstacle.endMs <= clip.startMs) {
				minimumDelta = Math.max(minimumDelta, obstacle.endMs - clip.startMs);
			} else if (obstacle.startMs >= clip.endMs) {
				maximumDelta = Math.min(maximumDelta, obstacle.startMs - clip.endMs);
			} else {
				// An already invalid layout has no safe common movement interval.
				return null;
			}
		}
	}
	const deltaMs = Math.max(minimumDelta, Math.min(maximumDelta, requestedDeltaMs));
	if (deltaMs === 0) return null;
	const moveOwned = <T extends TimedRegion>(regions: T[]): T[] =>
		regions.map((region) =>
			selected.some((clip) => inside(region, clip))
				? { ...region, startMs: region.startMs + deltaMs, endMs: region.endMs + deltaMs }
				: region,
		);
	return {
		deltaMs,
		state: sanitizeSnapshotSelection({
			...state,
			clipRegions: state.clipRegions.map((clip) =>
				selectedIds.has(clip.id)
					? {
							...clip,
							sourceStartMs: getClipSourceStartMs(clip),
							startMs: clip.startMs + deltaMs,
							endMs: clip.endMs + deltaMs,
						}
					: clip,
			),
			zoomRegions: moveOwned(state.zoomRegions),
			annotationRegions: moveOwned(state.annotationRegions),
		}),
	};
}

function unionSpans(regions: readonly TimedRegion[]): TimedRegion[] {
	const union: TimedRegion[] = [];
	for (const region of [...regions].sort((left, right) => left.startMs - right.startMs)) {
		const previous = union[union.length - 1];
		if (previous && region.startMs <= previous.endMs) {
			previous.endMs = Math.max(previous.endMs, region.endMs);
		} else {
			union.push({ startMs: region.startMs, endMs: region.endMs });
		}
	}
	return union;
}

export function planBulkClipDelete(
	state: EditorHistorySnapshot,
	ids: readonly string[],
): EditorHistorySnapshot | null {
	const selectedIds = new Set(ids);
	const deleted = state.clipRegions.filter(
		(clip) => selectedIds.has(clip.id) && clip.endMs > clip.startMs,
	);
	if (!deleted.length) return null;
	const deletedIds = new Set(deleted.map((clip) => clip.id));
	const cuts = unionSpans(deleted);
	const sourceCuts = unionSpans(
		deleted.map((clip) => ({
			startMs: getClipSourceStartMs(clip),
			endMs: getClipSourceEndMs(clip),
		})),
	);
	const containedInCut = (region: TimedRegion) => cuts.some((cut) => inside(region, cut));
	const collapseTime = (time: number) =>
		time -
		cuts.reduce(
			(removed, cut) => removed + Math.max(0, Math.min(time, cut.endMs) - cut.startMs),
			0,
		);
	const rippleVisuals = <T extends TimedRegion>(regions: T[]): T[] =>
		regions
			.filter((region) => !containedInCut(region))
			.map((region) => ({
				...region,
				startMs: collapseTime(region.startMs),
				endMs: collapseTime(region.endMs),
			}));
	const clipRegions = state.clipRegions
		.filter((clip) => !deletedIds.has(clip.id))
		.map((clip) => {
			const removedBefore = cuts.reduce(
				(removed, cut) =>
					removed + (cut.endMs <= clip.startMs ? cut.endMs - cut.startMs : 0),
				0,
			);
			return removedBefore === 0
				? clip
				: {
						...clip,
						sourceStartMs: getClipSourceStartMs(clip),
						startMs: clip.startMs - removedBefore,
						endMs: clip.endMs - removedBefore,
					};
		});
	const zoomRegions = rippleVisuals(state.zoomRegions);
	const annotationRegions = rippleVisuals(state.annotationRegions);
	const audioRegions = state.audioRegions
		.filter((region) => !containedInCut(region))
		.map((region) => {
			const startMs = collapseTime(region.startMs);
			return { ...region, startMs, endMs: startMs + region.endMs - region.startMs };
		});
	const next: SelectionSnapshot = {
		...state,
		clipRegions,
		zoomRegions,
		annotationRegions,
		audioRegions,
		autoCaptions: state.autoCaptions.filter(
			(region) => !sourceCuts.some((cut) => inside(region, cut)),
		),
		speedRegions: state.speedRegions.filter(
			(region) => !sourceCuts.some((cut) => inside(region, cut)),
		),
		selectedClipId:
			state.selectedClipId && deletedIds.has(state.selectedClipId)
				? null
				: state.selectedClipId,
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
	return sanitizeSnapshotSelection(next);
}

export type BulkClipSettingsPatch = {
	speed?: number;
	muted?: boolean;
	showSourceAudio?: boolean;
	hideCursor?: boolean;
};
export type BulkClipSettingsResult =
	| { ok: true; state: EditorHistorySnapshot }
	| { ok: false; reason: "invalid-speed" | "clip-overlap" | "zoom-overlap" };

export function planBulkClipSettings(
	state: EditorHistorySnapshot,
	ids: readonly string[],
	patch: BulkClipSettingsPatch,
): BulkClipSettingsResult {
	const { speed } = patch;
	if (speed !== undefined && (!Number.isFinite(speed) || speed <= 0)) {
		return { ok: false, reason: "invalid-speed" };
	}
	const selectedIds = new Set(ids);
	const selected = state.clipRegions.filter((clip) => selectedIds.has(clip.id));
	const clipRegions = state.clipRegions.map((clip) => {
		if (!selectedIds.has(clip.id)) return clip;
		const next = { ...clip };
		if (patch.muted !== undefined) next.muted = patch.muted;
		if (patch.hideCursor !== undefined) next.hideCursor = patch.hideCursor;
		if (patch.showSourceAudio !== undefined) next.showSourceAudio = patch.showSourceAudio;
		if (speed !== undefined) {
			next.speed = speed;
			next.sourceStartMs = getClipSourceStartMs(clip);
			next.sourceEndMs = getClipSourceEndMs(clip);
			const sourceDurationMs = next.sourceEndMs - next.sourceStartMs;
			next.endMs = Math.round(clip.startMs + sourceDurationMs / speed);
		}
		return next;
	});
	if (speed === undefined) return { ok: true, state: { ...state, clipRegions } };
	if (
		clipRegions.some(
			(clip) =>
				selectedIds.has(clip.id) &&
				(!Number.isFinite(clip.endMs) || clip.endMs <= clip.startMs),
		)
	) {
		return { ok: false, reason: "invalid-speed" };
	}
	if (
		clipRegions.some((clip, index) =>
			clipRegions.some(
				(other, otherIndex) =>
					otherIndex > index &&
					(selectedIds.has(clip.id) || selectedIds.has(other.id)) &&
					overlaps(clip, other),
			),
		)
	) {
		return { ok: false, reason: "clip-overlap" };
	}
	// Use the original owner for every zoom. Sequential single-clip plans can scale
	// a spanning zoom twice or reject an overlap that vanishes in the final state.
	const zoomRegions = state.zoomRegions.map((zoom) => {
		const owner = selected.find(
			(clip) => zoom.startMs >= clip.startMs && zoom.startMs < clip.endMs,
		);
		if (!owner) return zoom;
		const oldSpeed = Number.isFinite(owner.speed) && owner.speed > 0 ? owner.speed : 1;
		const scale = oldSpeed / speed;
		return {
			...zoom,
			startMs: Math.round(owner.startMs + (zoom.startMs - owner.startMs) * scale),
			endMs: Math.round(owner.startMs + (zoom.endMs - owner.startMs) * scale),
		};
	});
	const changedZoomIds = new Set(
		zoomRegions
			.filter(
				(zoom, index) =>
					zoom.startMs !== state.zoomRegions[index].startMs ||
					zoom.endMs !== state.zoomRegions[index].endMs,
			)
			.map((zoom) => zoom.id),
	);
	if (
		zoomRegions.some((zoom, index) =>
			zoomRegions.some(
				(other, otherIndex) =>
					otherIndex > index &&
					(changedZoomIds.has(zoom.id) || changedZoomIds.has(other.id)) &&
					overlaps(zoom, other),
			),
		)
	) {
		return { ok: false, reason: "zoom-overlap" };
	}
	return { ok: true, state: { ...state, clipRegions, zoomRegions } };
}
