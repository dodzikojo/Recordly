import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));

vi.mock("electron", () => ({
	app: {
		getAppPath: () => process.cwd(),
		getName: () => "Recordly",
		getPath: () => process.env.TEMP ?? process.cwd(),
		isPackaged: false,
		setPath: () => undefined,
	},
	BrowserWindow: { getAllWindows: () => [] },
	desktopCapturer: { getSources: async () => [] },
	dialog: { showMessageBox: async () => ({ response: 1 }) },
	ipcMain: {
		handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
		on: () => undefined,
	},
	shell: { openExternal: async () => undefined },
	systemPreferences: {
		askForMediaAccess: async () => true,
		getMediaAccessStatus: () => "granted",
	},
}));

vi.mock("../recording/windows", () => ({
	attachWindowsCaptureLifecycle: vi.fn(),
	isNativeWindowsCaptureAvailable: vi.fn(async () => false),
	muxNativeWindowsVideoWithAudio: vi.fn(),
	waitForWindowsCaptureStart: vi.fn(async () => undefined),
	waitForWindowsCaptureStop: vi.fn(),
}));

vi.mock("../recording/mac", async (importOriginal) => ({
	...(await importOriginal<typeof import("../recording/mac")>()),
	waitForNativeCaptureCommand: vi.fn(async () => undefined),
}));

vi.mock("../cursor/monitor", () => ({
	startNativeCursorMonitor: vi.fn(async () => undefined),
	stopNativeCursorMonitor: vi.fn(),
}));

vi.mock("../cursor/interaction", async (importOriginal) => ({
	...(await importOriginal<typeof import("../cursor/interaction")>()),
	startInteractionCapture: vi.fn(async () => undefined),
	stopInteractionCapture: vi.fn(),
}));

vi.mock("../cursor/telemetry", async (importOriginal) => ({
	...(await importOriginal<typeof import("../cursor/telemetry")>()),
	sampleCursorPoint: vi.fn(),
	startCursorSampling: vi.fn(),
}));

vi.mock("../../cursorHider", () => ({ showCursor: vi.fn(() => false) }));

import { markNativeCaptureStarted } from "../cursor/agentCursor";
import {
	cursorCaptureStartTimeMs,
	nativeCaptureStartedAtMs,
	setAgentCursorTakeActive,
	setIsCursorCaptureActive,
	setNativeCapturePaused,
	setNativeCaptureProcess,
	setNativeCaptureStartedAtMs,
	setNativeScreenRecordingActive,
	setSelectedSource,
	setWindowsCapturePaused,
	setWindowsCaptureProcess,
	setWindowsNativeCaptureActive,
} from "../state";
import { registerRecordingHandlers } from "./recording";

registerRecordingHandlers();

function invoke(channel: string, ...args: unknown[]) {
	const handler = handlers.get(channel);
	if (!handler) {
		throw new Error(`No handler registered for ${channel}`);
	}
	return handler({}, ...args);
}

function fakeHelperProcess() {
	return { stdin: { write: vi.fn() } } as unknown as ChildProcessWithoutNullStreams;
}

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform) {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

/** Warm start as the HUD does it with a countdown: start (stamp), pause, countdown, resume. */
async function warmStartWithCountdown(countdownMs: number) {
	vi.setSystemTime(10_000);
	markNativeCaptureStarted(Date.now());
	vi.setSystemTime(10_050);
	await expect(invoke("pause-native-screen-recording")).resolves.toEqual({ success: true });
	vi.setSystemTime(10_050 + countdownMs);
	await expect(invoke("resume-native-screen-recording")).resolves.toEqual({ success: true });
}

describe("native capture start stamp wiring", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		setSelectedSource(null);
		setIsCursorCaptureActive(false);
		setAgentCursorTakeActive(false);
		setNativeCaptureStartedAtMs(null);
	});

	afterEach(async () => {
		await invoke("set-recording-state", false);
		setWindowsNativeCaptureActive(false);
		setWindowsCaptureProcess(null);
		setWindowsCapturePaused(false);
		setNativeScreenRecordingActive(false);
		setNativeCaptureProcess(null);
		setNativeCapturePaused(false);
		setPlatform(realPlatform);
		vi.useRealTimers();
	});

	describe.each([
		{
			platform: "win32" as const,
			activate: () => {
				setWindowsNativeCaptureActive(true);
				setWindowsCaptureProcess(fakeHelperProcess());
			},
		},
		{
			platform: "darwin" as const,
			activate: () => {
				setNativeScreenRecordingActive(true);
				setNativeCaptureProcess(fakeHelperProcess());
			},
		},
	])("$platform", ({ platform, activate }) => {
		beforeEach(() => {
			setPlatform(platform);
			activate();
		});

		it("excludes the countdown pause from an agent take's cursor clock", async () => {
			await warmStartWithCountdown(3_000);
			expect(nativeCaptureStartedAtMs).toBe(13_000);

			setAgentCursorTakeActive(true);
			vi.setSystemTime(13_950);
			await invoke("set-recording-state", true);
			// 0.9 s of webcam/mic setup after resume (plus the 50 ms before the pause) is real video.
			expect(cursorCaptureStartTimeMs).toBe(13_000);
		});

		it("keeps a human take's cursor clock on the wall clock", async () => {
			await warmStartWithCountdown(3_000);

			vi.setSystemTime(13_950);
			await invoke("set-recording-state", true);
			expect(cursorCaptureStartTimeMs).toBe(13_950);
		});

		it("does not shift the stamp for a pause during the take", async () => {
			vi.setSystemTime(10_000);
			markNativeCaptureStarted(Date.now());
			setAgentCursorTakeActive(true);
			vi.setSystemTime(10_900);
			await invoke("set-recording-state", true);
			expect(cursorCaptureStartTimeMs).toBe(10_000);

			vi.setSystemTime(12_000);
			await invoke("pause-native-screen-recording");
			vi.setSystemTime(14_000);
			await invoke("resume-native-screen-recording");
			expect(nativeCaptureStartedAtMs).toBe(10_000);
			expect(cursorCaptureStartTimeMs).toBe(10_000);
		});
	});

	it("clears a stale stamp when a native start attempt begins", async () => {
		setPlatform("win32");
		setNativeCaptureStartedAtMs(5_000);
		await expect(
			invoke("start-native-screen-recording", { id: "screen:0:0", name: "Screen" }),
		).resolves.toMatchObject({ success: false });
		expect(nativeCaptureStartedAtMs).toBeNull();

		setPlatform("linux");
		setNativeCaptureStartedAtMs(5_000);
		await invoke("start-native-screen-recording", { id: "screen:0:0", name: "Screen" });
		expect(nativeCaptureStartedAtMs).toBeNull();
	});

	it("gives a browser-fallback agent take no lead after a failed native start", async () => {
		setPlatform("win32");
		vi.setSystemTime(10_000);
		setNativeCaptureStartedAtMs(9_500);
		await invoke("start-native-screen-recording", { id: "screen:0:0", name: "Screen" });

		setAgentCursorTakeActive(true);
		vi.setSystemTime(10_200);
		await invoke("set-recording-state", true);
		expect(cursorCaptureStartTimeMs).toBe(10_200);
	});
});
