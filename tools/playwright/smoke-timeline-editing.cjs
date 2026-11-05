/* Run after building Electron main: node tools/playwright/smoke-timeline-editing.cjs --phase gaps */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright");

const root = path.resolve(__dirname, "../..");
const phase = process.argv[process.argv.indexOf("--phase") + 1] || "gaps";
const baselineIndex = process.argv.indexOf("--baseline");
const baseline = baselineIndex >= 0 ? process.argv[baselineIndex + 1] : null;
if (baselineIndex >= 0)
	assert.ok(baseline && !baseline.startsWith("-"), "--baseline requires a git ref");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "recordly-timeline-smoke-"));
const projectPath = path.join(profile, "timeline.recordly");
const sourcePath = path.join(profile, "source.mp4");
const audioFixtureDirectory =
	phase === "audio"
		? fs.mkdtempSync(
				path.join(
					fs.mkdirSync(path.join(root, ".tmp"), { recursive: true }) ||
						path.join(root, ".tmp"),
					"external-audio-",
				),
			)
		: profile;
const audioPath = path.join(audioFixtureDirectory, "narration.wav");
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
	if (phase === "cursor") {
		fs.writeFileSync(
			sourcePath + ".cursor.json",
			JSON.stringify({
				version: 1,
				samples: Array.from({ length: 1001 }, (_, index) => ({
					timeMs: index * 20,
					cx: 0.5,
					cy: 0.5,
					interactionType: index % 50 === 0 ? "click" : "move",
				})),
			}),
		);
	}
	fs.writeFileSync(
		projectPath,
		JSON.stringify(
			{
				version: 1,
				videoPath: sourcePath,
				editor: {
					...(phase === "cursor"
						? {
								showCursor: true,
								cursorStyle: "dot",
								cursorClickEffect: "echo",
								cursorClickEffectColor: "#ff00ff",
								cursorClickBounceDuration: 120,
							}
						: {}),
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
					audioRegions:
						phase === "layout"
							? Array.from({ length: 9 }, (_, trackIndex) => ({
									id: `narration-${trackIndex}`,
									trackIndex,
									startMs: 3000,
									endMs: 11000,
									audioPath,
									volume: 0.5,
								}))
							: [
									{
										id: "narration",
										startMs: 3000,
										endMs: 11000,
										audioPath,
										volume: 0.5,
									},
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
			view() {
				const rootNode = document.getElementById("root");
				const key = Object.keys(rootNode).find((k) => k.startsWith("__reactContainer"));
				const fiber = rootNode[key];
				const visit = (node) =>
					node &&
					(node.memoizedProps?.onRangeChange && node.memoizedProps?.minVisibleRangeMs
						? node.memoizedProps
						: visit(node.child) || visit(node.sibling));
				return visit(fiber.stateNode?.current || fiber.current || fiber);
			},
			projects() {
				const rootNode = document.getElementById("root");
				const key = Object.keys(rootNode).find((k) => k.startsWith("__reactContainer"));
				const fiber = rootNode[key];
				const visit = (node) =>
					node &&
					(node.memoizedProps?.onOpenProject && node.memoizedProps?.entries
						? node.memoizedProps
						: visit(node.child) || visit(node.sibling));
				return visit(fiber.stateNode?.current || fiber.current || fiber);
			},
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
			playback() {
				const rootNode = document.getElementById("root");
				const key = Object.keys(rootNode).find((key) => key.startsWith("__reactContainer"));
				const fiber = rootNode[key];
				const visit = (node) => {
					if (!node) return null;
					if (node.ref?.current?.refreshFrame && node.ref.current.app)
						return node.ref.current;
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

async function testAudioAccess(page) {
	const result = await page.evaluate(
		async ({ sourcePath, audioPath }) => {
			const audioUrl = await window.electronAPI.getLocalMediaUrl(audioPath);
			if (!audioUrl.success)
				throw new Error("Project audio approval was lost after editor initialization");
			const response = await fetch(audioUrl.url);
			if (!response.ok) throw new Error("Audio HTTP failure: " + response.status);
			const audio = new Audio(audioUrl.url);
			audio.muted = true;
			await audio.play();
			await new Promise((resolve) => setTimeout(resolve, 200));
			const played = audio.currentTime;
			audio.pause();
			const { AudioProcessor } = await import("/src/lib/exporter/audioEncoder.ts");
			const processor = new AudioProcessor();
			const mixed = await processor.renderEditedAudioTrack(
				sourcePath,
				[{ id: "tail", startMs: 3000, endMs: 20000 }],
				[],
				[{ id: "voice", startMs: 0, endMs: 3000, audioPath, volume: 0.5 }],
				[],
				{},
				{ mixed: { volume: 0, normalize: false } },
				[{ id: "clip", startMs: 0, endMs: 3000, speed: 1, muted: true }],
			);
			const source = await window.electronAPI.getLocalMediaUrl(sourcePath);
			if (!source.success) throw new Error("Source URL unavailable");
			const video = await (await fetch(source.url)).arrayBuffer();
			const muxed = await window.electronAPI.muxExportedVideoAudio(video, {
				audioMode: "edited-track",
				editedTrackStrategy: "offline-render-fallback",
				editedAudioData: await mixed.arrayBuffer(),
				editedAudioMimeType: mixed.type,
				outputDurationSec: 3,
			});
			if (!muxed.success) throw new Error(muxed.error || "MP4 audio mux failed");
			return {
				played,
				mime: response.headers.get("content-type"),
				mixedBytes: mixed.size,
				outputPath: muxed.tempPath,
			};
		},
		{ sourcePath, audioPath },
	);
	assert.ok(result.played > 0);
	assert.equal(result.mime, "audio/wav");
	assert.ok(result.mixedBytes > 100000);
	const output = path.join(profile, "audio-export.mp4");
	fs.copyFileSync(result.outputPath, output);
	const pcm = execFileSync(
		require("ffmpeg-static"),
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-nostdin",
			"-i",
			output,
			"-map",
			"0:a:0",
			"-ac",
			"1",
			"-ar",
			"48000",
			"-f",
			"s16le",
			"-",
		],
		{ windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
	);
	let sum = 0;
	for (let offset = 0; offset < pcm.length; offset += 2) sum += pcm.readInt16LE(offset) ** 2;
	const rms = Math.sqrt(sum / (pcm.length / 2));
	assert.ok(rms > 100, "Exported narration must not be silent");
	console.log("PASS external project WAV playback, offline audio mix and real MP4 audio mux", {
		played: result.played,
		mixedBytes: result.mixedBytes,
		rms,
		output,
	});

	const recoveryIndex = process.argv.indexOf("--verify-project");
	if (recoveryIndex >= 0) {
		const recovery = JSON.parse(fs.readFileSync(process.argv[recoveryIndex + 1], "utf8"));
		const copy = path.join(profile, "recovered-project.recordly");
		fs.writeFileSync(copy, JSON.stringify(recovery));
		const checked = await page.evaluate(
			async ({ copy, recovery }) => {
				const loaded = await window.electronAPI.openProjectFileAtPath(copy);
				if (!loaded.success) throw new Error(loaded.message);
				await window.electronAPI.setCurrentVideoPath(recovery.videoPath, {
					preserveProjectPath: true,
				});
				const context = new AudioContext();
				try {
					return await Promise.all(
						recovery.editor.audioRegions.map(async (region) => {
							const url = await window.electronAPI.getLocalMediaUrl(region.audioPath);
							if (!url.success)
								throw new Error(
									"Recovered audio was rejected: " + region.audioPath,
								);
							const response = await fetch(url.url);
							const decoded = await context.decodeAudioData(
								await response.arrayBuffer(),
							);
							if (!(decoded.duration > 0))
								throw new Error("Empty recovered narration");
							return { duration: decoded.duration };
						}),
					);
				} finally {
					await context.close();
				}
			},
			{ copy, recovery },
		);
		assert.equal(checked.length, 10);
		console.log(
			"PASS all ten recovered narration files load and decode after project synchronization",
		);
	}
}

async function testCursorVisibility(page) {
	await page.waitForFunction(
		() =>
			window.timelineSmoke.playback()?.app &&
			window.timelineSmoke.props()?.cursorTelemetry.length > 0,
	);
	const pixelHash = () =>
		page.evaluate(() => {
			const app = window.timelineSmoke.playback().app;
			const result = app.renderer.extract.pixels({ target: app.stage });
			let hash = 2166136261;
			for (const byte of result.pixels) hash = Math.imul(hash ^ byte, 16777619);
			return hash >>> 0;
		});
	await clipLocator(page, "clip-a").click();
	const toggle = page.getByRole("switch", { name: "Hide cursor", exact: true });
	await toggle.waitFor();
	const visibleHash = await pixelHash();
	await toggle.click();
	await page.waitForFunction(
		() => window.timelineSmoke.props().clipRegions[0].hideCursor === true,
	);
	await page.waitForFunction((before) => {
		const app = window.timelineSmoke.playback().app;
		let hash = 2166136261;
		for (const byte of app.renderer.extract.pixels({ target: app.stage }).pixels)
			hash = Math.imul(hash ^ byte, 16777619);
		return hash >>> 0 !== before;
	}, visibleHash);
	const hiddenHash = await pixelHash();
	await undo(page);
	await page.waitForFunction(() => !window.timelineSmoke.props().clipRegions[0].hideCursor);
	await page.waitForTimeout(100);
	assert.notEqual(await pixelHash(), hiddenHash);
	console.log("PASS paused cursor pixels hide and restore with one Undo");

	await page.getByTitle("Cursor", { exact: true }).click();
	await page.getByRole("switch", { name: "Show Cursor", exact: true }).click();
	await page.waitForFunction(
		() => !window.timelineSmoke.playback() || document.querySelector("video").paused,
	);
	// Seek slightly after the first click so its ring is visible with the pointer disabled.
	const clip = await clipLocator(page, "clip-a").boundingBox();
	const ruler = await page.locator("[data-timeline-ruler]").boundingBox();
	await page.mouse.click(clip.x + clip.width * 0.25, ruler.y + 18);
	await page.waitForFunction(
		() => Math.abs(document.querySelector("video").currentTime - 1.25) < 0.04,
	);
	await clipLocator(page, "clip-a").click();
	await page.waitForTimeout(150);
	const ringHash = await pixelHash();
	await toggle.click();
	await page.waitForFunction(
		() => window.timelineSmoke.props().clipRegions[0].hideCursor === true,
	);
	await page.waitForTimeout(150);
	assert.notEqual(await pixelHash(), ringHash);
	console.log("PASS Hide cursor suppresses click effects even when global Show Cursor is off");

	await selectPair(page, "clip-a", "clip-b");
	assert.ok((await page.getByText("Mixed", { exact: true }).count()) > 0);
	await toggle.click();
	await page.waitForFunction(() =>
		window.timelineSmoke
			.props()
			.clipRegions.slice(0, 2)
			.every((clip) => clip.hideCursor),
	);
	await undo(page);
	await page.waitForFunction(() => !window.timelineSmoke.props().clipRegions[1].hideCursor);
	assert.equal((await state(page)).clips[0].hideCursor, true);
	await toggle.click();
	await page.waitForFunction(() =>
		window.timelineSmoke
			.props()
			.clipRegions.slice(0, 2)
			.every((clip) => clip.hideCursor),
	);
	await page.getByRole("button", { name: "5×", exact: true }).click();
	await page.waitForFunction(() => window.timelineSmoke.props().clipRegions[1].speed === 5);
	assert.ok((await state(page)).clips.slice(0, 2).every((clip) => clip.hideCursor));
	await undo(page);
	await page.waitForFunction(() => window.timelineSmoke.props().clipRegions[1].speed === 2);
	const saved = (await state(page)).clips;
	await page.screenshot({ path: path.join(profile, "cursor-controls.png") });
	await persistAndReopen(page, saved);
	assert.ok((await state(page)).clips.slice(0, 2).every((clip) => clip.hideCursor));
	console.log("PASS multi-select, mixed values, speed edit, Undo and save/reopen");
	const compositorResults = await page.evaluate(async () => {
		const { FrameRenderer } = await import("/src/lib/exporter/frameRenderer.ts");
		const { FrameRenderer: ModernFrameRenderer } = await import(
			"/src/lib/exporter/modernFrameRenderer.ts"
		);
		const results = [];
		for (const Renderer of [FrameRenderer, ModernFrameRenderer]) {
			const config = {
				width: 640,
				height: 360,
				frameRate: 30,
				preferredRenderBackend: "webgl",
				wallpaper: "#111111",
				zoomRegions: [],
				showShadow: false,
				shadowIntensity: 0,
				padding: 0,
				backgroundBlur: 0,
				borderRadius: 0,
				cropRegion: { x: 0, y: 0, width: 1, height: 1 },
				videoWidth: 640,
				videoHeight: 360,
				showCursor: true,
				cursorStyle: "dot",
				cursorClickEffect: "echo",
				cursorClickBounceDuration: 120,
				cursorClickEffectColor: "#ff00ff",
				cursorTelemetry: [
					{ timeMs: 1000, cx: 0.5, cy: 0.5, interactionType: "click" },
					{ timeMs: 2000, cx: 0.5, cy: 0.5 },
				],
				clipRegions: [],
			};
			const renderer = new Renderer(config);
			await renderer.initialize();
			try {
				const source = document.createElement("canvas");
				source.width = 640;
				source.height = 360;
				const context = source.getContext("2d");
				context.fillStyle = "#cc3333";
				context.fillRect(0, 0, 640, 360);
				const hash = async () => {
					await renderer.renderFrame(source, 1250000, 1250000);
					const pixels = renderer.capturePixelsForNativeExport
						? renderer.capturePixelsForNativeExport()
						: renderer.getCanvas().getContext("2d").getImageData(0, 0, 640, 360).data;
					let value = 2166136261;
					for (const byte of pixels) value = Math.imul(value ^ byte, 16777619);
					return value >>> 0;
				};
				const visible = await hash();
				renderer.config.clipRegions = [
					{
						id: "a",
						startMs: 4000,
						endMs: 4500,
						speed: 2,
						sourceStartMs: 1000,
						hideCursor: true,
					},
				];
				const hidden = await hash();
				renderer.config.showCursor = false;
				renderer.config.clipRegions = [];
				const ring = await hash();
				renderer.config.clipRegions = [
					{
						id: "a",
						startMs: 4000,
						endMs: 4500,
						speed: 2,
						sourceStartMs: 1000,
						hideCursor: true,
					},
				];
				const hiddenRing = await hash();
				results.push({ name: Renderer.name, visible, hidden, ring, hiddenRing });
			} finally {
				renderer.destroy();
			}
		}
		return results;
	});
	for (const result of compositorResults) {
		assert.notEqual(result.visible, result.hidden, JSON.stringify(result));
		assert.notEqual(result.ring, result.hiddenRing, JSON.stringify(result));
		assert.equal(result.hidden, result.hiddenRing, JSON.stringify(result));
	}
	console.log(
		"PASS real GIF/MP4 compositor pixels hide pointer and click effects",
		compositorResults,
	);
}

async function testLayout(page, app) {
	const resizeWindow = (width, height) =>
		app.evaluate(
			({ BrowserWindow }, size) => {
				const editor = BrowserWindow.getAllWindows().find((window) =>
					window.webContents.getURL().includes("windowType=editor"),
				);
				editor.unmaximize();
				editor.setContentSize(size.width, size.height);
			},
			{ width, height },
		);
	await resizeWindow(1280, 900);
	await page.waitForFunction(() => window.innerHeight === 900);
	const divider = page.getByRole("separator", { name: "Timeline height" });
	await divider.focus();
	await divider.press("Home");
	const metrics = () =>
		page.evaluate(() => {
			const scroll = document.querySelector("[data-timeline-scroll]");
			const lastAudio = document.querySelector('[data-timeline-row="row-audio-8"]');
			return {
				height: Number(
					document.querySelector('[role="separator"]').getAttribute("aria-valuenow"),
				),
				scrollHeight: scroll.scrollHeight,
				clientHeight: scroll.clientHeight,
				scrollTop: scroll.scrollTop,
				top: scroll.getBoundingClientRect().top,
				bottom: scroll.getBoundingClientRect().bottom,
				rulerTop: document.querySelector("[data-timeline-ruler]").getBoundingClientRect()
					.top,
				headTop: document.querySelector("[data-timeline-playhead]").getBoundingClientRect()
					.top,
				lastAudioBottom: lastAudio.getBoundingClientRect().bottom,
			};
		});
	let snapshot = await metrics();
	assert.equal(snapshot.height, 160);
	assert.ok(snapshot.scrollHeight > snapshot.clientHeight + 50);
	const scrollBox = await page.locator("[data-timeline-scroll]").boundingBox();
	await page.mouse.move(scrollBox.x + scrollBox.width - 30, scrollBox.y + 60);
	await page.mouse.wheel(0, 1000);
	await page.waitForFunction(
		() => document.querySelector("[data-timeline-scroll]").scrollTop > 20,
	);
	snapshot = await metrics();
	assert.ok(Math.abs(snapshot.rulerTop - snapshot.top) < 2, JSON.stringify(snapshot));
	assert.ok(Math.abs(snapshot.headTop - snapshot.top) < 5, JSON.stringify(snapshot));
	const head = await page.locator("[data-timeline-playhead]").boundingBox();
	const timeBeforeDrag = (await state(page)).videoTime;
	await page.mouse.move(head.x + 8, head.y + 8);
	await page.mouse.down();
	await page.mouse.move(head.x + 138, head.y + 8, { steps: 8 });
	await page.mouse.up();
	await page.waitForFunction(
		(before) => document.querySelector("video").currentTime > before + 0.1,
		timeBeforeDrag,
	);
	console.log("PASS pinned ruler/playhead seek while vertically scrolled");

	const before = await state(page);
	let handle = await divider.boundingBox();
	await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
	await page.mouse.down();
	await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 - 320, {
		steps: 10,
	});
	await page.mouse.up();
	snapshot = await metrics();
	assert.equal(snapshot.height, 480);
	assert.ok(snapshot.scrollHeight <= snapshot.clientHeight + 1, JSON.stringify(snapshot));
	assert.ok(snapshot.lastAudioBottom <= snapshot.bottom + 1, JSON.stringify(snapshot));
	assert.deepEqual((await state(page)).clips, before.clips);
	assert.deepEqual((await state(page)).audio, before.audio);
	await page.screenshot({ path: path.join(profile, "layout-expanded.png") });
	console.log("PASS real divider drag reveals all nine audio tracks");

	await divider.press("ArrowUp");
	assert.equal((await metrics()).height, 500);
	await page.reload();
	await page.waitForFunction(
		() =>
			document.querySelector("video")?.readyState >= 2 &&
			window.timelineSmoke.props()?.audioRegions.length === 9,
	);
	assert.equal((await metrics()).height, 500);
	await resizeWindow(1280, 720);
	await page.waitForFunction(
		() =>
			Number(document.querySelector('[role="separator"]').getAttribute("aria-valuenow")) <
			500,
	);
	await resizeWindow(1280, 900);
	await page.waitForFunction(
		() =>
			Number(document.querySelector('[role="separator"]').getAttribute("aria-valuenow")) ===
			500,
	);
	console.log("PASS keyboard sizing, reload persistence and smaller-window clamping");

	handle = await divider.boundingBox();
	await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
	await page.mouse.down();
	await page.mouse.move(handle.x + handle.width / 2, handle.y + 100, { steps: 6 });
	await page.keyboard.press("Escape");
	await page.mouse.up();
	assert.equal((await metrics()).height, 500);
	await divider.dblclick();
	assert.equal((await metrics()).height, 240);
	assert.equal(
		await page.evaluate(() =>
			window.electronAPI.getAppSetting("recordly.editor.timelinePanelHeight"),
		),
		240,
	);
	console.log("PASS resize cancellation and double-click reset");
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

async function testFit(page) {
	const view = () => page.evaluate(() => window.timelineSmoke.view()?.range);
	await page.waitForFunction(() => Boolean(window.timelineSmoke.view()));
	assert.deepEqual(await view(), { start: 0, end: 1400 });
	assert.equal(await page.evaluate(() => window.timelineSmoke.props().videoDuration), 20);
	const before = await state(page);
	const scroll = page.locator("[data-timeline-scroll]");
	const box = await scroll.boundingBox();
	const lastClip = await clipLocator(page, "clip-d").boundingBox();
	assert.ok(
		(lastClip.x + lastClip.width - box.x) / box.width > 0.6,
		"short edit should fill the opening view",
	);
	await scroll.locator("..").screenshot({ path: path.join(profile, "fit-open.png") });
	console.log(
		"PASS fitted opening view includes trailing effects and preserves 20s editing bounds",
	);
	await page.mouse.move(box.x + box.width / 2, box.y + 15);
	await page.keyboard.down("Control");
	await page.mouse.wheel(0, -400);
	await page.keyboard.up("Control");
	await page.waitForFunction(() => {
		const r = window.timelineSmoke.view().range;
		return r.end - r.start < 1400;
	});
	const zoomed = await view();
	await page.keyboard.down("Shift");
	await page.mouse.wheel(0, 80);
	await page.keyboard.up("Shift");
	await page.waitForFunction(
		(start) => window.timelineSmoke.view().range.start > start,
		zoomed.start,
	);
	const manual = await view();
	await page.evaluate(() => {
		const p = window.timelineSmoke.props();
		p.onAudioSpanChange("narration", { start: 0, end: 1900 });
	});
	await page.waitForFunction(() => window.timelineSmoke.props().audioRegions[0].endMs === 1900);
	assert.deepEqual(await view(), manual, "edits must preserve manual zoom/pan");
	assert.deepEqual((await state(page)).clips, before.clips);
	console.log("PASS manual zoom/pan retained across edits; clip/source timing unchanged", manual);
	const secondPath = path.join(profile, "same-source.recordly");
	const second = JSON.parse(fs.readFileSync(projectPath, "utf8"));
	second.editor.clipRegions = clips.map((clip, index) => ({
		...clip,
		startMs: index * 600,
		endMs: (index + 1) * 600,
		sourceEndMs: clip.sourceStartMs + 1200,
		speed: 2,
	}));
	second.editor.annotationRegions[0] = {
		...second.editor.annotationRegions[0],
		startMs: 2000,
		endMs: 2400,
	};
	fs.writeFileSync(secondPath, JSON.stringify(second));
	const reopen = async () => {
		await page.evaluate((p) => window.timelineSmoke.projects().onOpenProject(p), secondPath);
		await page
			.getByRole("button", { name: "Discard changes", exact: true })
			.click({ timeout: 1500 })
			.catch(() => undefined);
		await page.waitForFunction(() => window.timelineSmoke.view()?.range.end === 2400);
	};
	await reopen();
	await page.evaluate(() => window.timelineSmoke.view().onRangeChange({ start: 200, end: 800 }));
	await page.waitForFunction(() => window.timelineSmoke.view().range.start === 200);
	await reopen();
	assert.deepEqual(await view(), { start: 0, end: 2400 });
	console.log("PASS same-source project switch and same-project reopen reset to content fit");
	const verifyIndex = process.argv.indexOf("--verify-project");
	if (verifyIndex >= 0) {
		const project = JSON.parse(fs.readFileSync(process.argv[verifyIndex + 1], "utf8"));
		const copy = path.join(profile, "fit-project.recordly");
		fs.writeFileSync(copy, JSON.stringify(project));
		const opened = await page.evaluate(
			(p) => window.electronAPI.openProjectFileAtPath(p),
			copy,
		);
		assert.equal(opened.success, true);
		await page.reload();
		await page.waitForFunction(
			(count) =>
				document.querySelector("video")?.readyState >= 2 &&
				window.timelineSmoke.props()?.clipRegions.length === count,
			project.editor.clipRegions.length,
		);
		const contentEnd = await page.evaluate(() => {
			const p = window.timelineSmoke.props();
			return Math.max(
				...p.clipRegions.map((r) => r.endMs),
				...p.zoomRegions.map((r) => r.endMs),
				...p.audioRegions.map((r) => r.endMs),
				...p.annotationRegions.map((r) => r.endMs),
				...p.captionRegions.map((r) => r.endMs),
			);
		});
		await page.waitForFunction(
			(end) => window.timelineSmoke.view()?.range.end === end,
			contentEnd,
		);
		assert.deepEqual(await view(), { start: 0, end: contentEnd });
		await page
			.locator("[data-timeline-scroll]")
			.locator("..")
			.screenshot({
				path: path.join(profile, "fit-project.png"),
			});
		console.log("PASS supplied project opens fitted to its edited content", {
			view: await view(),
			sourceDuration: await page.evaluate(() => document.querySelector("video").duration),
			clips: project.editor.clipRegions.length,
		});
	}
}

async function main() {
	generateMedia();
	writeFixture();
	if (phase === "fit") {
		const fixture = JSON.parse(fs.readFileSync(projectPath, "utf8"));
		fixture.editor.clipRegions = clips.map((clip, index) => ({
			...clip,
			startMs: index * 250,
			endMs: (index + 1) * 250,
			sourceEndMs: clip.sourceStartMs + 2500,
			speed: 10,
		}));
		fixture.editor.zoomRegions = [
			{ ...fixture.editor.zoomRegions[0], startMs: 250, endMs: 500 },
		];
		fixture.editor.annotationRegions = [
			{ ...fixture.editor.annotationRegions[0], startMs: 1000, endMs: 1400 },
		];
		fixture.editor.audioRegions = [
			{ ...fixture.editor.audioRegions[0], startMs: 0, endMs: 1200 },
		];
		fs.writeFileSync(projectPath, JSON.stringify(fixture));
	}
	const { createServer } = await import("vite");
	const { default: react } = await import("@vitejs/plugin-react");
	const server = await createServer({
		configFile: false,
		root,
		plugins: [
			...(baseline
				? [
						{
							name: "timeline-fit-baseline",
							enforce: "pre",
							load(id) {
								if (
									id.replaceAll("\\", "/") ===
									path
										.join(
											root,
											"src/components/video-editor/timeline/hooks/useTimelineRange.ts",
										)
										.replaceAll("\\", "/")
								)
									return execFileSync(
										"git",
										[
											"show",
											`${baseline}:src/components/video-editor/timeline/hooks/useTimelineRange.ts`,
										],
										{ cwd: root, encoding: "utf8" },
									);
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
			watch: { ignored: ["**/.tmp/**", "**/*.test.ts", "**/docs/**"] },
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
		else if (phase === "layout") await testLayout(page, app);
		else if (phase === "cursor") await testCursorVisibility(page);
		else if (phase === "audio") await testAudioAccess(page);
		else if (phase === "fit") await testFit(page);
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
