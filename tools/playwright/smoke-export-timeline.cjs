/* Requires the built Electron main and installed tools/playwright dependencies.
 * Falls back to Chrome if the installed Electron distribution lacks WebCodecs.
 * Uses a temporary Recordly profile; never opens or changes the user's project.
 * node tools/playwright/smoke-export-timeline.cjs
 * Add --verify-project <path> to export a temporary snapshot at 640x360/24fps.
 * Add --repeat 3 to exercise asynchronous decoder cleanup across repeated jobs.
 */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron, chromium } = require("playwright");

const root = path.resolve(__dirname, "../..");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "recordly-export-timeline-"));
const sourcePath = path.join(profile, "source.mp4");
const audioPath = path.join(profile, "ending-tone.wav");
const projectPath = path.join(profile, "overlapping-clips.recordly");
const repeatIndex = process.argv.indexOf("--repeat");
const repeat = repeatIndex < 0 ? 1 : Number(process.argv[repeatIndex + 1]);
assert.ok(Number.isInteger(repeat) && repeat >= 1 && repeat <= 5, "--repeat must be 1–5");
const clips = [
	{ id: "a", startMs: 0, endMs: 1000, sourceStartMs: 0, sourceEndMs: 2000, speed: 2 },
	{ id: "b", startMs: 1000, endMs: 3000, sourceStartMs: 1000, sourceEndMs: 3000, speed: 1 },
	{ id: "c", startMs: 3000, endMs: 4500, sourceStartMs: 7000, sourceEndMs: 10000, speed: 2 },
	{ id: "d", startMs: 4500, endMs: 6000, sourceStartMs: 18000, sourceEndMs: 19500, speed: 1 },
].map((clip) => ({ ...clip, muted: true }));
const trims = [
	{ id: "gap", startMs: 3000, endMs: 7000 },
	{ id: "gap2", startMs: 10000, endMs: 18000 },
	{ id: "tail", startMs: 19500, endMs: 20000 },
];
const speeds = [
	{ id: "fast-a", startMs: 0, endMs: 2000, speed: 2 },
	{ id: "fast-c", startMs: 7000, endMs: 10000, speed: 2 },
];
const narration = [{ id: "ending", startMs: 4500, endMs: 6000, audioPath, volume: 0.7 }];
const ffmpeg = require("ffmpeg-static");

function runFfmpeg(args) {
	return execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], {
		windowsHide: true,
		maxBuffer: 16 * 1024 * 1024,
	});
}

function generateMedia() {
	runFfmpeg([
		"-y",
		"-f",
		"lavfi",
		"-i",
		"testsrc2=size=640x360:rate=30",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=440:sample_rate=48000",
		"-t",
		"20",
		"-vf",
		"drawbox=x=0:y=0:w=iw:h=ih:color=0x00dd33:t=fill:enable='gte(t,18)'",
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-g",
		"30",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		sourcePath,
	]);
	runFfmpeg([
		"-y",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=880:sample_rate=48000",
		"-t",
		"1.5",
		audioPath,
	]);
	fs.writeFileSync(
		projectPath,
		JSON.stringify({
			version: 1,
			videoPath: sourcePath,
			editor: {
				clipRegions: clips,
				trimRegions: trims,
				speedRegions: [],
				audioRegions: narration,
				zoomRegions: [],
				annotationRegions: [],
				autoCaptions: [],
				autoFullTrackClipId: null,
				wallpaper: "#111111",
				padding: 0,
				borderRadius: 0,
				showCursor: false,
			},
		}),
	);
}

function probe(file) {
	const metadata = JSON.parse(
		execFileSync(
			require("ffprobe-static").path,
			[
				"-v",
				"error",
				"-count_frames",
				...(file.endsWith(".gif") ? ["-show_packets"] : []),
				"-show_entries",
				"format=duration:stream=codec_type,duration,nb_frames,nb_read_frames" +
					(file.endsWith(".gif") ? ":packet=duration_time" : ""),
				"-of",
				"json",
				file,
			],
			{ windowsHide: true, encoding: "utf8" },
		),
	);
	if (file.endsWith(".gif")) {
		metadata.format.duration = metadata.packets.reduce(
			(sum, packet) => sum + Number(packet.duration_time),
			0,
		);
		delete metadata.packets;
	}
	return metadata;
}

