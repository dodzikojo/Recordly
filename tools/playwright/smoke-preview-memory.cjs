/* After building Electron main: node tools/playwright/smoke-preview-memory.cjs */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright");

const root = path.resolve(__dirname, "../..");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "recordly-preview-memory-"));
const projects = ["4k", "1080p"].map((name) => path.join(profile, `${name}.recordly`));
const baselineIndex = process.argv.indexOf("--baseline");
const baseline = baselineIndex >= 0 ? process.argv[baselineIndex + 1] : null;
if (baselineIndex >= 0)
	assert.ok(baseline && !baseline.startsWith("-"), "--baseline requires a git ref");

function fixtures() {
	const bundled = require("ffmpeg-static");
	const ffmpeg = bundled && fs.existsSync(bundled) ? bundled : "ffmpeg";
	for (const [index, size] of ["3840x2160", "1920x1080"].entries()) {
		const videoPath = projects[index].replace(/\.recordly$/, ".mp4");
		execFileSync(
			ffmpeg,
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-nostdin",
				"-y",
				"-f",
				"lavfi",
				"-i",
				`testsrc2=size=${size}:rate=30`,
				"-t",
				"4",
				"-c:v",
				"libx264",
				"-preset",
				"ultrafast",
				"-pix_fmt",
				"yuv420p",
				videoPath,
			],
			{ windowsHide: true },
		);
		fs.writeFileSync(
			projects[index],
			JSON.stringify({
				version: 1,
				videoPath,
				editor: {
					clipRegions: [
						{ id: "clip", startMs: 0, endMs: 4000, sourceStartMs: 0, speed: 1 },
					],
				},
			}),
		);
	}
}

async function inspect(page) {
	await page.addInitScript(() => {
		const tracked = new WeakMap();
		const add = EventTarget.prototype.addEventListener;
		const remove = EventTarget.prototype.removeEventListener;
		function capture(options) {
			return typeof options === "boolean" ? options : Boolean(options?.capture);
		}
		EventTarget.prototype.addEventListener = function (type, listener, options) {
			if (this instanceof HTMLVideoElement && listener) {
				const events = tracked.get(this) || new Map();
				const key = `${type}:${capture(options)}`;
				const listeners = events.get(key) || new Set();
				listeners.add(listener);
				events.set(key, listeners);
				tracked.set(this, events);
			}
			return add.call(this, type, listener, options);
		};
		EventTarget.prototype.removeEventListener = function (type, listener, options) {
			tracked
				.get(this)
				?.get(`${type}:${capture(options)}`)
				?.delete(listener);
			return remove.call(this, type, listener, options);
		};
		function find(predicate) {
			const root = document.getElementById("root");
			const key = Object.keys(root).find((key) => key.startsWith("__reactContainer"));
			const fiber = root[key];
			const visit = (node) =>
				node && (predicate(node) ? node : visit(node.child) || visit(node.sibling));
			return visit(fiber.stateNode?.current || fiber.current || fiber);
		}
		window.previewMemorySmoke = {
			playback: () =>
				find((n) => n.ref?.current?.refreshFrame && n.ref.current.app)?.ref.current,
			settings: () =>
				find(
					(n) =>
						n.memoizedProps?.onBorderRadiusChange && n.memoizedProps?.onPaddingChange,
				)?.memoizedProps,
			projects: () =>
				find((n) => n.memoizedProps?.onOpenProject && n.memoizedProps?.entries)
					?.memoizedProps,
			listeners: (video) =>
				Object.fromEntries(
					["play", "pause", "seeked"].map((type) => [
						type,
						tracked.get(video)?.get(`${type}:false`)?.size || 0,
					]),
				),
		};
	});
}

async function ready(page, width) {
	await page.waitForFunction(
		(width) => {
			const p = window.previewMemorySmoke?.playback();
			return (
				p?.video?.readyState >= 2 &&
				p.video.videoWidth === width &&
				p.videoSprite?.texture.source.resource === p.video
			);
		},
		width,
		{ timeout: 30000 },
	);
}

async function snapshot(page) {
	return page.evaluate(() => {
		const p = window.previewMemorySmoke.playback();
		return {
			source: p.videoSprite.texture.source.uid,
			listeners: window.previewMemorySmoke.listeners(p.video),
			width: p.video.videoWidth,
			currentTime: p.video.currentTime,
		};
	});
}

