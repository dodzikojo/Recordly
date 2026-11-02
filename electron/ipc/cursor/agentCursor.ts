import {
	agentCursorTakeActive,
	isCursorCaptureActive,
	lastAgentCursorEventAtMs,
	setLastAgentCursorEventAtMs,
} from "../state";
import type { CursorVisualType } from "../types";
import { recordCursorDownAt, recordCursorUpAt } from "./interaction";
import {
	getCursorCaptureElapsedMs,
	isCursorCapturePaused,
	normalizeScreenPointToCapture,
	pushCursorSample,
} from "./telemetry";

export interface AgentCursorEventInput {
	atMs: number;
	x: number;
	y: number;
	kind: "move" | "down" | "up";
	button?: "left" | "right" | "middle";
	cursor?: string;
}

export interface AgentCursorIngestResult {
	accepted: number;
	rejected: Array<{ index: number; reason: string }>;
}

/** Thrown when events arrive while no agent-driven take is capturing. */
export class AgentCursorInactiveError extends Error {
	constructor(message = "No agent-driven take is currently capturing cursor events") {
		super(message);
		this.name = "AgentCursorInactiveError";
	}
}

export const MAX_AGENT_CURSOR_BATCH = 1000;

const CSS_CURSOR_TO_VISUAL_TYPE = new Map<string, CursorVisualType>([
	["pointer", "pointer"],
	["text", "text"],
	["grab", "open-hand"],
	["grabbing", "closed-hand"],
	["ew-resize", "resize-ew"],
	["col-resize", "resize-ew"],
	["ns-resize", "resize-ns"],
	["row-resize", "resize-ns"],
	["not-allowed", "not-allowed"],
	["crosshair", "crosshair"],
]);

export function mapCssCursorToVisualType(css: string | undefined): CursorVisualType {
	if (typeof css !== "string") {
		return "arrow";
	}

	return CSS_CURSOR_TO_VISUAL_TYPE.get(css) ?? "arrow";
}

const BUTTON_TO_HOOK_BUTTON = { left: 1, right: 2, middle: 3 } as const;

type ParsedEvent = { ok: true; event: AgentCursorEventInput } | { ok: false; reason: string };

function parseAgentCursorEvent(raw: unknown): ParsedEvent {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, reason: "event must be an object" };
	}

	const candidate = raw as Record<string, unknown>;
	if (typeof candidate.atMs !== "number" || !Number.isFinite(candidate.atMs)) {
		return { ok: false, reason: "atMs must be a finite number" };
	}
	if (typeof candidate.x !== "number" || !Number.isFinite(candidate.x)) {
		return { ok: false, reason: "x must be a finite number" };
	}
	if (typeof candidate.y !== "number" || !Number.isFinite(candidate.y)) {
		return { ok: false, reason: "y must be a finite number" };
	}
	if (candidate.kind !== "move" && candidate.kind !== "down" && candidate.kind !== "up") {
		return { ok: false, reason: 'kind must be "move", "down" or "up"' };
	}
	if (
		candidate.button !== undefined &&
		candidate.button !== "left" &&
		candidate.button !== "right" &&
		candidate.button !== "middle"
	) {
		return { ok: false, reason: 'button must be "left", "right" or "middle"' };
	}
	if (candidate.cursor !== undefined && typeof candidate.cursor !== "string") {
		return { ok: false, reason: "cursor must be a string" };
	}

	return {
		ok: true,
		event: {
			atMs: candidate.atMs,
			x: candidate.x,
			y: candidate.y,
			kind: candidate.kind,
			button: candidate.button,
			cursor: candidate.cursor,
		},
	};
}

function rejectAll(count: number, reason: string): AgentCursorIngestResult {
	return {
		accepted: 0,
		rejected: Array.from({ length: Math.max(1, count) }, (_, index) => ({ index, reason })),
	};
}

/**
 * Records injected cursor events (screen coordinates, page-stamped `atMs` on the
 * main-process wall clock) into the active cursor telemetry. Malformed events are
 * rejected individually; only the lack of an active agent take throws.
 */
export function ingestAgentCursorEvents(raw: unknown): AgentCursorIngestResult {
	if (!agentCursorTakeActive || !isCursorCaptureActive) {
		throw new AgentCursorInactiveError();
	}

	if (!Array.isArray(raw)) {
		return rejectAll(1, "events must be an array");
	}
	if (raw.length > MAX_AGENT_CURSOR_BATCH) {
		return rejectAll(raw.length, `batch exceeds ${MAX_AGENT_CURSOR_BATCH} events`);
	}

	const result: AgentCursorIngestResult = { accepted: 0, rejected: [] };

	raw.forEach((rawEvent, index) => {
		try {
			const parsed = parseAgentCursorEvent(rawEvent);
			if (!parsed.ok) {
				result.rejected.push({ index, reason: parsed.reason });
				return;
			}
			const event = parsed.event;

			if (isCursorCapturePaused()) {
				result.rejected.push({ index, reason: "paused" });
				return;
			}
			if (lastAgentCursorEventAtMs !== null && event.atMs < lastAgentCursorEventAtMs) {
				result.rejected.push({
					index,
					reason: `out of order: atMs ${event.atMs} is older than the last accepted event (${lastAgentCursorEventAtMs})`,
				});
				return;
			}

			const point = normalizeScreenPointToCapture({ x: event.x, y: event.y });
			const timeMs = getCursorCaptureElapsedMs(event.atMs);
			const cursorType = mapCssCursorToVisualType(event.cursor);

			if (event.kind === "down") {
				recordCursorDownAt(
					point,
					timeMs,
					BUTTON_TO_HOOK_BUTTON[event.button ?? "left"],
					cursorType,
				);
			} else if (event.kind === "up") {
				recordCursorUpAt(point, timeMs, cursorType);
			} else {
				pushCursorSample(point.cx, point.cy, timeMs, "move", cursorType);
			}

			setLastAgentCursorEventAtMs(event.atMs);
			result.accepted += 1;
		} catch (error) {
			result.rejected.push({
				index,
				reason: error instanceof Error ? error.message : "failed to record event",
			});
		}
	});

	return result;
}
