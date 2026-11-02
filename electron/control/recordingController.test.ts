import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlEventMap, ControlEvents, HudControlAction } from "./controlEvents";
import {
	type ControlledEditor,
	type ControllerDeps,
	createRecordingController,
} from "./recordingController";
import { type CaptureSourceSummary, ControlError } from "./types";

const SCREEN: CaptureSourceSummary = {
	id: "screen:1:0",
	name: "Screen 1 (Primary)",
	kind: "screen",
	displayId: "1",
};
const ORCA: CaptureSourceSummary = { id: "window:100:0", name: "ORCA — Northbank", kind: "window" };
const ORCA_DOCS: CaptureSourceSummary = { id: "window:200:0", name: "ORCA docs", kind: "window" };
const NOTES: CaptureSourceSummary = { id: "window:300:0", name: "Notes", kind: "window" };

const VIDEO_PATH = "C:\\Users\\me\\Recordly\\recording-1730000000000.mp4";
const PROJECT_PATH = "C:\\Users\\me\\Recordly\\Projects\\recording-1730000000000.recordly";

type HudReply = { ok: boolean; error?: string };

/**
 * Fake deps around a real EventEmitter. The fake HUD behaves like the real one: start and stop
 * reach main's set-recording-state (the "recording-state" event) before the HUD's reply.
 */
function setup(
	options: {
		sources?: CaptureSourceSummary[];
		editor?: ControlledEditor | null;
		hud?: (action: HudControlAction, events: ControlEvents) => HudReply | Promise<HudReply>;
	} = {},
) {
	const events: ControlEvents = new EventEmitter<ControlEventMap>();
	const calls: string[] = [];
	let editor = options.editor ?? null;
	const hud =
		options.hud ??
		((action: HudControlAction, emitter: ControlEvents) => {
			if (action === "start") {
				emitter.emit("recording-state", true);
			} else if (action === "stop" || action === "cancel") {
				emitter.emit("recording-state", false);
			}
			return { ok: true };
		});

	const deps = {
		listSources: vi.fn(async () => options.sources ?? [SCREEN, ORCA, NOTES]),
		selectSource: vi.fn((_source: CaptureSourceSummary) => {
			calls.push("selectSource");
		}),
		sendToHud: vi.fn(
			async (action: HudControlAction, _options?: { countdownSeconds?: number }) => {
				calls.push(`sendToHud:${action}`);
				return hud(action, events);
			},
		),
		ensureHud: vi.fn(async () => {
			calls.push("ensureHud");
		}),
		getEditor: vi.fn(() => editor),
		saveTake: vi.fn(async (projectName: string) => {
			calls.push(`saveTake:${projectName}`);
			return { ok: true, projectPath: PROJECT_PATH };
		}),
		setAgentCursorTakeActive: vi.fn((_active: boolean) => undefined),
		ingestCursorEvents: vi.fn((_raw: unknown) => ({ accepted: 2, rejected: [] })),
		events,
		now: () => Date.now(),
	} satisfies ControllerDeps;

	const controller = createRecordingController(deps);
	return {
		controller,
		deps,
		events,
		calls,
		setEditor: (next: ControlledEditor | null) => {
			editor = next;
		},
	};
}

function fakeEditor(calls: string[], opts: { dirty?: boolean; saves?: boolean } = {}) {
	return {
		hasUnsavedChanges: vi.fn(() => opts.dirty ?? false),
		save: vi.fn(async () => {
			calls.push("save");
			return opts.saves ?? true;
		}),
		close: vi.fn(async () => {
			calls.push("close");
		}),
	};
}

