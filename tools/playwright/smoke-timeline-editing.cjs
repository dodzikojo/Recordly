/* Run after building Electron main: node tools/playwright/smoke-timeline-editing.cjs --phase gaps */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright");

const root = path.resolve(__dirname, "../..");
const phase = process.argv[process.argv.indexOf("--phase") + 1] || "gaps";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "recordly-timeline-smoke-"));
const projectPath = path.join(profile, "timeline.recordly");
const sourcePath = path.join(profile, "source.mp4");
const audioPath = path.join(profile, "narration.wav");
const clips = [
	{ id: "clip-a", startMs: 500, endMs: 1500, speed: 1, sourceStartMs: 1000 },
	{ id: "clip-b", startMs: 2500, endMs: 3500, speed: 2, sourceStartMs: 5000 },
	{ id: "clip-c", startMs: 4500, endMs: 5500, speed: 1, sourceStartMs: 10000 },
	{ id: "clip-d", startMs: 6500, endMs: 7500, speed: 1, sourceStartMs: 15000 },
];
const annotationStyle = {
	fontSize: 24,
	color: "#fff",
	backgroundColor: "transparent",
	borderRadius: 0,
	fontFamily: "Arial",
	fontWeight: "normal",
	fontStyle: "normal",
	textDecoration: "none",
	textAlign: "center",
};

function generateMedia() {
	const bundled = require("ffmpeg-static");
	const ffmpeg = bundled && fs.existsSync(bundled) ? bundled : "ffmpeg";
	const run = (args) =>
		execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args], {
			windowsHide: true,
		});
	run([
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
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		sourcePath,
	]);
	run(["-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000", "-t", "8", audioPath]);
}

function writeFixture() {
	fs.writeFileSync(
		projectPath,
		JSON.stringify(
			{
				version: 1,
				videoPath: sourcePath,
				editor: {
					clipRegions:
						phase === "selection"
							? clips.map((clip) =>
									clip.id === "clip-a" ? { ...clip, endMs: 1501 } : clip,
								)
							: clips,
					zoomRegions: [
						{
							id: "zoom-b",
							startMs: 2500,
							endMs: 3500,
							depth: 2,
							focus: { cx: 0.5, cy: 0.5 },
						},
					],
					annotationRegions: [
						{
							id: "annotation-c",
							startMs: 4700,
							endMs: 5300,
							type: "text",
							content: "Kept annotation",
							position: { x: 50, y: 50 },
							size: { width: 30, height: 20 },
							style: annotationStyle,
							zIndex: 1,
						},
						{
							id: "annotation-gap",
							startMs: 1600,
							endMs: 2000,
							type: "text",
							content: "Gap annotation",
							position: { x: 50, y: 20 },
							size: { width: 30, height: 20 },
							style: annotationStyle,
							zIndex: 2,
						},
					],
					audioRegions: [
						{ id: "narration", startMs: 3000, endMs: 11000, audioPath, volume: 0.5 },
					],
					autoCaptions: [
						{ id: "caption-b", startMs: 5500, endMs: 6000, text: "Source caption" },
					],
					speedRegions: [],
					autoFullTrackClipId: null,
				},
			},
			null,
			2,
		),
	);
}

async function installInspection(page) {
	await page.addInitScript(() => {
		window.timelineSmoke = {
			props() {
				const rootNode = document.getElementById("root");
				const key = Object.keys(rootNode).find((k) => k.startsWith("__reactContainer"));
				const fiber = rootNode[key];
				const visit = (node) => {
					if (!node) return null;
					if (node.memoizedProps?.onClipSplit && node.memoizedProps?.onSeek)
						return node.memoizedProps;
					return visit(node.child) || visit(node.sibling);
				};
				return visit(fiber.stateNode?.current || fiber.current || fiber);
			},
		};
	});
}

async function state(page) {
	return page.evaluate(() => {
		const p = window.timelineSmoke.props();
		return {
			clips: p.clipRegions,
			zooms: p.zoomRegions,
			annotations: p.annotationRegions,
			audio: p.audioRegions,
			captions: p.captionRegions,
			selectedClipIds: p.selectedClipIds,
			selectedClipId: p.selectedClipId,
			sourceAudioSettings: Object.fromEntries(
				p.clipRegions.map((clip) => [
					clip.id,
					p.getSourceAudioTrackSettingsForClip?.(clip.id),
				]),
			),
			videoTime: document.querySelector("video")?.currentTime,
		};
	});
}

