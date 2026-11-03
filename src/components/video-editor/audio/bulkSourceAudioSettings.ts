import type { SourceAudioTrackSettings } from "./audioTypes";

export function patchSelectedSourceAudioTracks(
	byClip: Record<string, SourceAudioTrackSettings>,
	defaults: SourceAudioTrackSettings,
	ids: readonly string[],
	trackId: string,
	patch: Partial<{ volume: number; normalize: boolean }>,
): Record<string, SourceAudioTrackSettings> {
	const next = { ...byClip };
	for (const id of new Set(ids)) {
		const effective = byClip[id]?.[trackId] ??
			defaults[trackId] ?? { volume: 1, normalize: false };
		const volume =
			patch.volume === undefined || !Number.isFinite(patch.volume)
				? effective.volume
				: Math.max(0, Math.min(1, patch.volume));
		next[id] = {
			...byClip[id],
			[trackId]: { volume, normalize: patch.normalize ?? effective.normalize },
		};
	}
	return next;
}

export function summarizeSourceAudioTracks(
	byClip: Record<string, SourceAudioTrackSettings>,
	defaults: SourceAudioTrackSettings,
	ids: readonly string[],
): Record<string, { volume: boolean; normalize: boolean }> {
	const tracks = new Set([
		...Object.keys(defaults),
		...ids.flatMap((id) => Object.keys(byClip[id] ?? {})),
	]);
	return Object.fromEntries(
		[...tracks].map((track) => {
			const values = ids.map(
				(id) => byClip[id]?.[track] ?? defaults[track] ?? { volume: 1, normalize: false },
			);
			return [
				track,
				{
					volume: values.some((value) => value.volume !== values[0]?.volume),
					normalize: values.some((value) => value.normalize !== values[0]?.normalize),
				},
			];
		}),
	);
}
