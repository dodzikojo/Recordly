import { trimsToClips, type ClipRegion, type TrimRegion } from "./types";

/** A full-source trim is an existing, version-compatible representation of an empty edit. */
export function isEmptyClipEdit(
	clips: ClipRegion[],
	trims: TrimRegion[],
	durationMs: number,
): boolean {
	return (
		durationMs > 0 &&
		clips.length === 0 &&
		trims.length > 0 &&
		trimsToClips(trims, durationMs).length === 0
	);
}
