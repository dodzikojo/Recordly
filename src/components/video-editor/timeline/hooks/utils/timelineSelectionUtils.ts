export type DeleteSelectionTarget =
	| "gap"
	| "keyframe"
	| "zoom"
	| "clip"
	| "annotation"
	| "audio"
	| "caption"
	| "none";

interface ResolveDeleteSelectionTargetParams {
	selectedGap?: { startMs: number; endMs: number } | null;
	selectAllBlocksActive: boolean;
	selectedKeyframeId: string | null;
	selectedZoomId: string | null;
	selectedClipId?: string | null;
	selectedAnnotationId?: string | null;
	selectedAudioId?: string | null;
	selectedCaptionId?: string | null;
}

export function resolveDeleteSelectionTarget({
	selectedGap,
	selectAllBlocksActive,
	selectedKeyframeId,
	selectedZoomId,
	selectedClipId,
	selectedAnnotationId,
	selectedAudioId,
	selectedCaptionId,
}: ResolveDeleteSelectionTargetParams): DeleteSelectionTarget {
	if (selectedGap) return "gap";
	if (selectAllBlocksActive) return "zoom";
	if (selectedKeyframeId) return "keyframe";
	if (selectedZoomId) return "zoom";
	if (selectedClipId) return "clip";
	if (selectedAnnotationId) return "annotation";
	if (selectedAudioId) return "audio";
	if (selectedCaptionId) return "caption";
	return "none";
}

export function isTimelineShortcutTargetBlocked(target: Element | null): boolean {
	return Boolean(
		target?.closest(
			'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="alertdialog"]',
		),
	);
}
