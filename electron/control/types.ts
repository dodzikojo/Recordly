import type { AgentCursorIngestResult } from "../ipc/cursor/agentCursor";

/** display = 0-based index among screens. */
export type SourceSelector = { id: string } | { display: number } | { windowTitle: string };

export interface CaptureSourceSummary {
	id: string;
	name: string;
	kind: "screen" | "window";
	displayId?: string;
}

export interface StartOptions {
	source: SourceSelector;
	agentCursor?: boolean;
	/** Defaults to 0. */
	countdownSeconds?: number;
}

export interface StartResult {
	source: CaptureSourceSummary;
	agentCursor: boolean;
	startedAtMs: number;
}

export interface StopResult {
	videoPath: string | null;
	projectPath: string | null;
	saveError?: string;
}

export interface ControllerStatus {
	recording: boolean;
	paused: boolean;
	agentCursor: boolean;
	source: CaptureSourceSummary | null;
	lastTake: StopResult | null;
}

export type ControlErrorCode = "bad_request" | "conflict" | "not_found" | "timeout" | "internal";

export class ControlError extends Error {
	constructor(
		readonly code: ControlErrorCode,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "ControlError";
	}
}

export interface RecordingController {
	status(): ControllerStatus;
	listSources(): Promise<CaptureSourceSummary[]>;
	start(options: StartOptions): Promise<StartResult>;
	pause(): Promise<void>;
	resume(): Promise<void>;
	stop(): Promise<StopResult>;
	cancel(): Promise<void>;
	sendCursorEvents(raw: unknown): AgentCursorIngestResult;
}
