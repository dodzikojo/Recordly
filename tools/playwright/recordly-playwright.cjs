"use strict";

/**
 * Playwright helper for agent-cursor recordings in Recordly.
 *
 * Dependency-free CommonJS (Node 18+). A script attaches this to its Playwright page; Recordly
 * then draws its cursor from the events posted here instead of the real mouse.
 *
 *   const { connect, glideClick } = require("<recordly checkout>/tools/playwright/recordly-playwright.cjs");
 *   const recordly = await connect();
 *   await recordly.start({ source: { windowTitle: "My page" }, agentCursor: true });
 *   const cursor = await recordly.attachCursor(page);
 *   await glideClick(page, page.getByRole("button", { name: "Go" }));
 *   await cursor.detach();
 *   const { videoPath, projectPath } = await recordly.stop();
 */

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const DISCOVERY_FILE = "control-server.json";
const NOT_RUNNING_MESSAGE =
	"Recordly's control server isn't running; start Recordly with RECORDLY_CONTROL=1";
const MAX_BATCH = 1000;

// --- Discovery ---------------------------------------------------------------------------------

function defaultIsPidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to someone else.
		return Boolean(error) && error.code === "EPERM";
	}
}

function defaultReadJson(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function isControlInfo(info) {
	return (
		Boolean(info) &&
		Number.isInteger(info.port) &&
		typeof info.token === "string" &&
		Number.isInteger(info.pid)
	);
}

/**
 * Finds a live discovery file: RECORDLY_CONTROL_FILE, then %APPDATA%\Recordly-dev, then
 * %APPDATA%\Recordly. Files that are unreadable or whose pid is dead (a crashed Recordly) are
 * skipped. Throws NOT_RUNNING_MESSAGE when none is live.
 */
function resolveControlFile({
	env = process.env,
	appData = process.env.APPDATA,
	exists = fs.existsSync,
	readJson = defaultReadJson,
	isPidAlive = defaultIsPidAlive,
} = {}) {
	const candidates = [];
	if (env.RECORDLY_CONTROL_FILE) {
		candidates.push(env.RECORDLY_CONTROL_FILE);
	}
	if (appData) {
		candidates.push(path.join(appData, "Recordly-dev", DISCOVERY_FILE));
		candidates.push(path.join(appData, "Recordly", DISCOVERY_FILE));
	}

	for (const file of candidates) {
		try {
			if (!exists(file)) {
				continue;
			}
			const info = readJson(file);
			if (isControlInfo(info) && isPidAlive(info.pid)) {
				return { file, info };
			}
		} catch {
			// Unreadable or malformed: treat like a stale file.
		}
	}
	throw new Error(NOT_RUNNING_MESSAGE);
}

// --- HTTP --------------------------------------------------------------------------------------

function isConnectionFailure(error) {
	return Boolean(error) && ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(error.code);
}

/**
 * One JSON request over node:http. There is deliberately no timeout: `stop` waits for the editor
 * to settle and save, which can take minutes. (Node's global fetch would give up after 5 minutes
 * and sends no Origin header either way; node:http sends none, which the server requires.)
 */
function httpJson(control, method, urlPath, body) {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? undefined : JSON.stringify(body);
		const headers = { Authorization: `Bearer ${control.token}`, Accept: "application/json" };
		if (payload !== undefined) {
			headers["Content-Type"] = "application/json";
			headers["Content-Length"] = Buffer.byteLength(payload);
		}
		const req = http.request(
			{
				host: "127.0.0.1",
				port: control.port,
				path: urlPath,
				method,
				headers,
				agent: false,
			},
			(res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("error", reject);
				res.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					let json;
					try {
						json = text ? JSON.parse(text) : undefined;
					} catch {
						json = undefined;
					}
					resolve({ status: res.statusCode || 0, statusText: res.statusMessage, json });
				});
			},
		);
		req.on("error", reject);
		if (payload !== undefined) {
			req.write(payload);
		}
		req.end();
	});
}

function toControlError(response) {
	const detail = response.json && response.json.error;
	const message =
		detail && typeof detail.message === "string"
			? `${typeof detail.code === "string" ? detail.code : response.status}: ${detail.message}`
			: `${response.status} ${response.statusText || "request failed"}`;
	const error = new Error(message);
	error.status = response.status;
	error.controlCode = detail && detail.code;
	error.details = detail && detail.details;
	return error;
}

// --- Cursor mapping ----------------------------------------------------------------------------

/**
 * Page client point -> screen DIP. `metrics` are window.screenX/screenY/outer*\/inner* read at the
 * moment of the event. The window's horizontal chrome (outer - inner width) is split evenly into
 * left and right borders; whatever is left of the vertical chrome sits above the viewport.
 */
