import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: {
		getPath: vi.fn(() => "/tmp"),
		setPath: vi.fn(),
		isReady: vi.fn(() => true),
	},
}));

import {
	activeCursorSamples,
	setActiveCursorSamples,
	setIsCursorCaptureActive,
	setLastLeftClick,
} from "../state";
import {
	recordCursorDownAt,
	recordCursorUpAt,
	repairBundledUiohookBinaryForCurrentArch,
	shouldStartGlobalInteractionHook,
} from "./interaction";

describe("recordCursorDownAt", () => {
	beforeEach(() => {
		setIsCursorCaptureActive(true);
		setActiveCursorSamples([]);
		setLastLeftClick(null);
	});

	it("classifies clicks, double-clicks (350 ms, 0.04 distance) and other buttons", () => {
		const point = { cx: 0.5, cy: 0.5 };

		recordCursorDownAt(point, 1_000, 1);
		recordCursorDownAt({ cx: 0.53, cy: 0.5 }, 1_350, 1);
		recordCursorDownAt({ cx: 0.53, cy: 0.5 }, 1_701, 1);
		recordCursorDownAt({ cx: 0.6, cy: 0.5 }, 1_800, 1);
		recordCursorDownAt(point, 1_900, 2);
		recordCursorDownAt(point, 2_000, 3);

		expect(activeCursorSamples.map((sample) => sample.interactionType)).toEqual([
			"click",
			"double-click",
			"click",
			"click",
			"right-click",
			"middle-click",
		]);
	});

	it("uses the supplied cursor type, and recordCursorUpAt records mouseup", () => {
		recordCursorDownAt({ cx: 0.1, cy: 0.2 }, 100, 1, "pointer");
		recordCursorUpAt({ cx: 0.1, cy: 0.2 }, 150, "pointer");

		expect(activeCursorSamples).toEqual([
			{ timeMs: 100, cx: 0.1, cy: 0.2, interactionType: "click", cursorType: "pointer" },
			{ timeMs: 150, cx: 0.1, cy: 0.2, interactionType: "mouseup", cursorType: "pointer" },
		]);
	});
});

describe("shouldStartGlobalInteractionHook", () => {
	it("does not start the synchronous uiohook event tap on macOS", () => {
		expect(shouldStartGlobalInteractionHook("darwin")).toBe(false);
	});

	it("keeps global interaction capture enabled on Windows and Linux", () => {
		expect(shouldStartGlobalInteractionHook("win32")).toBe(true);
		expect(shouldStartGlobalInteractionHook("linux")).toBe(true);
	});
});

describe("repairBundledUiohookBinaryForCurrentArch", () => {
	const tempRoots: string[] = [];

	afterEach(async () => {
		await Promise.all(
			tempRoots
				.splice(0)
				.map((tempRoot) => fs.rm(tempRoot, { recursive: true, force: true })),
		);
	});

	it("promotes the bundled darwin-arm64 prebuild over a stale incompatible build", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-uiohook-"));
		tempRoots.push(tempRoot);

		const packageRoot = path.join(tempRoot, "uiohook-napi");
		const prebuildPath = path.join(packageRoot, "prebuilds", "darwin-arm64", "node.napi.node");
		const buildPath = path.join(packageRoot, "build", "Release", "uiohook_napi.node");
		await fs.mkdir(path.dirname(prebuildPath), { recursive: true });
		await fs.mkdir(path.dirname(buildPath), { recursive: true });
		await fs.writeFile(prebuildPath, "arm64-prebuild");
		await fs.writeFile(buildPath, "x64-build");

		const log = vi.fn();
		const repaired = repairBundledUiohookBinaryForCurrentArch(
			Object.assign(
				new Error(
					"mach-o file, but is an incompatible architecture (have 'x86_64', need 'arm64')",
				),
				{
					code: "ERR_DLOPEN_FAILED",
				},
			),
			{ packageRoot, platform: "darwin", arch: "arm64", log },
		);

		expect(repaired).toBe(true);
		expect(await fs.readFile(buildPath, "utf8")).toBe("arm64-prebuild");
		expect(log).toHaveBeenCalledWith(
			"[CursorTelemetry] Repaired stale uiohook-napi binary using bundled darwin-arm64 prebuild.",
		);
	});

	it("does not rewrite binaries for unrelated load failures", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-uiohook-"));
		tempRoots.push(tempRoot);

		const packageRoot = path.join(tempRoot, "uiohook-napi");
		const buildPath = path.join(packageRoot, "build", "Release", "uiohook_napi.node");
		await fs.mkdir(path.dirname(buildPath), { recursive: true });
		await fs.writeFile(buildPath, "existing-build");

		const repaired = repairBundledUiohookBinaryForCurrentArch(
			Object.assign(new Error("some other dlopen failure"), {
				code: "ERR_DLOPEN_FAILED",
			}),
			{ packageRoot, platform: "darwin", arch: "arm64" },
		);

		expect(repaired).toBe(false);
		expect(await fs.readFile(buildPath, "utf8")).toBe("existing-build");
	});
});
