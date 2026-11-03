import type { Span } from "dnd-timeline";

export function spansOverlap(left: Span, right: Span) {
	return left.end > right.start && left.start < right.end;
}

export function normalizeRegionSpan(params: {
	startMs: number;
	endMs: number;
	totalMs: number;
	minDurationMs: number;
}) {
	const { startMs, endMs, totalMs, minDurationMs } = params;
	const safeTotalMs = Math.max(0, totalMs);
	const safeMinDurationMs = Math.max(0, Math.min(minDurationMs, safeTotalMs));
	const clampedStart = Math.max(0, Math.min(startMs, safeTotalMs));
	const normalizedStart = Math.max(0, Math.min(clampedStart, safeTotalMs - safeMinDurationMs));
	const normalizedEnd = Math.min(
		safeTotalMs,
		Math.max(endMs, normalizedStart + safeMinDurationMs),
	);

	return { start: normalizedStart, end: normalizedEnd };
}

/** Passive repair must not expand a short authored zoom or truncate narration. */
export function normalizeExistingRegionSpan(
	params: Parameters<typeof normalizeRegionSpan>[0],
	preserveMediaDuration = false,
) {
	const durationMs = params.endMs - params.startMs;
	const hasValidDuration = Number.isFinite(durationMs) && durationMs > 0;
	if (preserveMediaDuration && hasValidDuration) {
		const start = Math.max(0, params.startMs);
		return { start, end: start + durationMs };
	}
	return normalizeRegionSpan({
		...params,
		startMs: Number.isFinite(params.startMs) ? params.startMs : 0,
		endMs: Number.isFinite(params.endMs) ? params.endMs : 0,
		minDurationMs: hasValidDuration
			? Math.min(params.minDurationMs, durationMs)
			: params.minDurationMs,
	});
}
