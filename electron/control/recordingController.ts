import type { AgentCursorIngestResult } from "../ipc/cursor/agentCursor";
import type { ControlEvents, HudControlAction } from "./controlEvents";
import { matchSource } from "./sourceMatcher";
import {
	type CaptureSourceSummary,
	ControlError,
	type ControllerStatus,
	type RecordingController,
	type StartOptions,
	type StartResult,
	type StopResult,
} from "./types";

export interface ControllerTimeouts {
	/** HUD acknowledgement of stop/pause/resume/cancel, and the editor closing. */
	hudReplyMs: number;
	/** From asking the HUD to start until capture is live, plus the countdown. */
	startMs: number;
	/** From asking the HUD to stop/cancel until main sees recording-state false. */
	stopStateMs: number;
	/** From the end of capture until the editor has loaded the take and its auto-zooms. */
	settleMs: number;
	/** One editor save. */
	saveMs: number;
}

export const DEFAULT_CONTROLLER_TIMEOUTS: ControllerTimeouts = {
	hudReplyMs: 10_000,
	startMs: 30_000,
	stopStateMs: 60_000,
	settleMs: 180_000,
	saveMs: 30_000,
};

export const MAX_COUNTDOWN_SECONDS = 10;
export const SETTLE_TIMEOUT_ERROR = "Editor did not finish loading the take";

export interface ControlledEditor {
	hasUnsavedChanges(): boolean;
	/** Saves without any dialog; resolves false when the save failed. */
	save(): Promise<boolean>;
	/** Closes the editor without the unsaved-changes prompt; resolves once it is closed. */
	close(): Promise<void>;
}

export interface ControllerDeps {
	listSources(): Promise<CaptureSourceSummary[]>;
	selectSource(source: CaptureSourceSummary): void;
	sendToHud(
		action: HudControlAction,
		options?: { countdownSeconds?: number },
	): Promise<{ ok: boolean; error?: string }>;
	/** Resolves once the HUD exists, is shown, is mainWindow and can take control requests. */
	ensureHud(): Promise<void>;
	getEditor(): ControlledEditor | null;
	saveTake(projectName: string): Promise<{ ok: boolean; projectPath?: string; error?: string }>;
	setAgentCursorTakeActive(active: boolean): void;
	ingestCursorEvents(raw: unknown): AgentCursorIngestResult;
	events: ControlEvents;
	now(): number;
	timeouts?: ControllerTimeouts;
}

const TIMED_OUT = Symbol("timed out");

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatSeconds(ms: number): string {
	return `${Math.round(ms / 1000)}s`;
}

/** Resolves with the promise's value, or TIMED_OUT once `ms` passes. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => resolve(TIMED_OUT), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/** "C:\\rec\\recording-1.mp4" → "recording-1". */
function videoBaseName(videoPath: string): string {
	const fileName = videoPath.split(/[\\/]/).pop() || videoPath;
	const dot = fileName.lastIndexOf(".");
	return dot > 0 ? fileName.slice(0, dot) : fileName;
}

function parseStartOptions(options: unknown): {
	source: unknown;
	agentCursor: boolean;
	countdownSeconds: number;
} {
	if (typeof options !== "object" || options === null || Array.isArray(options)) {
		throw new ControlError("bad_request", "Start options must be an object with a source");
	}
	const record = options as Record<string, unknown>;
	if (record.agentCursor !== undefined && typeof record.agentCursor !== "boolean") {
		throw new ControlError("bad_request", "agentCursor must be a boolean");
	}
	const countdown = record.countdownSeconds;
	if (
		countdown !== undefined &&
		(typeof countdown !== "number" ||
			!Number.isInteger(countdown) ||
			countdown < 0 ||
			countdown > MAX_COUNTDOWN_SECONDS)
	) {
		throw new ControlError(
			"bad_request",
			`countdownSeconds must be a whole number from 0 to ${MAX_COUNTDOWN_SECONDS}`,
		);
	}
	return {
		source: record.source,
		agentCursor: record.agentCursor === true,
		countdownSeconds: countdown ?? 0,
	};
}

/**
 * Drives the HUD recorder the way the tray's Stop does: over IPC, resolving on the state main
 * observes in `set-recording-state`. Every failure is a ControlError; nothing here throws past a
 * caller as anything else, and no path can reach the editor's unsaved-changes dialog.
 */