async function waitClipStart(page, id, start) {
	await page.waitForFunction(
		({ id, start }) =>
			window.timelineSmoke.props()?.clipRegions.find((c) => c.id === id)?.startMs === start,
		{ id, start },
	);
}

async function undo(page) {
	await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
}

async function waitSelected(page, ids) {
	await page.waitForFunction((ids) => {
		const actual = window.timelineSmoke.props()?.selectedClipIds || [];
		return actual.length === ids.length && ids.every((id) => actual.includes(id));
	}, ids);
}

const clipLocator = (page, id) => page.locator(`[data-clip-id="${id}"]`);

async function selectPair(page, first, second) {
	await page.keyboard.press("Escape");
	await clipLocator(page, first).click();
	await clipLocator(page, second).click({
		modifiers: [process.platform === "darwin" ? "Meta" : "Control"],
	});
	await waitSelected(page, [first, second]);
}

async function testSelection(page) {
	await selectPair(page, "clip-a", "clip-b");
	assert.equal(
		await page
			.locator('[data-clip-id][aria-pressed="true"], [data-clip-id][aria-selected="true"]')
			.count(),
		2,
	);
	await clipLocator(page, "clip-b").click();
	await waitSelected(page, ["clip-b"]);
	await clipLocator(page, "clip-d").click({ modifiers: ["Shift"] });
	await waitSelected(page, ["clip-b", "clip-c", "clip-d"]);
	await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
	await waitSelected(
		page,
		clips.map((clip) => clip.id),
	);
	await page.keyboard.press("Escape");
	await waitSelected(page, []);
	console.log("PASS toggle/range/select-all/clear");

	await selectPair(page, "clip-b", "clip-c");
	const before = await state(page);
	const box = await clipLocator(page, "clip-b").boundingBox();
	const originalCBox = await clipLocator(page, "clip-c").boundingBox();
	assert.ok(box);
	const x = box.x + box.width / 2,
		y = box.y + box.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x - box.width / 2, y, { steps: 12 });
	await waitSelected(page, ["clip-b", "clip-c"]);
	await page.waitForTimeout(50);
	assert.ok(
		(await clipLocator(page, "clip-c").boundingBox()).x < originalCBox.x - 1,
		"group drag must preview the other selected clips",
	);
	await page.mouse.up();
	await page.waitForFunction(
		() =>
			window.timelineSmoke.props().clipRegions.find((c) => c.id === "clip-b").startMs < 2500,
	);
	const moved = await state(page);
	const delta = moved.clips[1].startMs - before.clips[1].startMs;
	assert.ok(delta < 0 && delta >= -1000);
	assert.equal(moved.clips[2].startMs - before.clips[2].startMs, delta);
	assert.equal(moved.clips[0].startMs, before.clips[0].startMs);
	assert.equal(moved.clips[3].startMs, before.clips[3].startMs);
	assert.deepEqual(
		moved.clips.map((c) => c.sourceStartMs),
		[1000, 5000, 10000, 15000],
	);
	assert.equal(moved.zooms[0].startMs - before.zooms[0].startMs, delta);
	assert.equal(
		moved.annotations.find((a) => a.id === "annotation-c").startMs -
			before.annotations.find((a) => a.id === "annotation-c").startMs,
		delta,
	);
	assert.equal(moved.audio[0].startMs, 3000);
	console.log("PASS group drag/source preservation", { delta });
	await undo(page);
	await waitClipStart(page, "clip-b", 2500);
	assert.equal((await state(page)).clips[2].startMs, 4500);

	await selectPair(page, "clip-b", "clip-c");
	const cancelBox = await clipLocator(page, "clip-b").boundingBox();
	await page.mouse.move(cancelBox.x + cancelBox.width / 2, cancelBox.y + cancelBox.height / 2);
	await page.mouse.down();
	await page.mouse.move(cancelBox.x + cancelBox.width, cancelBox.y + cancelBox.height / 2, {
		steps: 8,
	});
	await page.keyboard.press("Escape");
	await page.mouse.up();
	assert.deepEqual((await state(page)).clips, before.clips);
	console.log("PASS group drag cancellation");

	await selectPair(page, "clip-a", "clip-b");
	const panel = page.locator('[class*="w-[332px]"]').first();
	await panel.getByText("Mixed", { exact: true }).first().waitFor();
	const originalSpeeds = (await state(page)).clips.map((c) => c.speed);
	await panel.getByRole("button", { name: "0.25×", exact: true }).click();
	assert.deepEqual(
		(await state(page)).clips.map((c) => c.speed),
		originalSpeeds,
	);
	await panel.getByRole("button", { name: "5×", exact: true }).click();
	await page.waitForFunction(() =>
		window.timelineSmoke
			.props()
			.clipRegions.slice(0, 2)
			.every((c) => c.speed === 5),
	);
	assert.deepEqual(
		(await state(page)).clips.map((c) => c.speed),
		[5, 5, 1, 1],
	);
	const accelerated = await state(page);
	assert.equal(
		accelerated.clips[0].sourceEndMs ??
			Math.round(
				accelerated.clips[0].sourceStartMs +
					(accelerated.clips[0].endMs - accelerated.clips[0].startMs) *
						accelerated.clips[0].speed,
			),
		2001,
	);
	await undo(page);
	await page.waitForFunction(
		() =>
			window.timelineSmoke.props().clipRegions[0].speed === 1 &&
			window.timelineSmoke.props().clipRegions[1].speed === 2,
	);
	console.log("PASS mixed/bulk speed/atomic overlap/undo");

	await panel
		.getByText("Mute", { exact: true })
		.locator("..")
		.locator("..")
		.getByRole("switch")
		.click();
	await page.waitForFunction(() =>
		window.timelineSmoke
			.props()
			.clipRegions.slice(0, 2)
			.every((c) => c.muted),
	);
	assert.deepEqual(
		(await state(page)).clips.map((c) => Boolean(c.muted)),
		[true, true, false, false],
	);
	await undo(page);
	await page.waitForFunction(() =>
		window.timelineSmoke.props().clipRegions.every((c) => !c.muted),
	);
	console.log("PASS bulk mute/undo");
	await panel
		.getByText("Separate clip from audio", { exact: true })
		.locator("..")
		.getByRole("switch")
		.click();
	await page.waitForFunction(() =>
		window.timelineSmoke
			.props()
			.clipRegions.slice(0, 2)
			.every((c) => c.showSourceAudio),
	);
	assert.deepEqual(
		(await state(page)).clips.map((c) => Boolean(c.showSourceAudio)),
		[true, true, false, false],
	);
	await undo(page);
	await page.waitForFunction(() =>
		window.timelineSmoke.props().clipRegions.every((c) => !c.showSourceAudio),
	);
	console.log("PASS bulk source-audio visibility/undo");

	const volume = panel.getByRole("slider", { name: "Volume", exact: true }).first();
	await volume.waitFor();
	const audioBefore = await state(page);
	const trackId = Object.keys(audioBefore.sourceAudioSettings["clip-a"])[0];
	assert.ok(trackId);
	await volume.press("ArrowLeft");
	await page.waitForFunction((id) => {
		const p = window.timelineSmoke.props();
		return p.getSourceAudioTrackSettingsForClip("clip-a")[id].volume < 1;
	}, trackId);
	const audioAfter = await state(page);
	assert.equal(
		audioAfter.sourceAudioSettings["clip-a"][trackId].volume,
		audioAfter.sourceAudioSettings["clip-b"][trackId].volume,
	);
	assert.equal(audioAfter.sourceAudioSettings["clip-c"][trackId].volume, 1);
	assert.equal(
		audioAfter.sourceAudioSettings["clip-a"][trackId].normalize,
		audioBefore.sourceAudioSettings["clip-a"][trackId].normalize,
	);
	await undo(page);
	await page.waitForFunction(
		(id) =>
			window.timelineSmoke.props().getSourceAudioTrackSettingsForClip("clip-a")[id].volume ===
			1,
		trackId,
	);
	assert.equal((await state(page)).sourceAudioSettings["clip-b"][trackId].volume, 1);
	console.log("PASS bulk source volume/field isolation/undo");

	await panel.getByText("Normalize", { exact: true }).locator("..").getByRole("switch").click();
	await page.waitForFunction(
		(id) =>
			window.timelineSmoke.props().getSourceAudioTrackSettingsForClip("clip-a")[id].normalize,
		trackId,
	);
	const normalized = await state(page);
	assert.equal(normalized.sourceAudioSettings["clip-b"][trackId].normalize, true);
	assert.equal(normalized.sourceAudioSettings["clip-c"][trackId].normalize, false);
	assert.equal(normalized.audio[0].endMs - normalized.audio[0].startMs, 8000);
	await persistAndReopen(page, normalized.clips, (editor) =>
		["clip-a", "clip-b"].every(
			(id) => editor.sourceAudioTrackSettingsByClip?.[id]?.[trackId]?.normalize === true,
		),
	);
	assert.equal((await state(page)).sourceAudioSettings["clip-b"][trackId].normalize, true);
	await waitSelected(page, []);
	console.log("PASS bulk normalization/history/persistence");
	await page.screenshot({ path: path.join(profile, "selection-settings.png") });

	await clipLocator(page, "clip-a").click();
	await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
	await waitSelected(
		page,
		clips.map((clip) => clip.id),
	);
	await page.keyboard.press("Delete");
	await page.waitForFunction(() => window.timelineSmoke.props().clipRegions.length === 0);
	assert.equal(
		await page.getByRole("button", { name: "Export", exact: true }).isDisabled(),
		true,
	);
	await undo(page);
	await page.waitForFunction(() => window.timelineSmoke.props().clipRegions.length === 4);
	assert.deepEqual((await state(page)).clips, normalized.clips);
	await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+z" : "Control+Shift+z");
	await page.waitForFunction(() => window.timelineSmoke.props().clipRegions.length === 0);
	const saveDeadline = Date.now() + 10000;
	while (
		Date.now() < saveDeadline &&
		JSON.parse(fs.readFileSync(projectPath, "utf8")).editor.clipRegions.length !== 0
	)
		await page.waitForTimeout(200);
	const emptyProject = JSON.parse(fs.readFileSync(projectPath, "utf8"));
	assert.equal(emptyProject.editor.clipRegions.length, 0);
	assert.ok(
		emptyProject.editor.trimRegions.some((trim) => trim.startMs === 0 && trim.endMs >= 20000),
	);
	await page.reload();
	await page.waitForFunction(
		() =>
			document.querySelector("video")?.readyState >= 2 &&
			window.timelineSmoke.props()?.clipRegions.length === 0,
	);
	assert.equal(
		await page.getByRole("button", { name: "Export", exact: true }).isDisabled(),
		true,
	);
	console.log("PASS all-clips deletion/one undo/redo/empty project persistence");
}

