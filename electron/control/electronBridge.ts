import { randomUUID } from "node:crypto";
import { type BrowserWindow, ipcMain, type IpcMainEvent, type WebContents } from "electron";
import { ingestAgentCursorEvents } from "../ipc/cursor/agentCursor";
import { applySelectedSource, listCaptureSources } from "../ipc/register/sources";
import { setAgentCursorTakeActive } from "../ipc/state";
import type { SelectedSource } from "../ipc/types";
import {
	type ControlSaveTakeRequest,
	controlEvents,
	type HudControlAction,
	type RecordingControlRequest,
	type SaveTakeResult,
} from "./controlEvents";
import {
	type ControlledEditor,
	type ControllerDeps,
	DEFAULT_CONTROLLER_TIMEOUTS,
} from "./recordingController";
import type { CaptureSourceSummary } from "./types";

/** What main.ts lends the bridge; it owns the windows and the unsaved-changes flag. */
export interface ControlMainHooks {
	getHudWindow(): BrowserWindow | null;
	/** Creates the HUD if missing, shows it and makes it mainWindow. */
	ensureHud(): Promise<void>;
	getEditorWindow(): BrowserWindow | null;
	editorHasUnsavedChanges(): boolean;
	/** Must close without the unsaved-changes dialog. */
	closeEditorWithoutPrompt(window: BrowserWindow): void;
}

/** A fresh HUD loads its page and React tree before it can take control requests. */
const HUD_READY_TIMEOUT_MS = 20_000;
/** Drops a pending HUD request nobody answered; the controller's own timeouts are shorter. */
const HUD_REPLY_CLEANUP_MS = 120_000;

type HudReply = { ok: boolean; error?: string };
type SaveOutcome = { ok: boolean; projectPath?: string; error?: string };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function toSummary(source: SelectedSource): CaptureSourceSummary {
	const id = typeof source.id === "string" ? source.id : "";
	const kind: CaptureSourceSummary["kind"] =
		source.sourceType === "window" || (!source.sourceType && id.startsWith("window:"))
			? "window"
			: "screen";
	const displayId =
		typeof source.display_id === "string" && source.display_id !== ""
			? source.display_id
			: undefined;
	return { id, name: source.name, kind, ...(displayId ? { displayId } : {}) };
}

