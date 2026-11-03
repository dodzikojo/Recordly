type PreviewVideo = Pick<
	HTMLVideoElement,
	"seeking" | "readyState" | "addEventListener" | "removeEventListener"
>;

export function watchPreviewPlaybackReadiness(
	video: PreviewVideo,
	onReady: (ready: boolean) => void,
	pauseAudio: () => void,
) {
	let waitingTimer: ReturnType<typeof setTimeout> | undefined;
	const clearWaiting = () => {
		clearTimeout(waitingTimer);
		waitingTimer = undefined;
	};
	const suspend = () => {
		clearWaiting();
		pauseAudio();
		onReady(false);
	};
	// At high rates readyState can already be HAVE_CURRENT_DATA when playing fires.
	const resume = () => {
		clearWaiting();
		if (!video.seeking) onReady(true);
	};
	// Brief decoder waits should not repeatedly stop an independent audio stream.
	const wait = () => {
		clearWaiting();
		waitingTimer = setTimeout(suspend, 200);
	};
	// Removed video gaps seek automatically; short seeks must not interrupt narration.
	video.addEventListener("seeking", wait);
	video.addEventListener("waiting", wait);
	video.addEventListener("playing", resume);
	video.addEventListener("seeked", resume);
	onReady(!video.seeking && video.readyState >= 2);
	return () => {
		clearWaiting();
		video.removeEventListener("seeking", wait);
		video.removeEventListener("waiting", wait);
		video.removeEventListener("playing", resume);
		video.removeEventListener("seeked", resume);
	};
}