export function createRecordingController(deps: ControllerDeps): RecordingController {
	const timeouts = deps.timeouts ?? DEFAULT_CONTROLLER_TIMEOUTS;
	const { events } = deps;

	let recording = false;
	let paused = false;
	let takeAgentCursor = false;
	let takeSource: CaptureSourceSummary | null = null;
	let lastTake: StopResult | null = null;
	let busy: string | null = null;
	let activeSettleArm: { deliver(videoPath: string): void } | null = null;

	// Registered before any waiter, so `recording` is current when a waiter sees the event.
	events.on("recording-state", (value) => {
		recording = value === true;
		if (!recording) {
			paused = false;
			takeAgentCursor = false;
			takeSource = null;
		}
	});

	// Only a controlled stop arms a settle; a human take's settle is ignored (no auto-save).
	events.on("fresh-take-settled", (videoPath) => {
		if (activeSettleArm && typeof videoPath === "string" && videoPath !== "") {
			activeSettleArm.deliver(videoPath);
		}
	});

	function assertIdle(): void {
		if (busy) {
			throw new ControlError(
				"conflict",
				`Recordly is still handling a ${busy} request; wait for it to finish`,
			);
		}
	}

	function assertRecording(): void {
		if (!recording) {
			throw new ControlError("conflict", "No take is recording");
		}
	}

	/** One mutating request at a time; anything unexpected becomes an internal ControlError. */
	async function exclusive<T>(
		name: string,
		precheck: () => void,
		run: () => Promise<T>,
	): Promise<T> {
		assertIdle();
		precheck();
		busy = name;
		try {
			return await run();
		} catch (error) {
			throw error instanceof ControlError
				? error
				: new ControlError("internal", errorMessage(error));
		} finally {
			busy = null;
		}
	}

	/** Subscribes now; resolves true once the state is `target`, false on timeout or cancel. */
	function waitForRecordingState(
		target: boolean,
		ms: number,
	): { promise: Promise<boolean>; cancel(): void } {
		let finish: (reached: boolean) => void = () => undefined;
		const promise = new Promise<boolean>((resolve) => {
			if (recording === target) {
				resolve(true);
				return;
			}
			const onState = (value: boolean) => {
				if (value === target) {
					finish(true);
				}
			};
			const timer = setTimeout(() => finish(false), ms);
			finish = (reached) => {
				clearTimeout(timer);
				events.off("recording-state", onState);
				resolve(reached);
			};
			events.on("recording-state", onState);
		});
		return { promise, cancel: () => finish(false) };
	}

	/** Captures the first settle after arming, even one that arrives before anyone waits. */
	function armSettle(): { wait(ms: number): Promise<string | null>; disarm(): void } {
		let settledPath: string | null = null;
		let notify: ((videoPath: string) => void) | null = null;
		const arm = {
			deliver(videoPath: string) {
				if (settledPath !== null) {
					return;
				}
				settledPath = videoPath;
				activeSettleArm = null;
				notify?.(videoPath);
			},
		};
		activeSettleArm = arm;
		return {
			wait(ms) {
				if (settledPath !== null) {
					return Promise.resolve(settledPath);
				}
				return new Promise((resolve) => {
					const timer = setTimeout(() => {
						notify = null;
						resolve(null);
					}, ms);
					notify = (videoPath) => {
						clearTimeout(timer);
						notify = null;
						resolve(videoPath);
					};
				});
			},
			disarm() {
				if (activeSettleArm === arm) {
					activeSettleArm = null;
				}
				notify = null;
			},
		};
	}

	/** Sends an action and requires an ok reply within hudReplyMs. */
	async function askHud(action: HudControlAction): Promise<void> {
		let reply: { ok: boolean; error?: string } | typeof TIMED_OUT;
		try {
			reply = await withTimeout(deps.sendToHud(action), timeouts.hudReplyMs);
		} catch (error) {
			throw new ControlError(
				"internal",
				`The HUD could not ${action}: ${errorMessage(error)}`,
			);
		}
		if (reply === TIMED_OUT) {
			throw new ControlError(
				"timeout",
				`The HUD did not answer ${action} within ${formatSeconds(timeouts.hudReplyMs)}`,
			);
		}
		if (!reply.ok) {
			throw new ControlError(
				"internal",
				`The HUD could not ${action}: ${reply.error ?? "unknown error"}`,
			);
		}
	}

	async function bringUpHud(): Promise<void> {
		try {
			await deps.ensureHud();
		} catch (error) {
			if (error instanceof ControlError) {
				throw error;
			}
			throw new ControlError(
				"internal",
				`Couldn't open the recording HUD: ${errorMessage(error)}`,
			);
		}
	}

	/** Spec 2b: save a dirty editor, bring the HUD up, and only then close the editor. */
	async function retireOpenEditor(editor: ControlledEditor): Promise<void> {
		if (editor.hasUnsavedChanges()) {
			const saved = await withTimeout(
				Promise.resolve()
					.then(() => editor.save())
					.catch(() => false),
				timeouts.saveMs,
			);
			if (saved !== true) {
				throw new ControlError(
					"conflict",
					"Couldn't save the open take; nothing was closed",
				);
			}
		}
		await bringUpHud();
		const closed = await withTimeout(
			Promise.resolve()
				.then(() => editor.close())
				.then(
					() => true,
					() => false,
				),
			timeouts.hudReplyMs,
		);
		if (closed !== true) {
			throw new ControlError(
				"internal",
				"The open editor did not close; its take was saved and the HUD is up, so try start again",
			);
		}
	}

	async function runStart(options: StartOptions): Promise<StartResult> {
		const { source, agentCursor, countdownSeconds } = parseStartOptions(options);

		let sources: CaptureSourceSummary[];
		try {
			sources = await deps.listSources();
		} catch (error) {
			throw new ControlError(
				"internal",
				`Couldn't list capture sources: ${errorMessage(error)}`,
			);
		}
		const match = matchSource(sources, source);
		if (!match.ok) {
			throw new ControlError("bad_request", match.error, { candidates: match.candidates });
		}

		const editor = deps.getEditor();
		if (editor) {
			await retireOpenEditor(editor);
		} else {
			await bringUpHud();
		}

		// A person may have started a take from the HUD while we were saving or closing.
		if (recording) {
			throw new ControlError(
				"conflict",
				"A take is already recording; stop or cancel it first",
			);
		}

		try {
			deps.selectSource(match.source);
		} catch (error) {
			throw new ControlError(
				"internal",
				`Couldn't select ${match.source.name}: ${errorMessage(error)}`,
			);
		}
		// set-recording-state(true) reads this flag, so it must be set before the HUD starts.
		deps.setAgentCursorTakeActive(agentCursor);

		const startWaitMs = timeouts.startMs + countdownSeconds * 1000;
		const started = waitForRecordingState(true, startWaitMs);
		const hudFailure: { message: string | null } = { message: null };
		Promise.resolve()
			.then(() => deps.sendToHud("start", { countdownSeconds }))
			.then(
				(reply) => {
					if (!reply.ok) {
						hudFailure.message = reply.error ?? "unknown error";
						started.cancel();
					}
				},
				(error) => {
					hudFailure.message = errorMessage(error);
					started.cancel();
				},
			);

		if (!(await started.promise)) {
			deps.setAgentCursorTakeActive(false);
			if (hudFailure.message !== null) {
				throw new ControlError(
					"internal",
					`The HUD could not start recording: ${hudFailure.message}`,
				);
			}
			// Abort a start still in flight in the HUD so it can't begin after we report failure.
			Promise.resolve()
				.then(() => deps.sendToHud("cancel"))
				.catch(() => undefined);
			throw new ControlError(
				"timeout",
				`Recording did not start within ${formatSeconds(startWaitMs)}`,
			);
		}

		takeAgentCursor = agentCursor;
		takeSource = match.source;
		return { source: match.source, agentCursor, startedAtMs: deps.now() };
	}

	async function saveFreshTake(videoPath: string): Promise<StopResult> {
		try {
			const saved = await withTimeout(
				deps.saveTake(videoBaseName(videoPath)),
				timeouts.saveMs,
			);
			if (saved === TIMED_OUT) {
				return {
					videoPath,
					projectPath: null,
					saveError: `The editor did not save the take within ${formatSeconds(timeouts.saveMs)}`,
				};
			}
			if (!saved.ok) {
				return {
					videoPath,
					projectPath: null,
					saveError: saved.error ?? "The editor could not save the take",
				};
			}
			return { videoPath, projectPath: saved.projectPath ?? null };
		} catch (error) {
			return { videoPath, projectPath: null, saveError: errorMessage(error) };
		}
	}

	async function stopAndWait(action: "stop" | "cancel"): Promise<void> {
		const stopped = waitForRecordingState(false, timeouts.stopStateMs);
		try {
			await askHud(action);
			if (!(await stopped.promise)) {
				throw new ControlError(
					"timeout",
					`Recording did not stop within ${formatSeconds(timeouts.stopStateMs)}`,
				);
			}
		} finally {
			stopped.cancel();
		}
	}

	return {
		status(): ControllerStatus {
			return {
				recording,
				paused,
				agentCursor: takeAgentCursor,
				source: takeSource,
				lastTake: lastTake ? { ...lastTake } : null,
			};
		},

		listSources: () => deps.listSources(),

		start(options) {
			if (recording) {
				return Promise.reject(
					new ControlError(
						"conflict",
						"A take is already recording; stop or cancel it first",
					),
				);
			}
			return exclusive(
				"start",
				() => undefined,
				() => runStart(options),
			);
		},

		stop() {
			return exclusive("stop", assertRecording, async () => {
				const settle = armSettle();
				try {
					await stopAndWait("stop");
					const videoPath = await settle.wait(timeouts.settleMs);
					const result: StopResult =
						videoPath === null
							? {
									videoPath: null,
									projectPath: null,
									saveError: SETTLE_TIMEOUT_ERROR,
								}
							: await saveFreshTake(videoPath);
					lastTake = result;
					return { ...result };
				} finally {
					settle.disarm();
				}
			});
		},

		pause() {
			return exclusive(
				"pause",
				() => {
					assertRecording();
					if (paused) {
						throw new ControlError("conflict", "The take is already paused");
					}
				},
				async () => {
					await askHud("pause");
					paused = true;
				},
			);
		},

		resume() {
			return exclusive(
				"resume",
				() => {
					assertRecording();
					if (!paused) {
						throw new ControlError("conflict", "The take is not paused");
					}
				},
				async () => {
					await askHud("resume");
					paused = false;
				},
			);
		},

		cancel() {
			return exclusive("cancel", assertRecording, () => stopAndWait("cancel"));
		},

		sendCursorEvents: (raw) => deps.ingestCursorEvents(raw),
	};
}