/** Captures a rejection without leaving an unhandled promise while timers advance. */
function settleLater<T>(promise: Promise<T>) {
	const outcome: { value?: T; error?: unknown; done: boolean } = { done: false };
	promise.then(
		(value) => {
			outcome.value = value;
			outcome.done = true;
		},
		(error) => {
			outcome.error = error;
			outcome.done = true;
		},
	);
	return outcome;
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("createRecordingController start", () => {
	it("selects the matched source, sets the agent flag, sends countdown 0 and resolves on recording-state true", async () => {
		const { controller, deps, calls } = setup();

		const result = await controller.start({
			source: { windowTitle: "orca" },
			agentCursor: true,
		});

		expect(deps.selectSource).toHaveBeenCalledWith(ORCA);
		expect(deps.setAgentCursorTakeActive).toHaveBeenCalledWith(true);
		expect(deps.sendToHud).toHaveBeenCalledWith("start", { countdownSeconds: 0 });
		expect(calls).toEqual(["ensureHud", "selectSource", "sendToHud:start"]);
		expect(result).toMatchObject({ source: ORCA, agentCursor: true });
		expect(typeof result.startedAtMs).toBe("number");
		expect(controller.status()).toMatchObject({
			recording: true,
			paused: false,
			agentCursor: true,
			source: ORCA,
		});
	});

	it("sets the agent flag before asking the HUD to start", async () => {
		const order: string[] = [];
		const { controller, deps } = setup();
		deps.setAgentCursorTakeActive.mockImplementation((active: boolean) => {
			order.push(`agent:${active}`);
		});
		deps.sendToHud.mockImplementation(async (action: HudControlAction) => {
			order.push(`hud:${action}`);
			deps.events.emit("recording-state", true);
			return { ok: true };
		});

		await controller.start({ source: { display: 0 } });

		expect(order).toEqual(["agent:false", "hud:start"]);
	});

	it("refuses to start while a take is recording, naming stop or cancel", async () => {
		const { controller, deps, events } = setup();
		events.emit("recording-state", true);

		const error = await controller.start({ source: { display: 0 } }).catch((e) => e);

		expect(error).toBeInstanceOf(ControlError);
		expect(error.code).toBe("conflict");
		expect(error.message).toBe("A take is already recording; stop or cancel it first");
		expect(deps.sendToHud).not.toHaveBeenCalled();
		expect(deps.ensureHud).not.toHaveBeenCalled();
	});

	it("refuses an ambiguous window title with bad_request listing the candidates", async () => {
		const { controller, deps } = setup({ sources: [SCREEN, ORCA, ORCA_DOCS, NOTES] });

		const error = await controller.start({ source: { windowTitle: "orca" } }).catch((e) => e);

		expect(error).toBeInstanceOf(ControlError);
		expect(error.code).toBe("bad_request");
		expect(error.details).toEqual({ candidates: [ORCA, ORCA_DOCS] });
		expect(deps.ensureHud).not.toHaveBeenCalled();
		expect(deps.selectSource).not.toHaveBeenCalled();
		expect(deps.sendToHud).not.toHaveBeenCalled();
	});

	it("rejects malformed options before touching the HUD", async () => {
		const { controller, deps } = setup();

		for (const options of [
			{ source: { display: 0 }, countdownSeconds: -1 },
			{ source: { display: 0 }, countdownSeconds: 11 },
			{ source: { display: 0 }, countdownSeconds: 1.5 },
			{ source: { display: 0 }, countdownSeconds: "3" },
			{ source: { display: 0 }, agentCursor: "yes" },
			null,
		]) {
			const error = await controller.start(options as never).catch((e) => e);
			expect(error).toBeInstanceOf(ControlError);
			expect(error.code).toBe("bad_request");
		}
		expect(deps.ensureHud).not.toHaveBeenCalled();
		expect(deps.sendToHud).not.toHaveBeenCalled();
	});

	it("with an editor open saves (when dirty), shows the HUD, then closes the editor", async () => {
		const { controller, calls, setEditor } = setup();
		const editor = fakeEditor(calls, { dirty: true });
		setEditor(editor);

		await controller.start({ source: { display: 0 } });

		expect(calls).toEqual(["save", "ensureHud", "close", "selectSource", "sendToHud:start"]);
	});

	it("with a clean editor open skips the save but still shows the HUD before closing it", async () => {
		const { controller, calls, setEditor } = setup();
		const editor = fakeEditor(calls, { dirty: false });
		setEditor(editor);

		await controller.start({ source: { display: 0 } });

		expect(editor.save).not.toHaveBeenCalled();
		expect(calls).toEqual(["ensureHud", "close", "selectSource", "sendToHud:start"]);
	});

	it("with a dirty editor whose save fails returns conflict and closes nothing", async () => {
		const { controller, deps, calls, setEditor } = setup();
		const editor = fakeEditor(calls, { dirty: true, saves: false });
		setEditor(editor);

		const error = await controller.start({ source: { display: 0 } }).catch((e) => e);

		expect(error).toBeInstanceOf(ControlError);
		expect(error.code).toBe("conflict");
		expect(error.message).toBe("Couldn't save the open take; nothing was closed");
		expect(editor.close).not.toHaveBeenCalled();
		expect(deps.sendToHud).not.toHaveBeenCalled();
		expect(deps.selectSource).not.toHaveBeenCalled();
	});

	it("with a dirty editor whose save never answers returns conflict after saveMs", async () => {
		const { controller, calls, setEditor } = setup();
		const editor = fakeEditor(calls, { dirty: true });
		editor.save.mockImplementation(() => new Promise<boolean>(() => undefined));
		setEditor(editor);

		const outcome = settleLater(controller.start({ source: { display: 0 } }));
		await vi.advanceTimersByTimeAsync(30_000);

		expect(outcome.error).toBeInstanceOf(ControlError);
		expect((outcome.error as ControlError).code).toBe("conflict");
		expect(editor.close).not.toHaveBeenCalled();
	});

	it("that never reaches recording-state returns timeout and clears the agent flag", async () => {
		const { controller, deps } = setup({ hud: () => ({ ok: true }) });

		const outcome = settleLater(
			controller.start({ source: { display: 0 }, agentCursor: true, countdownSeconds: 3 }),
		);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(outcome.done).toBe(false);
		await vi.advanceTimersByTimeAsync(3_000);

		expect(outcome.error).toBeInstanceOf(ControlError);
		expect((outcome.error as ControlError).code).toBe("timeout");
		expect(deps.setAgentCursorTakeActive).toHaveBeenLastCalledWith(false);
		expect(controller.status().recording).toBe(false);
	});

	it("returns the HUD's error as internal and clears the agent flag when the HUD fails", async () => {
		const { controller, deps } = setup({
			hud: () => ({ ok: false, error: "Screen recording permission denied" }),
		});

		const error = await controller
			.start({ source: { display: 0 }, agentCursor: true })
			.catch((e) => e);

		expect(error).toBeInstanceOf(ControlError);
		expect(error.code).toBe("internal");
		expect(error.message).toContain("Screen recording permission denied");
		expect(deps.setAgentCursorTakeActive).toHaveBeenLastCalledWith(false);
	});

	it("refuses a second start while the first is still in flight", async () => {
		const { controller } = setup({ hud: () => ({ ok: true }) });

		const first = settleLater(controller.start({ source: { display: 0 } }));
		await vi.advanceTimersByTimeAsync(0);
		const error = await controller.start({ source: { display: 0 } }).catch((e) => e);

		expect(error).toBeInstanceOf(ControlError);
		expect(error.code).toBe("conflict");
		await vi.advanceTimersByTimeAsync(30_000);
		expect(first.done).toBe(true);
	});
});

describe("createRecordingController stop", () => {
	async function recording(setupOptions: Parameters<typeof setup>[0] = {}) {
		const context = setup(setupOptions);
		await context.controller.start({ source: { display: 0 }, agentCursor: true });
		context.calls.length = 0;
		return context;
	}

	it("waits for recording-state false and the next settle, saves with the video's base name and returns both paths", async () => {
		const { controller, deps, events, calls } = await recording();

		const outcome = settleLater(controller.stop());
		await vi.advanceTimersByTimeAsync(1_000);
		expect(outcome.done).toBe(false);
		expect(deps.saveTake).not.toHaveBeenCalled();

		events.emit("fresh-take-settled", VIDEO_PATH);
		await vi.advanceTimersByTimeAsync(0);

		expect(calls).toEqual(["sendToHud:stop", "saveTake:recording-1730000000000"]);
		expect(outcome.error).toBeUndefined();
		expect(outcome.value).toEqual({ videoPath: VIDEO_PATH, projectPath: PROJECT_PATH });
		expect(controller.status()).toMatchObject({
			recording: false,
			paused: false,
			agentCursor: false,
			source: null,
			lastTake: { videoPath: VIDEO_PATH, projectPath: PROJECT_PATH },
		});
	});

	it("keeps a settle that arrives after arming but before recording-state false", async () => {
		const { controller, events } = await recording({
			hud: (action, emitter) => {
				if (action === "start") emitter.emit("recording-state", true);
				return { ok: true };
			},
		});

		const outcome = settleLater(controller.stop());
		await vi.advanceTimersByTimeAsync(0);
		events.emit("fresh-take-settled", VIDEO_PATH);
		await vi.advanceTimersByTimeAsync(0);
		expect(outcome.done).toBe(false);

		events.emit("recording-state", false);
		await vi.advanceTimersByTimeAsync(0);
		expect(outcome.value).toEqual({ videoPath: VIDEO_PATH, projectPath: PROJECT_PATH });
	});

	it("ignores settle events when no stop is armed (human takes are never auto-saved)", async () => {
		const { controller, deps, events } = setup();

		events.emit("fresh-take-settled", VIDEO_PATH);
		events.emit("recording-state", true);
		events.emit("recording-state", false);
		events.emit("fresh-take-settled", VIDEO_PATH);
		await vi.advanceTimersByTimeAsync(0);

		expect(deps.saveTake).not.toHaveBeenCalled();
		expect(controller.status().lastTake).toBeNull();
	});

	it("returns a saveError result instead of throwing when the editor never settles", async () => {
		const { controller, deps } = await recording();

		const outcome = settleLater(controller.stop());
		await vi.advanceTimersByTimeAsync(180_000);

		expect(outcome.error).toBeUndefined();
		expect(outcome.value).toEqual({
			videoPath: null,
			projectPath: null,
			saveError: "Editor did not finish loading the take",
		});
		expect(deps.saveTake).not.toHaveBeenCalled();
		expect(controller.status().lastTake).toEqual(outcome.value);
	});

	it("reports a failed save in the result and keeps the video path", async () => {
		const { controller, deps, events } = await recording();
		deps.saveTake.mockResolvedValueOnce({ ok: false, error: "Disk full" } as never);

		const outcome = settleLater(controller.stop());
		await vi.advanceTimersByTimeAsync(0);
		events.emit("fresh-take-settled", VIDEO_PATH);
		await vi.advanceTimersByTimeAsync(0);

		expect(outcome.value).toEqual({
			videoPath: VIDEO_PATH,
			projectPath: null,
			saveError: "Disk full",
		});
	});

	it("times out when the recording never stops", async () => {
		const { controller } = await recording({
			hud: (action, emitter) => {
				if (action === "start") emitter.emit("recording-state", true);
				return { ok: true };
			},
		});

		const outcome = settleLater(controller.stop());
		await vi.advanceTimersByTimeAsync(60_000);

		expect(outcome.error).toBeInstanceOf(ControlError);
		expect((outcome.error as ControlError).code).toBe("timeout");
		expect(controller.status().recording).toBe(true);
	});

	it("refuses to stop when nothing is recording", async () => {
		const { controller, deps } = setup();

		const error = await controller.stop().catch((e) => e);

		expect(error).toBeInstanceOf(ControlError);
		expect(error.code).toBe("conflict");
		expect(deps.sendToHud).not.toHaveBeenCalled();
	});
});

describe("createRecordingController pause, resume, cancel and cursor events", () => {
	it("pause and resume require a recording, forward to the HUD and track paused", async () => {
		const { controller, deps } = setup();
		expect((await controller.pause().catch((e) => e)).code).toBe("conflict");
		expect((await controller.resume().catch((e) => e)).code).toBe("conflict");

		await controller.start({ source: { display: 0 } });
		await controller.pause();
		expect(controller.status().paused).toBe(true);
		expect((await controller.pause().catch((e) => e)).code).toBe("conflict");

		await controller.resume();
		expect(controller.status().paused).toBe(false);
		expect(deps.sendToHud.mock.calls.map(([action]) => action)).toEqual([
			"start",
			"pause",
			"resume",
		]);
	});

	it("cancel requires a recording and waits for recording-state false", async () => {
		const { controller, deps } = setup();
		expect((await controller.cancel().catch((e) => e)).code).toBe("conflict");

		await controller.start({ source: { display: 0 } });
		await controller.cancel();

		expect(deps.sendToHud.mock.lastCall?.[0]).toBe("cancel");
		expect(controller.status().recording).toBe(false);
		expect(deps.saveTake).not.toHaveBeenCalled();
	});

	it("surfaces a HUD that never answers as a timeout", async () => {
		const { controller, deps } = setup();
		await controller.start({ source: { display: 0 } });
		deps.sendToHud.mockImplementation(() => new Promise<HudReply>(() => undefined));

		const outcome = settleLater(controller.pause());
		await vi.advanceTimersByTimeAsync(10_000);

		expect((outcome.error as ControlError).code).toBe("timeout");
		expect(controller.status().paused).toBe(false);
	});

	it("delegates cursor events and lets AgentCursorInactiveError propagate", () => {
		const { controller, deps } = setup();
		expect(controller.sendCursorEvents([{ atMs: 1 }])).toEqual({ accepted: 2, rejected: [] });
		expect(deps.ingestCursorEvents).toHaveBeenCalledWith([{ atMs: 1 }]);

		const inactive = new Error("No agent-driven take is currently capturing cursor events");
		deps.ingestCursorEvents.mockImplementation(() => {
			throw inactive;
		});
		expect(() => controller.sendCursorEvents([])).toThrow(inactive);
	});

	it("lists sources through the deps", async () => {
		const { controller } = setup();
		await expect(controller.listSources()).resolves.toEqual([SCREEN, ORCA, NOTES]);
	});
});