async function testGaps(page) {
	const gap = page.locator('[data-timeline-gap-start="1500"][data-timeline-gap-end="2500"]');
	await gap.click();
	await page.keyboard.press("Delete");
	await waitClipStart(page, "clip-b", 1500);
	let snapshot = await state(page);
	assert.deepEqual(
		snapshot.clips.map((c) => c.sourceStartMs),
		[1000, 5000, 10000, 15000],
	);
	assert.equal(snapshot.annotations.length, 2);
	assert.equal(snapshot.audio[0].endMs - snapshot.audio[0].startMs, 8000);
	assert.equal(snapshot.captions[0].startMs, 1750);
	console.log(
		"PASS gap keyboard delete",
		snapshot.clips.map((c) => [c.id, c.startMs]),
	);
	await undo(page);
	await waitClipStart(page, "clip-b", 2500);
	await gap.click({ button: "right" });
	await page.getByRole("menuitem", { name: /^close gap$/i }).click();
	await waitClipStart(page, "clip-b", 1500);
	console.log("PASS gap context menu");
	await undo(page);
	await waitClipStart(page, "clip-b", 2500);
	await page.getByRole("button", { name: /^close all gaps$/i }).click();
	await waitClipStart(page, "clip-a", 0);
	await page.waitForFunction(
		() => Math.abs(document.querySelector("video").currentTime - 1) < 0.05,
	);
	snapshot = await state(page);
	assert.deepEqual(
		snapshot.clips.map((c) => [c.startMs, c.endMs]),
		[
			[0, 1000],
			[1000, 2000],
			[2000, 3000],
			[3000, 4000],
		],
	);
	assert.deepEqual(
		snapshot.clips.map((c) => c.sourceStartMs),
		[1000, 5000, 10000, 15000],
	);
	assert.equal(snapshot.audio[0].endMs - snapshot.audio[0].startMs, 8000);
	assert.equal(snapshot.annotations.length, 2);
	assert.equal(snapshot.captions[0].startMs, 1250);
	console.log("PASS close all gaps", snapshot.clips);
	await undo(page);
	await waitClipStart(page, "clip-a", 500);
	await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+z" : "Control+Shift+z");
	await waitClipStart(page, "clip-a", 0);
	await persistAndReopen(page, snapshot.clips);
}