function verifyExport(file, frameCount, audio) {
	const metadata = probe(file);
	const video = metadata.streams.find((stream) => stream.codec_type === "video");
	assert.equal(Number(video.nb_read_frames), frameCount, JSON.stringify(metadata));
	assert.ok(Math.abs(Number(metadata.format.duration) - 6) < 0.05, JSON.stringify(metadata));
	const pixels = runFfmpeg([
		"-ss",
		"5.8",
		"-i",
		file,
		"-frames:v",
		"1",
		"-vf",
		"scale=1:1",
		"-pix_fmt",
		"rgb24",
		"-f",
		"rawvideo",
		"-",
	]);
	assert.ok(
		pixels[1] > 130 && pixels[1] > pixels[0] * 2 && pixels[1] > pixels[2] * 2,
		"Final image must contain the green ending marker, not a held earlier frame",
	);
	const frameAt = (time) =>
		runFfmpeg([
			"-ss",
			String(time),
			"-i",
			file,
			"-frames:v",
			"1",
			"-vf",
			"scale=64:36",
			"-pix_fmt",
			"rgb24",
			"-f",
			"rawvideo",
			"-",
		]);
	// First clip at 2x and second at 1x intentionally show source time 1.2s twice.
	const first = frameAt(0.6);
	const repeated = frameAt(1.2);
	assert.equal(first.length, repeated.length);
	let error = 0;
	for (let index = 0; index < first.length; index++)
		error += Math.abs(first[index] - repeated[index]);
	assert.ok(error / first.length < 4, "Reused source footage must appear twice, in clip order");
	if (audio) {
		const sound = metadata.streams.find((stream) => stream.codec_type === "audio");
		assert.ok(sound && Number(sound.duration) >= 5.95, JSON.stringify(metadata));
		const pcm = runFfmpeg([
			"-ss",
			"5.65",
			"-i",
			file,
			"-t",
			"0.25",
			"-map",
			"0:a:0",
			"-ac",
			"1",
			"-ar",
			"48000",
			"-f",
			"s16le",
			"-",
		]);
		let power = 0;
		for (let i = 0; i < pcm.length; i += 2) power += pcm.readInt16LE(i) ** 2;
		assert.ok(
			Math.sqrt(power / (pcm.length / 2)) > 300,
			"Last quarter-second narration must survive",
		);
	}
	console.log("PASS complete ending image/audio and duration", path.basename(file), metadata);
}

