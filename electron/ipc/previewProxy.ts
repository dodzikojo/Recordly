import { execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { app, ipcMain } from "electron";
import { USER_DATA_PATH } from "../appPaths";
import { getFfmpegBinaryPath, getFfprobeBinaryPath } from "./ffmpeg/binary";
import { rememberApprovedLocalReadPath, resolveApprovedLocalMediaPath } from "./project/manager";

const run = promisify(execFile);
const pending = new Map<string, Promise<string>>();
const encoders = new Set<ChildProcess>();
let queue: Promise<unknown> = Promise.resolve();

export function buildPreviewProxyArgs(input: string, output: string): string[] {
	return [
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-y",
		"-threads",
		"2",
		"-i",
		input,
		"-map",
		"0:v:0",
		"-map",
		"0:a?",
		"-vf",
		"fps=30,scale=960:960:force_original_aspect_ratio=decrease:force_divisible_by=2",
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-crf",
		"24",
		"-threads",
		"2",
		"-g",
		"30",
		"-c:a",
		"aac",
		"-b:a",
		"128k",
		"-movflags",
		"+faststart",
		"-f",
		"mp4",
		output,
	];
}

export function registerPreviewProxyHandler() {
	app.once("will-quit", () => {
		for (const encoder of encoders) encoder.kill();
	});
	ipcMain.handle("prepare-video-preview", async (_, requestedPath: string) => {
		try {
			if (typeof requestedPath !== "string") return { success: false };
			const input = await resolveApprovedLocalMediaPath(requestedPath);
			if (!input) return { success: false };
			const { stdout } = await run(
				getFfprobeBinaryPath(),
				[
					"-v",
					"error",
					"-select_streams",
					"v:0",
					"-show_entries",
					"stream=width,height,duration:format=duration",
					"-of",
					"json",
					input,
				],
				{ windowsHide: true, timeout: 30000 },
			);
			const metadata = JSON.parse(stdout);
			const width = Number(metadata.streams?.[0]?.width);
			const height = Number(metadata.streams?.[0]?.height);
			const duration = Number(metadata.streams?.[0]?.duration ?? metadata.format?.duration);
			if (!(width > 0 && height > 0 && duration > 0)) return { success: false };
			if (width * height <= 1920 * 1080) return { success: true, path: input, width, height };
			const stat = await fs.stat(input);
			const key = createHash("sha256")
				.update(`preview-v1:${input}:${stat.size}:${stat.mtimeMs}`)
				.digest("hex");
			const directory = path.join(USER_DATA_PATH, "preview-cache");
			const output = path.join(directory, `${key}.mp4`);
			let job = pending.get(key);
			if (!job) {
				job = queue
					.catch(() => undefined)
					.then(async () => {
						await fs.mkdir(directory, { recursive: true });
						if ((await fs.stat(output).catch(() => null))?.size) {
							const now = new Date();
							await fs.utimes(output, now, now).catch(() => undefined);
							return output;
						}
						const partial = `${output}.partial`;
						try {
							const encoding = run(
								getFfmpegBinaryPath(),
								buildPreviewProxyArgs(input, partial),
								{
									windowsHide: true,
									timeout: 20 * 60 * 1000,
									maxBuffer: 1024 * 1024,
								},
							);
							encoders.add(encoding.child);
							try {
								await encoding;
							} finally {
								encoders.delete(encoding.child);
							}
							const probe = await run(
								getFfprobeBinaryPath(),
								[
									"-v",
									"error",
									"-show_entries",
									"format=duration",
									"-of",
									"json",
									partial,
								],
								{ windowsHide: true, timeout: 30000 },
							);
							const proxyDuration = Number(JSON.parse(probe.stdout).format?.duration);
							if (
								!Number.isFinite(proxyDuration) ||
								Math.abs(proxyDuration - duration) > 0.1
							)
								throw new Error("Preview duration did not match the original");
							await fs.rename(partial, output);
							// Bound this regenerable cache without ever touching original media.
							const cached = await Promise.all(
								(await fs.readdir(directory))
									.filter((name) => /^[a-f0-9]{64}\.mp4$/.test(name))
									.map(async (name) => {
										const file = path.join(directory, name);
										return { file, modified: (await fs.stat(file)).mtimeMs };
									}),
							);
							for (const entry of cached
								.sort((a, b) => b.modified - a.modified)
								.slice(6)) {
								await fs.unlink(entry.file).catch(() => undefined);
							}
							return output;
						} finally {
							await fs.unlink(partial).catch(() => undefined);
						}
					});
				pending.set(key, job);
				queue = job;
				void job.finally(() => pending.delete(key)).catch(() => undefined);
			}
			const previewPath = await job;
			await rememberApprovedLocalReadPath(previewPath);
			return { success: true, path: previewPath, width, height };
		} catch (error) {
			console.warn("Could not prepare optimized preview:", error);
			return { success: false };
		}
	});
}
