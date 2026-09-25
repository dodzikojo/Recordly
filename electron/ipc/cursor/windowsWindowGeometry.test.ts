import { afterEach, describe, expect, it, vi } from "vitest";

const execFileAsync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:util", () => ({ promisify: () => execFileAsync }));

import { parseWindowsWindowGeometry, resolveWindowsWindowGeometry } from "./windowsWindowGeometry";

const originalPlatform = process.platform;

afterEach(() => {
	execFileAsync.mockReset();
	Object.defineProperty(process, "platform", { value: originalPlatform });
});

describe("parseWindowsWindowGeometry", () => {
	it("accepts physical frame and client bounds with DPI scale", () => {
		expect(
			parseWindowsWindowGeometry(
				JSON.stringify({
					frameBounds: { x: -1200, y: 20, width: 1200, height: 900 },
					clientBounds: { x: -1192, y: 60, width: 1184, height: 852 },
					dpiScale: 1.5,
					clientDetected: true,
				}),
			),
		).toEqual({
			frameBounds: { x: -1200, y: 20, width: 1200, height: 900 },
			clientBounds: { x: -1192, y: 60, width: 1184, height: 852 },
			dpiScale: 1.5,
			clientDetected: true,
		});
	});

	it("normalizes missing client geometry and an invalid DPI", () => {
		expect(
			parseWindowsWindowGeometry(
				JSON.stringify({
					frameBounds: { x: 0, y: 0, width: 800, height: 600 },
					clientBounds: null,
					dpiScale: 0,
					clientDetected: false,
				}),
			),
		).toEqual({
			frameBounds: { x: 0, y: 0, width: 800, height: 600 },
			clientBounds: null,
			dpiScale: 1,
			clientDetected: false,
		});
	});

	it("rejects malformed output and invalid frame geometry", () => {
		expect(parseWindowsWindowGeometry("not json")).toBeNull();
		expect(
			parseWindowsWindowGeometry(
				JSON.stringify({
					frameBounds: { x: 0, y: 0, width: -1, height: 600 },
					dpiScale: 1,
				}),
			),
		).toBeNull();
	});
});

describe("resolveWindowsWindowGeometry", () => {
	it("resolves only strict desktop-capture window IDs and passes the HWND through the environment", async () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		execFileAsync.mockResolvedValue({
			stdout: JSON.stringify({
				frameBounds: { x: 10, y: 20, width: 800, height: 600 },
				clientBounds: { x: 18, y: 50, width: 784, height: 562 },
				dpiScale: 1.5,
				clientDetected: true,
			}),
		});

		await expect(
			resolveWindowsWindowGeometry({
				id: "window:527526:0",
				name: "Edge",
				sourceType: "window",
			}),
		).resolves.toMatchObject({ dpiScale: 1.5, clientDetected: true });

		expect(execFileAsync).toHaveBeenCalledOnce();
		const [executable, args, options] = execFileAsync.mock.calls[0];
		expect(executable).toBe("powershell.exe");
		expect(args).not.toContain("527526");
		expect(options).toMatchObject({
			timeout: 2500,
			env: { RECORDLY_WINDOW_ID: "527526" },
		});
	});

	it("rejects titles, malformed IDs, and non-window source IDs without invoking PowerShell", async () => {
		Object.defineProperty(process, "platform", { value: "win32" });

		await expect(
			resolveWindowsWindowGeometry({ id: "screen:1:0", name: "Edge" }),
		).resolves.toBeNull();
		await expect(
			resolveWindowsWindowGeometry({ id: "window:not-a-hwnd:0", name: "Edge" }),
		).resolves.toBeNull();
		await expect(resolveWindowsWindowGeometry({ name: "Edge" })).resolves.toBeNull();
		expect(execFileAsync).not.toHaveBeenCalled();
	});
});