async function main() {
	generateMedia();
	const { createServer } = await import("vite");
	const { default: react } = await import("@vitejs/plugin-react");
	const server = await createServer({
		configFile: false,
		root,
		plugins: [
			react(),
			{
				name: "export-timeline-smoke-page",
				configureServer(vite) {
					vite.middlewares.use("/export-timeline-smoke.html", (_request, response) => {
						response.setHeader("Content-Type", "text/html");
						response.end(
							"<!doctype html><title>Recordly export timeline smoke</title><h1>Export timeline regression</h1>",
						);
					});
				},
			},
		],
		resolve: { alias: { "@": path.join(root, "src") } },
		server: {
			host: "127.0.0.1",
			port: 59000 + Math.floor(Math.random() * 4000),
			strictPort: true,
			watch: { ignored: ["**/*.test.ts", "**/docs/**"] },
		},
		cacheDir: path.join(os.tmpdir(), "recordly-export-timeline-vite"),
	});
	await server.listen();
	const url = server.resolvedUrls.local[0].replace(/\/$/, "");
	const wrapper = path.join(profile, "main.cjs");
	fs.writeFileSync(
		wrapper,
		`const {app}=require('electron');
app.setPath('appData',${JSON.stringify(profile)});
app.setPath('userData',${JSON.stringify(path.join(profile, "user"))});
require(${JSON.stringify(path.join(root, "dist-electron/main.cjs"))});`,
	);
	let app, browser;
	try {
		app = await electron.launch({
			args: [wrapper],
			env: {
				...process.env,
				VITE_DEV_SERVER_URL: url,
				RECORDLY_DEV_OPEN_RECORDING_INPUT: sourcePath,
				RECORDLY_CONTROL: "0",
			},
			timeout: 60000,
		});
		const editor = await app.firstWindow();
		await app.evaluate(({ webContents }) => {
			for (const content of webContents.getAllWebContents()) content.setAudioMuted(true);
		});
		await editor.waitForFunction(() => Boolean(window.electronAPI?.openProjectFileAtPath));
		const opened = await editor.evaluate(
			(file) => window.electronAPI.openProjectFileAtPath(file),
			projectPath,
		);
		assert.equal(opened.success, true);
		await editor.goto(`${url}/?windowType=editor`);
		await editor.waitForFunction(() => document.querySelector("video")?.readyState >= 2);
		await editor.screenshot({ path: path.join(profile, "editor.png") });
		const codecs = await editor.evaluate(() => ({
			secure: isSecureContext,
			decoder: typeof VideoDecoder,
			encoder: typeof VideoEncoder,
		}));
		console.log("PASS real Electron editor opens the overlapping clip fixture", codecs);
		let page = editor;
		if (codecs.decoder !== "function" || codecs.encoder !== "function") {
			console.log(
				"Electron WebCodecs unavailable; testing production exporters in Chrome with real Electron media/mux IPC",
			);
			browser = await chromium.launch({
				channel: "chrome",
				headless: true,
				args: ["--autoplay-policy=no-user-gesture-required"],
			});
			page = await browser.newPage();
		}
		page.on("pageerror", (error) => console.error("Exporter page:", error.message));
		page.on("console", (message) => {
			if (
				message.type() === "error" ||
				message.type() === "warning" ||
				message.text().startsWith("[export-smoke]")
			)
				console.log("Exporter:", message.text());
		});
		await page.exposeFunction("smokeMediaUrl", (file) =>
			editor.evaluate((p) => window.electronAPI.getLocalMediaUrl(p), file),
		);
		await page.exposeFunction("smokeWriteExport", ({ name, base64 }) => {
			const output = path.join(profile, name);
			fs.writeFileSync(output, Buffer.from(base64, "base64"));
			return output;
		});
		await page.exposeFunction("smokeMux", (payload) =>
			editor.evaluate(async ({ video, options }) => {
				const bytes = (value) =>
					Uint8Array.from(atob(value), (char) => char.charCodeAt(0)).buffer;
				if (options.editedAudioData)
					options.editedAudioData = bytes(options.editedAudioData);
				return window.electronAPI.muxExportedVideoAudio(bytes(video), options);
			}, payload),
		);
		if (browser) await page.goto(`${url}/export-timeline-smoke.html`);
		const exports = await page.evaluate(
			async ({ sourcePath, audioPath, clips, trims, speeds, narration, repeat }) => {
				const base64 = (buffer) => {
					const bytes = new Uint8Array(buffer);
					let text = "";
					for (let i = 0; i < bytes.length; i += 32768)
						text += String.fromCharCode(...bytes.subarray(i, i + 32768));
					return btoa(text);
				};
				if (!window.electronAPI)
					window.electronAPI = {
						getLocalMediaUrl: window.smokeMediaUrl,
						muxExportedVideoAudio: (video, options) =>
							window.smokeMux({
								video: base64(video),
								options: {
									...options,
									editedAudioData: options.editedAudioData
										? base64(options.editedAudioData)
										: undefined,
								},
							}),
					};
				if (typeof VideoDecoder === "undefined" || typeof VideoEncoder === "undefined")
					throw new Error("Chrome WebCodecs unavailable");
				const { ModernVideoExporter } = await import(
					"/src/lib/exporter/modernVideoExporter.ts"
				);
				const { VideoExporter } = await import("/src/lib/exporter/videoExporter.ts");
				const { GifExporter } = await import("/src/lib/exporter/gifExporter.ts");
				const config = {
					videoUrl: sourcePath,
					width: 640,
					height: 360,
					frameRate: 30,
					bitrate: 2_000_000,
					backendPreference: "webcodecs",
					preferredRenderBackend: "webgl",
					wallpaper: "#111111",
					zoomRegions: [],
					showShadow: false,
					shadowIntensity: 0,
					backgroundBlur: 0,
					borderRadius: 0,
					padding: 0,
					cropRegion: { x: 0, y: 0, width: 1, height: 1 },
					showCursor: false,
					clipRegions: clips,
					trimRegions: trims,
					speedRegions: speeds,
					audioRegions: narration,
					sourceAudioTrackSettings: { mixed: { volume: 0, normalize: false } },
				};
				const results = [];
				const cases = [
					["modern.mp4", ModernVideoExporter, {}],
					[
						"source-audio.mp4",
						ModernVideoExporter,
						{
							clipRegions: clips.map((clip) => ({ ...clip, muted: false })),
							audioRegions: [],
							sourceAudioTrackSettings: { mixed: { volume: 0.7, normalize: false } },
						},
					],
					["legacy.mp4", VideoExporter, {}],
					["timeline.gif", GifExporter, { frameRate: 10, loop: false }],
				];
				for (const [name, Exporter, extra] of Array.from({ length: repeat }, (_, index) =>
					cases.map(([name, Exporter, extra]) => [
						repeat > 1 ? `${index + 1}-${name}` : name,
						Exporter,
						extra,
					]),
				).flat()) {
					console.info("[export-smoke] Starting " + name);
					const exporter = new Exporter({ ...config, ...extra });
					let timeout;
					let result;
					try {
						result = await Promise.race([
							exporter.export(),
							new Promise((_, reject) => {
								timeout = setTimeout(() => {
									exporter.cancel();
									reject(new Error(name + " did not finish within 120 seconds"));
								}, 120_000);
							}),
						]);
					} finally {
						clearTimeout(timeout);
					}
					if (!result.success) throw new Error(name + ": " + result.error);
					const file =
						result.tempFilePath ||
						(await window.smokeWriteExport({
							name,
							base64: base64(await result.blob.arrayBuffer()),
						}));
					results.push({ name, file, metrics: result.metrics });
				}
				return results;
			},
			{ sourcePath, audioPath, clips, trims, speeds, narration, repeat },
		);
		for (const result of exports) {
			const target = path.join(profile, result.name);
			if (result.file !== target) fs.copyFileSync(result.file, target);
			verifyExport(
				target,
				result.name.endsWith("gif") ? 60 : 180,
				!result.name.endsWith("gif"),
			);
			console.log("Export metrics", result.name, result.metrics);
		}
		const verifyIndex = process.argv.indexOf("--verify-project");
		if (verifyIndex >= 0) {
			const snapshot = JSON.parse(fs.readFileSync(process.argv[verifyIndex + 1], "utf8"));
			const snapshotPath = path.join(profile, "project-snapshot.recordly");
			fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));
			const loaded = await editor.evaluate(
				async ({ snapshotPath, snapshot }) => {
					const opened = await window.electronAPI.openProjectFileAtPath(snapshotPath);
					if (!opened.success) throw new Error(opened.message);
					return window.electronAPI.setCurrentVideoPath(snapshot.videoPath, {
						preserveProjectPath: true,
					});
				},
				{ snapshotPath, snapshot },
			);
			assert.equal(loaded.success, true);
			const result = await page.evaluate(async (snapshot) => {
				const { ModernVideoExporter } = await import(
					"/src/lib/exporter/modernVideoExporter.ts"
				);
				const { getEditedDurationMs } = await import(
					"/src/components/video-editor/types.ts"
				);
				const config = {
					videoUrl: snapshot.videoPath,
					width: 640,
					height: 360,
					frameRate: 24,
					bitrate: 2_000_000,
					backendPreference: "webcodecs",
					wallpaper: "#111111",
					zoomRegions: [],
					showShadow: false,
					shadowIntensity: 0,
					backgroundBlur: 0,
					padding: 0,
					borderRadius: 0,
					cropRegion: { x: 0, y: 0, width: 1, height: 1 },
					showCursor: false,
					clipRegions: snapshot.editor.clipRegions,
					trimRegions: snapshot.editor.trimRegions,
					speedRegions: snapshot.editor.speedRegions,
					audioRegions: snapshot.editor.audioRegions,
				};
				const exported = await new ModernVideoExporter(config).export();
				if (!exported.success) throw new Error(exported.error);
				let file = exported.tempFilePath;
				if (!file) {
					const bytes = new Uint8Array(await exported.blob.arrayBuffer());
					let text = "";
					for (let i = 0; i < bytes.length; i += 32768)
						text += String.fromCharCode(...bytes.subarray(i, i + 32768));
					file = await window.smokeWriteExport({
						name: "project-snapshot.mp4",
						base64: btoa(text),
					});
				}
				return {
					file,
					durationMs: getEditedDurationMs(config.clipRegions, 0),
					metrics: exported.metrics,
				};
			}, snapshot);
			const output = path.join(profile, "project-snapshot.mp4");
			if (output !== result.file) fs.copyFileSync(result.file, output);
			const metadata = probe(output);
			assert.equal(
				Number(metadata.streams.find((stream) => stream.codec_type === "video").nb_frames),
				Math.ceil((result.durationMs / 1000) * 24),
			);
			assert.ok(Math.abs(Number(metadata.format.duration) - result.durationMs / 1000) < 0.05);
			assert.ok(
				Number(metadata.streams.find((stream) => stream.codec_type === "audio").duration) >=
					result.durationMs / 1000 - 0.05,
			);
			console.log(
				"PASS project snapshot export retains its complete edited duration and audio",
				{ durationMs: result.durationMs, metadata, output },
			);
		}
		console.log("Export timeline smoke passed. Artifacts:", profile);
	} finally {
		if (browser) await browser.close();
		if (app) {
			await app
				.evaluate(({ BrowserWindow, app: ownApp }) => {
					for (const window of BrowserWindow.getAllWindows()) window.destroy();
					ownApp.exit(0);
				})
				.catch(() => undefined);
			await app.close().catch(() => undefined);
		}
		await server.close();
	}
}

main().catch((error) => {
	console.error(error);
	console.error("Artifacts:", profile);
	process.exitCode = 1;
});
