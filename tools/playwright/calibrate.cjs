"use strict";

/**
 * Records a calibration take: a browser window with five buttons (four corners and the centre)
 * is clicked in turn while Recordly records it with the agent cursor. Play the result back: the
 * drawn cursor should land on each button. If it is consistently off, pass --offset-x/--offset-y
 * (screen DIP, added to every mapped point) and record again.
 *
 *   node calibrate.cjs [--offset-x <n>] [--offset-y <n>] [--headless]
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");
const {
	connect,
	glideClick,
	openAppPage,
	sizeWindowForViewport,
} = require("./recordly-playwright.cjs");

const VIEWPORT = { width: 1440, height: 900 };
const BUTTONS = ["#top-left", "#top-right", "#bottom-right", "#bottom-left", "#center"];

function parseArgs(argv) {
	const options = { offsetX: 0, offsetY: 0, headless: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--offset-x" || arg === "--offset-y") {
			const value = Number(argv[++i]);
			if (!Number.isFinite(value)) {
				throw new Error(`${arg} needs a number`);
			}
			options[arg === "--offset-x" ? "offsetX" : "offsetY"] = value;
		} else if (arg === "--headless") {
			// For dry runs against a fake server; Recordly can't capture a headless window.
			options.headless = true;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
	const options = parseArgs(process.argv.slice(2));

	// Fail fast, before any browser window opens, if Recordly isn't there.
	const recordly = await connect();

	const url = pathToFileURL(path.join(__dirname, "calibration.html")).href;
	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "recordly-calibration-"));
	const context = await chromium.launchPersistentContext(userDataDir, {
		channel: "chrome",
		chromiumSandbox: true,
		headless: options.headless,
		viewport: null,
		args: [`--app=${url}`],
	});

	let started = false;
	let cursor;
	let failure;
	try {
		const page = await openAppPage(context, url);
		const viewport = await sizeWindowForViewport(page, VIEWPORT);
		console.log(`viewport: ${viewport.width}x${viewport.height}`);

		await recordly.start({
			source: { windowTitle: "Recordly calibration" },
			agentCursor: true,
		});
		started = true;
		cursor = await recordly.attachCursor(page, {
			offsetX: options.offsetX,
			offsetY: options.offsetY,
		});

		await sleep(1000);
		for (const selector of BUTTONS) {
			await glideClick(page, page.locator(selector));
			// Recordly merges clicks closer than CLICK_CLUSTER_MERGE_GAP_MS (2500 ms) into one
			// auto-zoom; 3000 ms plus the glide and click pause keeps each click's zoom separate.
			await sleep(3000);
		}
	} catch (error) {
		failure = error;
	}

	if (cursor) {
		try {
			await cursor.detach();
		} catch (error) {
			console.warn(`Warning: the final cursor flush failed: ${error.message}`);
		}
		const stats = cursor.stats();
		const { lastError, ...counts } = stats;
		console.log(`cursor events: ${JSON.stringify(counts)}`);
		if (stats.accepted === 0) {
			console.warn(
				"Warning: Recordly accepted no cursor events; the cursor will be missing.",
			);
		}
		if (stats.failed > 0 || lastError) {
			const reason = lastError ? `: ${lastError.message}` : "";
			console.warn(`Warning: some cursor events failed to send${reason}`);
		}
	}

	// Always stop an open take so the footage is kept, even when something above failed.
	if (started) {
		try {
			const result = await recordly.stop();
			console.log(`videoPath: ${result.videoPath}`);
			console.log(`projectPath: ${result.projectPath}`);
			if (result.saveError) {
				console.warn(`saveError: ${result.saveError}`);
			}
		} catch (error) {
			failure = failure || error;
			console.error(`Stopping the take failed: ${error.message}`);
		}
	}

	await context.close().catch(() => undefined);
	fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });

	if (failure) {
		throw failure;
	}
}

main().catch((error) => {
	console.error(error.message || error);
	process.exitCode = 1;
});