async function persistAndReopen(page, expected, savedMatches = () => true) {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		const saved = JSON.parse(fs.readFileSync(projectPath, "utf8"));
		if (
			JSON.stringify(saved.editor.clipRegions) === JSON.stringify(expected) &&
			savedMatches(saved.editor)
		)
			break;
		await page.waitForTimeout(200);
	}
	assert.deepEqual(JSON.parse(fs.readFileSync(projectPath, "utf8")).editor.clipRegions, expected);
	assert.ok(savedMatches(JSON.parse(fs.readFileSync(projectPath, "utf8")).editor));
	assert.equal(
		JSON.parse(fs.readFileSync(projectPath, "utf8")).editor.autoCaptions[0].startMs,
		5500,
	);
	await page.reload();
	await page.waitForFunction(
		() =>
			document.querySelector("video")?.readyState >= 2 &&
			window.timelineSmoke.props()?.clipRegions.length === 4,
	);
	const reopened = await state(page);
	await page.waitForFunction(
		() => Math.abs(document.querySelector("video").currentTime - 1) < 0.05,
	);
	assert.deepEqual(reopened.clips, expected);
	assert.equal(reopened.annotations.length, 2);
	assert.equal(reopened.audio[0].endMs - reopened.audio[0].startMs, 8000);
	console.log("PASS project persistence");
}

