import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipcMain } from "electron";
import { getFfprobeBinaryPath } from "./ffmpeg/binary";
import { resolveApprovedLocalMediaPath } from "./project/manager";
vi.mock("electron", () => ({
	ipcMain: { handle: vi.fn() },
	app: { getPath: () => "/test", isPackaged: false, once: vi.fn() },
}));
vi.mock("./project/manager", () => ({
	resolveApprovedLocalMediaPath: vi.fn(),
	rememberApprovedLocalReadPath: vi.fn(),
}));
vi.mock("./ffmpeg/binary", () => ({
	getFfprobeBinaryPath: vi.fn(),
	getFfmpegBinaryPath: vi.fn(),
}));
import { buildPreviewProxyArgs, registerPreviewProxyHandler } from "./previewProxy";

describe("smooth preview copy", () => {
	it("reduces decode load without retiming the recording or changing the source", () => {
		const args = buildPreviewProxyArgs("original.mp4", "preview.mp4.partial");
		expect(args).toContain(
			"fps=30,scale=960:960:force_original_aspect_ratio=decrease:force_divisible_by=2",
		);
		expect(args).not.toContain("-r");
		expect(args).not.toContain("-ss");
		expect(args).not.toContain("-t");
		expect(args).not.toContain("setpts");
		expect(args[args.indexOf("-i") + 1]).toBe("original.mp4");
		expect(args.at(-1)).toBe("preview.mp4.partial");
		expect(args.filter((arg) => arg === "2")).toHaveLength(2);
	});
});

describe("preview preparation IPC", () => {
	beforeEach(() => vi.clearAllMocks());

	it("refuses unapproved paths before probing or transcoding", async () => {
		vi.mocked(resolveApprovedLocalMediaPath).mockResolvedValue(null);
		registerPreviewProxyHandler();
		const handle = vi.mocked(ipcMain.handle).mock.calls.at(-1)![1];
		await expect(handle({} as never, "unapproved.mp4")).resolves.toEqual({ success: false });
		expect(getFfprobeBinaryPath).not.toHaveBeenCalled();
	});

	it("fails soft when preview tools are unavailable", async () => {
		vi.mocked(resolveApprovedLocalMediaPath).mockResolvedValue("original.mp4");
		vi.mocked(getFfprobeBinaryPath).mockImplementation(() => {
			throw new Error("Tool unavailable");
		});
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		registerPreviewProxyHandler();
		const handle = vi.mocked(ipcMain.handle).mock.calls.at(-1)![1];
		await expect(handle({} as never, "original.mp4")).resolves.toEqual({ success: false });
		expect(warning).toHaveBeenCalledOnce();
		warning.mockRestore();
	});
});
