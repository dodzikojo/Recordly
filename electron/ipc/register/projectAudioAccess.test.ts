import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("project audio access after editor session synchronization", () => {
	let root: string;
	let handlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
	let videoPath: string;
	let audioPath: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-project-audio-"));
		const directories = {
			appData: path.join(root, "AppData"),
			userData: path.join(root, "UserData"),
			temp: path.join(root, "Temp"),
		};
		await Promise.all(
			Object.values(directories).map((directory) => fs.mkdir(directory, { recursive: true })),
		);
		await fs.mkdir(path.join(root, "Downloads"));
		videoPath = path.join(directories.temp, "source.mp4");
		audioPath = path.join(root, "Downloads", "narration.wav");
		await fs.writeFile(videoPath, "video");
		await fs.writeFile(audioPath, "audio");
		handlers = new Map();
		vi.resetModules();
		vi.doMock("electron", () => ({
			app: {
				isPackaged: false,
				getAppPath: () => path.join(root, "App"),
				getPath: (key: keyof typeof directories) => directories[key],
				setPath: vi.fn(),
				once: vi.fn(),
			},
			BrowserWindow: { getAllWindows: () => [] },
			dialog: {},
			shell: {},
			ipcMain: {
				handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) =>
					handlers.set(name, handler),
			},
		}));
		const projectPath = path.join(directories.temp, "source.recordly");
		await fs.writeFile(
			projectPath,
			JSON.stringify({
				version: 1,
				videoPath,
				editor: {
					audioRegions: [{ id: "voice", audioPath, startMs: 0, endMs: 1000, volume: 1 }],
				},
			}),
		);
		const { loadProjectFromPath } = await import("../project/manager");
		expect((await loadProjectFromPath(projectPath)).success).toBe(true);
		const { registerProjectHandlers } = await import("./project");
		registerProjectHandlers();
	});

	afterEach(async () => {
		vi.resetModules();
		vi.doUnmock("electron");
		if (root) await fs.rm(root, { recursive: true, force: true });
	});

	it("keeps project narration readable after the editor re-registers the same recording", async () => {
		const { resolveApprovedLocalMediaPath } = await import("../project/manager");
		const resolvedAudio = await fs.realpath(audioPath);
		expect(await resolveApprovedLocalMediaPath(audioPath)).toBe(resolvedAudio);
		await handlers.get("set-current-video-path")!(null, videoPath, {
			preserveProjectPath: true,
		});
		expect(await resolveApprovedLocalMediaPath(audioPath)).toBe(resolvedAudio);
	});

	it.each([
		false,
		true,
	])("revokes the old project's audio when changing recordings (preserve flag: %s)", async (preserveProjectPath) => {
		const nextVideo = path.join(root, "Temp", "next.mp4");
		await fs.writeFile(nextVideo, "next");
		await handlers.get("set-current-video-path")!(null, nextVideo, { preserveProjectPath });
		const { resolveApprovedLocalMediaPath } = await import("../project/manager");
		expect(await resolveApprovedLocalMediaPath(audioPath)).toBeNull();
	});

	it("does not approve unrelated files when keeping the current project", async () => {
		const unrelated = path.join(root, "Downloads", "unrelated.wav");
		await fs.writeFile(unrelated, "unrelated");
		await handlers.get("set-current-video-path")!(null, videoPath, {
			preserveProjectPath: true,
		});
		const { resolveApprovedLocalMediaPath } = await import("../project/manager");
		expect(await resolveApprovedLocalMediaPath(unrelated)).toBeNull();
	});
});
