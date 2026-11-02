import { type MutableRefObject, useEffect, useRef } from "react";

/** Give up waiting for fresh-recording auto-zooms this long after the preview becomes ready. */
export const FRESH_TAKE_SETTLE_FALLBACK_MS = 8000;
/** Announce only after `zoomRegions` has been quiet this long, so every suggested zoom is in state. */
export const FRESH_TAKE_ZOOM_QUIET_MS = 750;
/** The pending-auto-zoom ref changes without a render, so the hook re-checks on this tick. */
const SETTLE_POLL_INTERVAL_MS = 100;

export interface FreshTakeSettledInput {
	videoPath: string | null;
	isPreviewReady: boolean;
	pendingAutoZoomPath: string | null;
	msSincePreviewReady: number;
}

/**
 * True once the editor can be saved without losing the fresh take's auto-zooms: the preview is
 * ready and either the pending fresh-recording auto-zoom pass has finished for this video or it
 * has been given long enough (a take with no usable cursor telemetry never clears it).
 */
export function isFreshTakeSettled(input: FreshTakeSettledInput): boolean {
	const { videoPath, isPreviewReady, pendingAutoZoomPath, msSincePreviewReady } = input;
	return Boolean(
		videoPath &&
			isPreviewReady &&
			(pendingAutoZoomPath !== videoPath ||
				msSincePreviewReady >= FRESH_TAKE_SETTLE_FALLBACK_MS),
	);
}

interface UseFreshTakeSettledOptions {
	/** Identity of the loaded media (the editor's video URL); matched against the pending ref. */
	videoPath: string | null;
	isPreviewReady: boolean;
	pendingFreshRecordingAutoZoomPathRef: MutableRefObject<string | null>;
	zoomRegions: unknown;
	/** What main receives; defaults to `videoPath`. The editor passes the file path, not the URL. */
	announcePath?: string | null;
}

/**
 * Tells main, once per loaded video, that a take has settled. Main ignores the message unless a
 * controlled stop is waiting for it, so human-driven recordings are unaffected.
 */
export function useFreshTakeSettled({
	videoPath,
	isPreviewReady,
	pendingFreshRecordingAutoZoomPathRef,
	zoomRegions,
	announcePath,
}: UseFreshTakeSettledOptions): void {
	const announcedVideoPathRef = useRef<string | null>(null);
	const previewReadySinceRef = useRef<{ videoPath: string; at: number } | null>(null);
	const lastZoomChangeAtRef = useRef(0);
	const announcePathRef = useRef(announcePath);
	announcePathRef.current = announcePath;

	// biome-ignore lint/correctness/useExhaustiveDependencies: zoomRegions is the change trigger.
	useEffect(() => {
		lastZoomChangeAtRef.current = Date.now();
	}, [zoomRegions]);

	useEffect(() => {
		if (!videoPath || !isPreviewReady || announcedVideoPathRef.current === videoPath) {
			return;
		}
		if (previewReadySinceRef.current?.videoPath !== videoPath) {
			previewReadySinceRef.current = { videoPath, at: Date.now() };
		}
		const readySince = previewReadySinceRef.current;

		const check = () => {
			const now = Date.now();
			if (
				!isFreshTakeSettled({
					videoPath,
					isPreviewReady,
					pendingAutoZoomPath: pendingFreshRecordingAutoZoomPathRef.current,
					msSincePreviewReady: now - readySince.at,
				})
			) {
				return;
			}
			// Quiet period is measured from the last zoom change, or from readiness if none came.
			const lastChange = Math.max(lastZoomChangeAtRef.current, readySince.at);
			if (now - lastChange < FRESH_TAKE_ZOOM_QUIET_MS) {
				return;
			}
			window.clearInterval(timer);
			announcedVideoPathRef.current = videoPath;
			try {
				window.electronAPI?.notifyFreshTakeSettled?.(announcePathRef.current ?? videoPath);
			} catch {
				// Announcing is best-effort; never disturb the editor.
			}
		};
		const timer = window.setInterval(check, SETTLE_POLL_INTERVAL_MS);
		return () => window.clearInterval(timer);
	}, [videoPath, isPreviewReady, pendingFreshRecordingAutoZoomPathRef]);
}
