import { EventEmitter } from "node:events";

/** What main can ask the HUD recorder to do over the `recording-control` IPC channel. */
export type HudControlAction = "start" | "stop" | "pause" | "resume" | "cancel";

/** main → HUD `recording-control`. */
export interface RecordingControlRequest {
	requestId: string;
	action: HudControlAction;
	options?: { countdownSeconds?: number };
}

/** HUD → main `recording-control-reply`. */
export interface RecordingControlReply {
	requestId: string;
	ok: boolean;
	error?: string;
}

/**
 * main → editor `control-save-take`. A string saves under that project name; null saves in place
 * when the editor has a project path, otherwise under the loaded video's base name. Never prompts.
 */
export interface ControlSaveTakeRequest {
	requestId: string;
	projectName: string | null;
}

/** The editor's answer to `control-save-take`, forwarded onto `controlEvents`. */
export interface SaveTakeResult {
	requestId: string;
	ok: boolean;
	projectPath?: string;
	error?: string;
}

export interface ControlEventMap {
	/** Emitted at the end of every `set-recording-state` call, for human and controlled takes. */
	"recording-state": [recording: boolean];
	/** The editor has loaded a fresh take and applied its auto-zooms. */
	"fresh-take-settled": [videoPath: string];
	"save-take-result": [result: SaveTakeResult];
}

export type ControlEvents = EventEmitter<ControlEventMap>;

/** Main-process bus between the recording IPC handlers, the editor bridge and the controller. */
export const controlEvents: ControlEvents = new EventEmitter<ControlEventMap>();