async function main() {
	generateMedia();
	writeFixture();
	const { createServer } = await import("vite");
	const { default: react } = await import("@vitejs/plugin-react");
	const server = await createServer({
		configFile: false,
		root,
		plugins: [react()],
		resolve: { alias: { "@": path.join(root, "src") } },
		server: {
			host: "127.0.0.1",
			port: 59000 + Math.floor(Math.random() * 4000),
			strictPort: true,
		},
		cacheDir: path.join(os.tmpdir(), "recordly-timeline-smoke-vite"),
	});
	await server.listen();
	const url = server.resolvedUrls.local[0].replace(/\/$/, "");
	const wrapper = path.join(profile, "main.cjs");
	fs.writeFileSync(
		wrapper,
		`const {app}=require('electron');
app.setPath('appData',${JSON.stringify(profile)});
app.setPath('userData',${JSON.stringify(path.join(profile, "user"))});
require(${JSON.stringify(path.join(root, "dist-electron/main.cjs"))});
`,
	);
	let app;
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
		const page = await app.firstWindow();
		page.on("pageerror", (error) => console.error("Renderer error:", error.message));
		await app.evaluate(({ webContents }) => {
			for (const contents of webContents.getAllWebContents()) contents.setAudioMuted(true);
		});
		await page.waitForFunction(() => Boolean(window.electronAPI?.openProjectFileAtPath));
		const opened = await page.evaluate(
			(p) => window.electronAPI.openProjectFileAtPath(p),
			projectPath,
		);
		assert.equal(opened.success, true);
		await installInspection(page);
		await page.goto(`${url}/?windowType=editor`);
		await page.waitForFunction(
			() =>
				document.querySelector("video")?.readyState >= 2 &&
				window.timelineSmoke.props()?.clipRegions.length === 4,
		);
		if (phase === "gaps") await testGaps(page);
		else if (phase === "selection") await testSelection(page);
		else throw new Error(`Unknown smoke phase: ${phase}`);
		await page.screenshot({ path: path.join(profile, `${phase}.png`) });
		console.log(`Timeline ${phase} smoke passed. Artifacts: ${profile}`);
	} catch (error) {
		if (app) {
			const page = (await app.windows())[0];
			if (page) {
				console.error("Failure state:", await state(page).catch(() => null));
				await page
					.screenshot({ path: path.join(profile, `${phase}-failure.png`) })
					.catch(() => undefined);
			}
		}
		throw error;
	} finally {
		if (app) {
			await app
				.evaluate(({ BrowserWindow, app: electronApp }) => {
					for (const window of BrowserWindow.getAllWindows()) window.destroy();
					electronApp.exit(0);
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
