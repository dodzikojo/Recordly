import { mapTimelineTimeToEditedTime, type AudioRegion, type ClipRegion } from "../types";

export interface AudioPreviewClockSample {
	time: number;
	now: number;
	rate: number;
}

/** Source-time advances faster than wall time during sped-up video playback. */
export function hasAudioPreviewTimeJumped(
	previous: AudioPreviewClockSample | null,
	time: number,
	now: number,
): boolean {
	if (!previous) return true;
	const elapsed = Math.max(0, now - previous.now) / 1000;
	const expectedAdvance = elapsed * previous.rate;
	return Math.abs(time - previous.time - expectedAdvance) > Math.max(0.25, previous.rate * 0.15);
}

/** Imported audio starts at its placed edit position, then runs for its own duration. */
export function getUserAudioOutputRegion(region: AudioRegion, clips: ClipRegion[]): AudioRegion {
	const startMs = mapTimelineTimeToEditedTime(region.startMs, clips);
	return { ...region, startMs, endMs: startMs + Math.max(0, region.endMs - region.startMs) };
}