function pageEventToScreen(metrics, clientX, clientY, correction) {
	const offsetX = (correction && correction.offsetX) || 0;
	const offsetY = (correction && correction.offsetY) || 0;
	const left = (metrics.outerWidth - metrics.innerWidth) / 2;
	const top = metrics.outerHeight - metrics.innerHeight - left;
	return {
		x: metrics.screenX + left + clientX + offsetX,
		y: metrics.screenY + top + clientY + offsetY,
	};
}

/**
 * Runs inside the page (serialised by Playwright, so it must be self-contained). Installs
 * capture-phase mouse listeners once per document and forwards each event, with the window
 * metrics read at that instant, through the exposed binding.
 */
function installCursorListener(bindingName) {
	const flag = `__recordlyCursorInstalled_${bindingName}`;
	if (window !== window.top || window[flag]) {
		return;
	}
	window[flag] = true;

	const buttons = ["left", "middle", "right"];
	const forward = (kind) => (event) => {
		let button;
		if (kind !== "move") {
			button = buttons[event.button];
			if (!button) {
				return;
			}
		}
		let cursor;
		try {
			const target = event.target;
			cursor = target instanceof Element ? getComputedStyle(target).cursor : undefined;
		} catch {
			cursor = undefined;
		}
		const send = window[bindingName];
		if (typeof send !== "function") {
			return;
		}
		try {
			Promise.resolve(
				send({
					atMs: Date.now(),
					kind,
					button,
					cursor,
					clientX: event.clientX,
					clientY: event.clientY,
					metrics: {
						screenX: window.screenX,
						screenY: window.screenY,
						outerWidth: window.outerWidth,
						innerWidth: window.innerWidth,
						outerHeight: window.outerHeight,
						innerHeight: window.innerHeight,
					},
				}),
			).catch(() => undefined);
		} catch {
			// The page is closing; nothing to forward to.
		}
	};
	window.addEventListener("mousemove", forward("move"), true);
	window.addEventListener("mousedown", forward("down"), true);
	window.addEventListener("mouseup", forward("up"), true);
}

let bindingCounter = 0;

function isFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}

async function attachCursor(client, page, { offsetX = 0, offsetY = 0, flushMs = 50 } = {}) {
	const context = page.context();
	const bindingName = `__recordlyCursor_${process.pid}_${++bindingCounter}`;
	const correction = { offsetX, offsetY };

	let queue = [];
	let detached = false;
	let chain = Promise.resolve();
	const counts = { sent: 0, accepted: 0, rejected: 0, dropped409: 0, failed: 0 };
	let lastError = null;

	async function drain() {
		while (queue.length > 0) {
			const batch = queue.slice(0, MAX_BATCH);
			queue = queue.slice(batch.length);
			counts.sent += batch.length;
			try {
				const result = await client.sendCursorEvents(batch);
				counts.accepted += isFiniteNumber(result && result.accepted) ? result.accepted : 0;
				counts.rejected += Array.isArray(result && result.rejected)
					? result.rejected.length
					: 0;
			} catch (error) {
				if (error && error.status === 409) {
					// No agent take is capturing (ended, or not started yet): events are moot.
					counts.dropped409 += batch.length;
					continue;
				}
				counts.failed += batch.length;
				throw error;
			}
		}
	}

	function flush() {
		const run = chain.then(drain);
		chain = run.catch(() => undefined);
		return run;
	}

	await context.exposeBinding(bindingName, (_source, raw) => {
		if (detached || !raw || !raw.metrics) {
			return;
		}
		// Window geometry comes with the event itself: the window may have moved since attach.
		const { x, y } = pageEventToScreen(raw.metrics, raw.clientX, raw.clientY, correction);
		const event = { atMs: raw.atMs, x, y, kind: raw.kind };
		if (raw.button) {
			event.button = raw.button;
		}
		if (typeof raw.cursor === "string" && raw.cursor) {
			event.cursor = raw.cursor;
		}
		queue.push(event);
	});
	await context.addInitScript(installCursorListener, bindingName);
	for (const existing of context.pages()) {
		await existing.evaluate(installCursorListener, bindingName).catch(() => undefined);
	}

	const timer = setInterval(() => {
		if (queue.length > 0) {
			flush().catch((error) => {
				lastError = error;
			});
		}
	}, flushMs);
	if (typeof timer.unref === "function") {
		timer.unref();
	}

	return {
		flush,
		async detach() {
			detached = true;
			clearInterval(timer);
			// A 409 here means the take already ended: that's done, not a failure. Anything else
			// is surfaced, but the caller should still call stop() so the take isn't lost.
			await flush();
		},
		stats() {
			return { ...counts, queued: queue.length, lastError };
		},
	};
}

// --- Window sizing -----------------------------------------------------------------------------