async function main() {
	fixtures();
	const { createServer } = await import("vite");
	const { default: react } = await import("@vitejs/plugin-react");
	const server = await createServer({
		configFile: false,
		root,
		plugins: [
			...(baseline
				? [
						{
							name: "preview-memory-baseline",
							enforce: "pre",
							load(id) {
								if (
									id.replaceAll("\\", "/") ===
									path
										.join(root, "src/components/video-editor/VideoPlayback.tsx")
										.replaceAll("\\", "/")
								) {
									return execFileSync(
										"git",
										[
											"show",
											`${baseline}:src/components/video-editor/VideoPlayback.tsx`,
										],
										{ cwd: root, encoding: "utf8" },
									);
								}
							},
						},
					]
				: []),
			react(),
		],
		resolve: { alias: { "@": path.join(root, "src") } },
		server: {
			host: "127.0.0.1",
			port: 59000 + Math.floor(Math.random() * 4000),
			strictPort: true,
			watch: { ignored: ["**/.tmp/**", "**/*.test.ts"] },
		},
		cacheDir: path.join(profile, "vite"),
	});
	await server.listen();
	const url = server.resolvedUrls.local[0].replace(/\/$/, "");
	const wrapper = path.join(profile, "main.cjs");
	fs.writeFileSync(
		wrapper,
		`const {app}=require('electron');app.setPath('appData',${JSON.stringify(profile)});app.setPath('userData',${JSON.stringify(path.join(profile, "user"))});require(${JSON.stringify(path.join(root, "dist-electron/main.cjs"))});`,
	);
	let app;
	try {
		app = await electron.launch({
			args: [wrapper],
			env: {
				...process.env,
				VITE_DEV_SERVER_URL: url,
				RECORDLY_DEV_OPEN_RECORDING_INPUT: projects[0].replace(/\.recordly$/, ".mp4"),
				RECORDLY_CONTROL: "0",
			},
			timeout: 60000,
		});
		const page = await app.firstWindow();
		page.on("pageerror", (error) => console.error("Renderer:", error.message));
		await page.waitForFunction(() => Boolean(window.electronAPI?.openProjectFileAtPath));
		assert.equal(
			(await page.evaluate((p) => window.electronAPI.openProjectFileAtPath(p), projects[0]))
				.success,
			true,
		);
		await inspect(page);
		await page.goto(`${url}/?windowType=editor`);
		await ready(page, 3840);
		const initial = await snapshot(page);
		await page.evaluate(() => {
			const p = window.previewMemorySmoke.playback();
			window.initialPreviewSource = p.videoSprite.texture.source;
			window.initialPreviewVideo = p.video;
		});
		for (let i = 0; i < 120; i++) {
			await page.evaluate(async (i) => {
				const settings = window.previewMemorySmoke.settings();
				settings.onBorderRadiusChange(i % 60);
				if (i % 6 === 0)
					settings.onPaddingChange({
						top: i % 15,
						bottom: i % 15,
						left: i % 15,
						right: i % 15,
						linked: true,
					});
				await new Promise(requestAnimationFrame);
			}, i);
		}
		assert.deepEqual(await snapshot(page), initial);
		console.log(
			"PASS 120 radius / 20 padding changes retain one source and listener set",
			initial,
		);
		const switches = [];
		for (let i = 0; i < 10; i++) {
			const index = (i + 1) % 2;
			await page.evaluate(() => {
				const p = window.previewMemorySmoke.playback();
				window.previousPreviewSource = p.videoSprite.texture.source;
				window.previousPreviewVideo = p.video;
			});
			await page.evaluate(
				(p) => window.previewMemorySmoke.projects().onOpenProject(p),
				projects[index],
			);
			const discard = page.getByRole("button", { name: "Discard changes", exact: true });
			await discard.click({ timeout: 1500 }).catch(() => undefined);
			await ready(page, index ? 1920 : 3840);
			const state = await snapshot(page);
			const lifetime = await page.evaluate(() => {
				const p = window.previewMemorySmoke.playback();
				return {
					sameElement: p.video === window.previousPreviewVideo,
					sameSource: p.videoSprite.texture.source === window.previousPreviewSource,
					previousDestroyed: window.previousPreviewSource.destroyed,
				};
			});
			switches.push({ ...state, ...lifetime });
			assert.ok(
				lifetime.sameElement ? lifetime.sameSource : lifetime.previousDestroyed,
				"reuse the source for the same video element; destroy it when React replaces the element",
			);
			assert.deepEqual(
				state.listeners,
				initial.listeners,
				"media replacement must not accumulate listeners",
			);
		}
		console.log("PASS ten 4K/1080p source switches", switches);
		await page.evaluate(async () => {
			const p = window.previewMemorySmoke.playback();
			p.video.currentTime = 1;
			await p.refreshFrame();
			await p.play();
		});
		await page.waitForFunction(
			() => window.previewMemorySmoke.playback().video.currentTime > 1.5,
		);
		await page.evaluate(() => window.previewMemorySmoke.playback().pause());
		await page.evaluate(async () => {
			const p = window.previewMemorySmoke.playback();
			p.video.currentTime = 0.25;
			await p.refreshFrame();
		});
		const pixels = await page.evaluate(async () => {
			const p = window.previewMemorySmoke.playback();
			const { pixels } = await p.app.renderer.extract.pixels(p.videoSprite);
			let dark = 0,
				bright = 0;
			for (let i = 0; i < pixels.length; i += 4) {
				if (pixels[i] < 30) dark++;
				if (pixels[i] > 150) bright++;
			}
			return { dark, bright };
		});
		assert.ok(
			pixels.dark > 100 && pixels.bright > 100,
			"paused seek must render source pixels",
		);
		await page.screenshot({ path: path.join(profile, "preview.png") });
		console.log("PASS playback / backward paused seek / rendered picture", pixels);
		fs.writeFileSync(
			path.join(profile, "report.json"),
			JSON.stringify({ initial, switches, pixels }, null, 2),
		);
		console.log(`Preview memory smoke passed. Artifacts: ${profile}`);
	} finally {
		if (app) {
			await app
				.evaluate(({ BrowserWindow, app }) => {
					for (const window of BrowserWindow.getAllWindows()) window.destroy();
					app.exit(0);
				})
				.catch(() => undefined);
			await app.close().catch(() => undefined);
		}
		await server.close();
	}
}

main().catch((error) => {
	console.error(error);
	console.error(`Artifacts: ${profile}`);
	process.exitCode = 1;
});
