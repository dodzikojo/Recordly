import { type RefObject, useEffect } from "react";
import { matchesShortcut } from "@/lib/shortcuts";
import type { TimelineGap } from "../../closeGaps";
import type { TimelineShortcutBindings } from "../core/timelineTypes";
import {
	isTimelineShortcutTargetBlocked,
	resolveDeleteSelectionTarget,
} from "./utils/timelineSelectionUtils";

interface UseTimelineKeyboardShortcutsParams {
	isMac: boolean;
	keyShortcuts: TimelineShortcutBindings;
	isTimelineFocusedRef: RefObject<boolean>;
	hasAnyZoomBlocks: boolean;
	activateSelectAllZooms: () => void;
	annotationCount: number;
	selectedKeyframeId: string | null;
	selectedZoomId: string | null;
	selectedClipId?: string | null;
	selectedGap?: TimelineGap | null;
	closeSelectedGap: () => void;
	clearSelectedGap: () => void;
	clearSelectedBlocks?: () => void;
	activateSelectAllClips?: () => void;
	selectedAnnotationId?: string | null;
	selectedAudioId?: string | null;
	selectedCaptionId?: string | null;
	selectAllBlocksActive: boolean;
	addKeyframe: () => void;
	handleAddZoom: () => void;
	handleSplitClip: () => void;
	handleAddAnnotation: () => void;
	deleteSelectedKeyframe: () => void;
	deleteSelectedZoom: () => void;
	deleteSelectedClip: () => void;
	deleteSelectedAnnotation: () => void;
	deleteSelectedAudio: () => void;
	deleteSelectedCaption: () => void;
	cycleAnnotationsAtCurrentTime: (backward?: boolean) => boolean;
}

export function useTimelineKeyboardShortcuts({
	isMac,
	keyShortcuts,
	isTimelineFocusedRef,
	hasAnyZoomBlocks,
	activateSelectAllZooms,
	annotationCount,
	selectedKeyframeId,
	selectedZoomId,
	selectedClipId,
	selectedGap,
	closeSelectedGap,
	clearSelectedGap,
	clearSelectedBlocks,
	activateSelectAllClips,
	selectedAnnotationId,
	selectedAudioId,
	selectedCaptionId,
	selectAllBlocksActive,
	addKeyframe,
	handleAddZoom,
	handleSplitClip,
	handleAddAnnotation,
	deleteSelectedKeyframe,
	deleteSelectedZoom,
	deleteSelectedClip,
	deleteSelectedAnnotation,
	deleteSelectedAudio,
	deleteSelectedCaption,
	cycleAnnotationsAtCurrentTime,
}: UseTimelineKeyboardShortcutsParams) {
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.defaultPrevented || e.isComposing || e.repeat) return;
			const eventTarget = e.target;
			if (
				isTimelineShortcutTargetBlocked(
					eventTarget instanceof Element ? eventTarget : null,
				) ||
				document.querySelector('[role="dialog"], [role="alertdialog"]')
			) {
				return;
			}
			if (e.key === "Escape" && selectedGap) {
				clearSelectedGap();
				return;
			}
			if (e.key === "Escape") {
				clearSelectedBlocks?.();
				return;
			}

			const isDeleteShortcut =
				e.key === "Delete" ||
				e.key === "Backspace" ||
				matchesShortcut(e, keyShortcuts.deleteSelected, isMac);

			// Selection survives moving focus to the settings panel.
			if (!isTimelineFocusedRef.current && !isDeleteShortcut) {
				return;
			}

			if (matchesShortcut(e, { key: "a", ctrl: true }, isMac)) {
				if (selectedClipId && activateSelectAllClips) {
					e.preventDefault();
					activateSelectAllClips();
					return;
				}
				if (!hasAnyZoomBlocks) {
					return;
				}
				e.preventDefault();
				activateSelectAllZooms();
				return;
			}

			if (matchesShortcut(e, keyShortcuts.addKeyframe, isMac)) addKeyframe();
			if (matchesShortcut(e, keyShortcuts.addZoom, isMac)) handleAddZoom();
			if (matchesShortcut(e, keyShortcuts.splitClip, isMac)) handleSplitClip();
			if (matchesShortcut(e, keyShortcuts.addAnnotation, isMac)) {
				handleAddAnnotation();
			}

			if (e.key === "Tab" && annotationCount > 0) {
				if (cycleAnnotationsAtCurrentTime(e.shiftKey)) {
					e.preventDefault();
				}
			}

			if (isDeleteShortcut) {
				const target = resolveDeleteSelectionTarget({
					selectedGap,
					selectAllBlocksActive,
					selectedKeyframeId,
					selectedZoomId,
					selectedClipId,
					selectedAnnotationId,
					selectedAudioId,
					selectedCaptionId,
				});
				if (target !== "none") {
					e.preventDefault();
				}
				if (target === "gap") {
					closeSelectedGap();
				} else if (target === "keyframe") {
					deleteSelectedKeyframe();
				} else if (target === "zoom") {
					deleteSelectedZoom();
				} else if (target === "clip") {
					deleteSelectedClip();
				} else if (target === "annotation") {
					deleteSelectedAnnotation();
				} else if (target === "audio") {
					deleteSelectedAudio();
				} else if (target === "caption") {
					deleteSelectedCaption();
				}
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [
		activateSelectAllZooms,
		addKeyframe,
		annotationCount,
		cycleAnnotationsAtCurrentTime,
		deleteSelectedAnnotation,
		deleteSelectedAudio,
		deleteSelectedCaption,
		deleteSelectedClip,
		deleteSelectedKeyframe,
		deleteSelectedZoom,
		handleAddAnnotation,
		handleAddZoom,
		handleSplitClip,
		hasAnyZoomBlocks,
		isMac,
		isTimelineFocusedRef,
		keyShortcuts,
		selectAllBlocksActive,
		selectedAnnotationId,
		selectedAudioId,
		selectedCaptionId,
		selectedClipId,
		selectedGap,
		closeSelectedGap,
		clearSelectedGap,
		clearSelectedBlocks,
		activateSelectAllClips,
		selectedKeyframeId,
		selectedZoomId,
	]);
}