/** Real Electron implementations of the controller's dependencies. */
export function createElectronControllerDeps(main: ControlMainHooks): ControllerDeps {
	const saveMs = DEFAULT_CONTROLLER_TIMEOUTS.saveMs;
	let sourcesById = new Map<string, SelectedSource>();

	// The HUD's preload announces `recording-control-ready` when its recorder subscribes, so a
	// request is never sent into a page that is still loading.
	const readyContentsIds = new Set<number>();
	const readyWaiters = new Set<() => void>();
	ipcMain.on("recording-control-ready", (event: IpcMainEvent) => {
		const contents = event.sender;
		const id = contents.id;
		if (!readyContentsIds.has(id)) {
			readyContentsIds.add(id);
			contents.once("destroyed", () => readyContentsIds.delete(id));
		}
		for (const notify of [...readyWaiters]) {
			notify();
		}
	});

	function waitForHudReady(contents: WebContents, ms: number): Promise<boolean> {
		if (contents.isDestroyed()) {
			return Promise.resolve(false);
		}
		const id = contents.id;
		if (readyContentsIds.has(id)) {
			return Promise.resolve(true);
		}
		return new Promise((resolve) => {
			const onDestroyed = () => finish(false);
			const finish = (ready: boolean) => {
				clearTimeout(timer);
				readyWaiters.delete(check);
				if (!contents.isDestroyed()) {
					contents.removeListener("destroyed", onDestroyed);
				}
				resolve(ready);
			};
			const check = () => {
				if (readyContentsIds.has(id)) {
					finish(true);
				}
			};
			const timer = setTimeout(() => finish(false), ms);
			readyWaiters.add(check);
			contents.once("destroyed", onDestroyed);
		});
	}

	const pendingReplies = new Map<
		string,
		{ contentsId: number; finish: (reply: HudReply) => void }
	>();
	ipcMain.on("recording-control-reply", (event: IpcMainEvent, raw: unknown) => {
		if (typeof raw !== "object" || raw === null) {
			return;
		}
		const reply = raw as Record<string, unknown>;
		const pending =
			typeof reply.requestId === "string" ? pendingReplies.get(reply.requestId) : undefined;
		if (!pending || pending.contentsId !== event.sender.id) {
			return;
		}
		pending.finish({
			ok: reply.ok === true,
			...(typeof reply.error === "string" ? { error: reply.error } : {}),
		});
	});

	async function sendToHud(
		action: HudControlAction,
		options?: { countdownSeconds?: number },
	): Promise<HudReply> {
		const hud = main.getHudWindow();
		if (!hud || hud.isDestroyed()) {
			return { ok: false, error: "The recording HUD is not open" };
		}
		const contents = hud.webContents;
		if (!(await waitForHudReady(contents, HUD_READY_TIMEOUT_MS))) {
			return { ok: false, error: "The recording HUD is not ready for control requests" };
		}
		const requestId = randomUUID();
		const contentsId = contents.id;
		return new Promise<HudReply>((resolve) => {
			const onGone = () => finish({ ok: false, error: "The recording HUD closed" });
			const timer = setTimeout(
				() => finish({ ok: false, error: "The recording HUD did not reply" }),
				HUD_REPLY_CLEANUP_MS,
			);
			const finish = (reply: HudReply) => {
				clearTimeout(timer);
				pendingReplies.delete(requestId);
				if (!contents.isDestroyed()) {
					contents.removeListener("destroyed", onGone);
				}
				resolve(reply);
			};
			pendingReplies.set(requestId, { contentsId, finish });
			contents.once("destroyed", onGone);
			const request: RecordingControlRequest = {
				requestId,
				action,
				...(options ? { options } : {}),
			};
			try {
				contents.send("recording-control", request);
			} catch (error) {
				finish({ ok: false, error: errorMessage(error) });
			}
		});
	}

	/** Asks the editor to save without prompting; resolves on its `save-take-result`. */
	function requestEditorSave(
		window: BrowserWindow,
		projectName: string | null,
	): Promise<SaveOutcome> {
		if (window.isDestroyed()) {
			return Promise.resolve({ ok: false, error: "The editor window is closed" });
		}
		const requestId = randomUUID();
		return new Promise<SaveOutcome>((resolve) => {
			const onResult = (result: SaveTakeResult) => {
				if (result?.requestId !== requestId) {
					return;
				}
				finish({
					ok: result.ok === true,
					...(typeof result.projectPath === "string"
						? { projectPath: result.projectPath }
						: {}),
					...(typeof result.error === "string" ? { error: result.error } : {}),
				});
			};
			const onClosed = () =>
				finish({ ok: false, error: "The editor closed before saving the take" });
			const timer = setTimeout(
				() =>
					finish({
						ok: false,
						error: `The editor did not save the take within ${saveMs / 1000}s`,
					}),
				saveMs,
			);
			const finish = (outcome: SaveOutcome) => {
				clearTimeout(timer);
				controlEvents.off("save-take-result", onResult);
				if (!window.isDestroyed()) {
					window.removeListener("closed", onClosed);
				}
				resolve(outcome);
			};
			controlEvents.on("save-take-result", onResult);
			window.once("closed", onClosed);
			const request: ControlSaveTakeRequest = { requestId, projectName };
			try {
				window.webContents.send("control-save-take", request);
			} catch (error) {
				finish({ ok: false, error: errorMessage(error) });
			}
		});
	}

	function controlledEditor(window: BrowserWindow): ControlledEditor {
		return {
			hasUnsavedChanges: () => main.editorHasUnsavedChanges(),
			// projectName null: save in place, or under the video's name. Never the save dialog
			// that request-save-before-close can open for a never-saved take.
			save: async () => (await requestEditorSave(window, null)).ok,
			close: () =>
				new Promise<void>((resolve) => {
					if (window.isDestroyed()) {
						resolve();
						return;
					}
					window.once("closed", () => resolve());
					main.closeEditorWithoutPrompt(window);
				}),
		};
	}

	return {
		async listSources() {
			const sources = await listCaptureSources({
				forceRefresh: true,
				// 0×0 tells desktopCapturer to skip thumbnail capture entirely.
				thumbnailSize: { width: 0, height: 0 },
				fetchWindowIcons: false,
			});
			sourcesById = new Map(
				sources.flatMap((source) =>
					typeof source.id === "string" ? [[source.id, source] as const] : [],
				),
			);
			return sources.map(toSummary);
		},

		selectSource(summary) {
			// The full source (display_id, sourceType, …) as listCaptureSources returned it, the
			// same object the HUD's own source picker would pass to select-source.
			const selected: SelectedSource = sourcesById.get(summary.id) ?? {
				id: summary.id,
				name: summary.name,
				sourceType: summary.kind,
				...(summary.displayId ? { display_id: summary.displayId } : {}),
			};
			applySelectedSource(selected);
		},

		sendToHud,

		async ensureHud() {
			await main.ensureHud();
			const hud = main.getHudWindow();
			if (!hud || hud.isDestroyed()) {
				throw new Error("the HUD window could not be created");
			}
			if (!(await waitForHudReady(hud.webContents, HUD_READY_TIMEOUT_MS))) {
				throw new Error(
					`the HUD did not finish loading within ${HUD_READY_TIMEOUT_MS / 1000}s`,
				);
			}
		},

		getEditor() {
			const window = main.getEditorWindow();
			return window && !window.isDestroyed() ? controlledEditor(window) : null;
		},

		async saveTake(projectName) {
			const window = main.getEditorWindow();
			if (!window || window.isDestroyed()) {
				return { ok: false, error: "No editor window is open" };
			}
			return requestEditorSave(window, projectName);
		},

		setAgentCursorTakeActive,
		ingestCursorEvents: ingestAgentCursorEvents,
		events: controlEvents,
		now: () => Date.now(),
	};
}
