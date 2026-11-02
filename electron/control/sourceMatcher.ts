import type { CaptureSourceSummary } from "./types";

export type SourceMatchResult =
	| { ok: true; source: CaptureSourceSummary }
	| { ok: false; error: string; candidates: CaptureSourceSummary[] };

/**
 * Resolve a selector to exactly one source. Ambiguity is a failure, never a guess:
 * recording the wrong window is worse than refusing to start.
 */
export function matchSource(sources: CaptureSourceSummary[], selector: unknown): SourceMatchResult {
	const screens = sources.filter((source) => source.kind === "screen");
	const windows = sources.filter((source) => source.kind === "window");

	if (typeof selector !== "object" || selector === null || Array.isArray(selector)) {
		return {
			ok: false,
			error: "source must be an object: { id } | { display } | { windowTitle }",
			candidates: sources,
		};
	}
	const record = selector as Record<string, unknown>;

	if ("id" in record) {
		if (typeof record.id !== "string" || record.id === "") {
			return {
				ok: false,
				error: "source.id must be a non-empty string",
				candidates: sources,
			};
		}
		const match = sources.find((source) => source.id === record.id);
		return match
			? { ok: true, source: match }
			: { ok: false, error: `No source with id "${record.id}"`, candidates: sources };
	}

	if ("display" in record) {
		const display = record.display;
		if (typeof display !== "number" || !Number.isInteger(display) || display < 0) {
			return {
				ok: false,
				error: "source.display must be a non-negative integer (0-based screen index)",
				candidates: screens,
			};
		}
		const match = screens[display];
		return match
			? { ok: true, source: match }
			: {
					ok: false,
					error: `No screen at index ${display} (${screens.length} available)`,
					candidates: screens,
				};
	}

	if ("windowTitle" in record) {
		const title = record.windowTitle;
		if (typeof title !== "string" || title.trim() === "") {
			return {
				ok: false,
				error: "source.windowTitle must be a non-empty string",
				candidates: windows,
			};
		}
		const needle = title.trim().toLowerCase();
		const matches = windows.filter((source) => source.name.toLowerCase().includes(needle));
		if (matches.length === 1) {
			return { ok: true, source: matches[0] };
		}
		if (matches.length === 0) {
			return {
				ok: false,
				error: `No window title contains "${title}"`,
				candidates: windows,
			};
		}
		return {
			ok: false,
			error: `Ambiguous window title "${title}": multiple windows match; use a more specific title or an id`,
			candidates: matches,
		};
	}

	return {
		ok: false,
		error: "source must contain one of: id, display, windowTitle",
		candidates: sources,
	};
}
