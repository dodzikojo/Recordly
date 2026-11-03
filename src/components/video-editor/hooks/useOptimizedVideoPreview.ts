import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { resolveMediaResourceUrl } from "@/lib/exporter/localMediaSource";

interface PreviewCopy {
	sourcePath: string;
	videoUrl: string;
	dimensions: { width: number; height: number };
}

/** Preview copies never replace the project/export source, and activate only while paused. */
export function useOptimizedVideoPreview(
	sourcePath: string | null,
	playbackRate: number,
	busy: boolean,
) {
	const [prepared, setPrepared] = useState<PreviewCopy | null>(null);
	const [active, setActive] = useState<PreviewCopy | null>(null);
	const busyRef = useRef(busy);
	busyRef.current = busy;
	const needsCopy = playbackRate > 2;
	const onError = useCallback(() => {
		setActive(null);
		setPrepared(null);
		toast.warning("Optimized playback was unavailable. Using the original recording.");
	}, []);

	useEffect(() => {
		if (!sourcePath || !needsCopy) return;
		let cancelled = false;
		const id = "optimized-video-preview";
		toast.loading("Preparing smoother playback…", { id });
		void (async () => {
			try {
				const result = await window.electronAPI.prepareVideoPreview(sourcePath);
				if (cancelled) return;
				if (!result.success || !result.path || !result.width || !result.height)
					throw new Error("Preview unavailable");
				const videoUrl = await resolveMediaResourceUrl(result.path);
				if (cancelled) return;
				setPrepared({
					sourcePath,
					videoUrl,
					dimensions: { width: result.width, height: result.height },
				});
				if (result.path !== sourcePath && busyRef.current) {
					toast.success("Smoother playback is ready. Pause playback to activate it.", {
						id,
					});
				} else {
					toast.dismiss(id);
				}
			} catch {
				if (!cancelled)
					toast.warning("Could not optimize playback. Using the original recording.", {
						id,
					});
			}
		})();
		return () => {
			cancelled = true;
			toast.dismiss(id);
		};
	}, [sourcePath, needsCopy]);

	useEffect(() => {
		if (!busy && prepared?.sourcePath === sourcePath) setActive(prepared);
	}, [busy, prepared, sourcePath]);

	return {
		videoUrl: active?.sourcePath === sourcePath ? active?.videoUrl : null,
		sourceDimensions: prepared?.sourcePath === sourcePath ? prepared?.dimensions : null,
		onError,
	};
}