async function measureWindow(page) {
	return page.evaluate(() => ({
		outerWidth: window.outerWidth,
		outerHeight: window.outerHeight,
		innerWidth: window.innerWidth,
		innerHeight: window.innerHeight,
	}));
}

/**
 * Sizes the browser window so the page viewport is exactly width x height. Needed when launched
 * with viewport: null (e.g. --app windows), where the OS window size governs. Throws if the
 * display can't fit it.
 */
async function sizeWindowForViewport(page, { width, height }) {
	const cdp = await page.context().newCDPSession(page);
	try {
		const { windowId, bounds } = await cdp.send("Browser.getWindowForTarget");
		if (bounds && bounds.windowState && bounds.windowState !== "normal") {
			await cdp.send("Browser.setWindowBounds", {
				windowId,
				bounds: { windowState: "normal" },
			});
		}

		let current = await measureWindow(page);
		for (let attempt = 0; attempt < 2; attempt++) {
			const chromeW = current.outerWidth - current.innerWidth;
			const chromeH = current.outerHeight - current.innerHeight;
			await cdp.send("Browser.setWindowBounds", {
				windowId,
				bounds: { left: 0, top: 0, width: width + chromeW, height: height + chromeH },
			});
			current = await measureWindow(page);
			if (current.innerWidth === width && current.innerHeight === height) {
				return;
			}
		}
		throw new Error(
			`Couldn't size the browser viewport to ${width}×${height} (got ${current.innerWidth}×${current.innerHeight}); the display may be too small`,
		);
	} finally {
		await cdp.detach().catch(() => undefined);
	}
}

// --- Gliding mouse -----------------------------------------------------------------------------

const lastMousePosition = new WeakMap();

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function easeInOutCubic(t) {
	return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/**
 * Moves the mouse to the centre of `locator` along an eased path (~1 step per 16 ms), pauses, then
 * clicks. Uses real Playwright mouse input, so the injected listeners see genuine DOM events.
 */
async function glideClick(page, locator, { durationMs = 600, pauseMs = 120 } = {}) {
	await locator.scrollIntoViewIfNeeded();
	const box = await locator.boundingBox();
	if (!box) {
		throw new Error("glideClick: the target has no bounding box (is it visible?)");
	}
	const target = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

	let from = lastMousePosition.get(page);
	if (!from) {
		from = await page.evaluate(() => ({
			x: window.innerWidth / 2,
			y: window.innerHeight / 2,
		}));
		await page.mouse.move(from.x, from.y);
	}

	const steps = Math.max(2, Math.round(durationMs / 16));
	for (let step = 1; step <= steps; step++) {
		const eased = easeInOutCubic(step / steps);
		await page.mouse.move(
			from.x + (target.x - from.x) * eased,
			from.y + (target.y - from.y) * eased,
		);
		await sleep(durationMs / steps);
	}
	lastMousePosition.set(page, target);

	await sleep(pauseMs);
	await page.mouse.down({ button: "left" });
	await sleep(40);
	await page.mouse.up({ button: "left" });
}

// --- Client ------------------------------------------------------------------------------------

function createClient(control) {
	async function request(method, urlPath, body) {
		let response;
		try {
			response = await httpJson(control, method, urlPath, body);
		} catch (error) {
			if (isConnectionFailure(error)) {
				throw new Error(NOT_RUNNING_MESSAGE);
			}
			throw error;
		}
		if (response.status < 200 || response.status >= 300) {
			throw toControlError(response);
		}
		return response.json;
	}

	const client = {
		status: () => request("GET", "/v1/status"),
		sources: async () => (await request("GET", "/v1/sources")).sources,
		start: (options) => request("POST", "/v1/recording/start", options),
		pause: () => request("POST", "/v1/recording/pause"),
		resume: () => request("POST", "/v1/recording/resume"),
		stop: () => request("POST", "/v1/recording/stop"),
		cancel: () => request("POST", "/v1/recording/cancel"),
		sendCursorEvents: (events) => request("POST", "/v1/cursor-events", { events }),
		attachCursor: (page, options) => attachCursor(client, page, options),
	};
	return client;
}

/**
 * Connects to the running Recordly control server. Fails fast (never hangs) with
 * NOT_RUNNING_MESSAGE when the discovery file is missing/stale or the port refuses connections.
 * Pass `control: { port, token }` to skip discovery.
 */
async function connect(options = {}) {
	const control = options.control || resolveControlFile(options).info;
	const client = createClient({ port: control.port, token: control.token });
	await client.status();
	return client;
}

module.exports = {
	NOT_RUNNING_MESSAGE,
	resolveControlFile,
	connect,
	glideClick,
	pageEventToScreen,
	sizeWindowForViewport,
};
