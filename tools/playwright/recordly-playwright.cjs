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
const os = require("node:os");
const path = require("node:path");

const DISCOVERY_FILE = "control-server.json";
const NOT_RUNNING_MESSAGE =
	"Recordly's control server isn't running; start Recordly with RECORDLY_CONTROL=1";
const NOT_RESPONDING_MESSAGE =
	"Recordly's control server isn't responding (it may be busy or showing a dialog); check the Recordly window";
// For quick calls only (connect's ping, status, sources): start/stop/cancel/pause/resume wait on
// the recorder and editor and can legitimately take minutes.
const QUICK_REQUEST_TIMEOUT_MS = 5000;
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
 * Electron's appData directory, which holds Recordly's userData folders: %APPDATA% on Windows,
 * ~/Library/Application Support on macOS, $XDG_CONFIG_HOME or ~/.config on Linux.
 */
function defaultAppDataDir(env, platform, homeDir) {
	if (platform === "win32") {
		return env.APPDATA;
	}
	if (platform === "darwin") {
		return homeDir ? path.join(homeDir, "Library", "Application Support") : undefined;
	}
	if (env.XDG_CONFIG_HOME) {
		return env.XDG_CONFIG_HOME;
	}
	return homeDir ? path.join(homeDir, ".config") : undefined;
}

function defaultHomeDir() {
	try {
		return os.homedir();
	} catch {
		return undefined;
	}
}

/**
 * Finds a live discovery file: RECORDLY_CONTROL_FILE, then <appData>/Recordly-dev (dev builds),
 * then <appData>/Recordly (packaged), where <appData> is Electron's appData directory for the
 * platform (pass `appData` to override). Files that are unreadable or whose pid is dead (a crashed
 * Recordly) are skipped. Throws NOT_RUNNING_MESSAGE when none is live.
 */
function resolveControlFile({
	env = process.env,
	platform = process.platform,
	homeDir = defaultHomeDir(),
	appData = defaultAppDataDir(env, platform, homeDir),
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
 * One JSON request over node:http. `timeoutMs` (optional) bounds the whole request, from connect
 * to the end of the response, and rejects with NOT_RESPONDING_MESSAGE. Leave it unset for calls
 * that may legitimately take long: `stop` waits for the editor to settle and save, which can take
 * minutes. (Node's global fetch would give up after 5 minutes; node:http sends no Origin header,
 * which the server requires.)
 */
function httpJson(control, method, urlPath, body, { timeoutMs } = {}) {
	return new Promise((resolvePromise, rejectPromise) => {
		let timer = null;
		const clearTimer = () => {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
		};
		const resolve = (value) => {
			clearTimer();
			resolvePromise(value);
		};
		const reject = (error) => {
			clearTimer();
			rejectPromise(error);
		};

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
		if (isFiniteNumber(timeoutMs) && timeoutMs > 0) {
			timer = setTimeout(() => {
				const error = new Error(NOT_RESPONDING_MESSAGE);
				error.code = "RECORDLY_NOT_RESPONDING";
				// Destroying the request also aborts a half-read response; reject settles first.
				reject(error);
				req.destroy(error);
			}, timeoutMs);
		}
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
 * capture-phase mouse listeners once per document. Every event updates window.__recordlyLastMouse
 * (glideClick starts from it) and is forwarded, with the window metrics read at that instant,
 * through the exposed binding.
 */
function installCursorListener(bindingName) {
	const flag = `__recordlyCursorInstalled_${bindingName}`;
	if (window !== window.top || window[flag]) {
		return;
	}
	window[flag] = true;

	const buttons = ["left", "middle", "right"];
	const forward = (kind) => (event) => {
		window.__recordlyLastMouse = { x: event.clientX, y: event.clientY };
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

/**
 * Per browser context: ONE exposed binding and ONE init script, however many attachCursor/detach
 * cycles run (neither can be removed, so adding them per attach piles up listeners). `session`
 * is the handler of the currently attached cursor, or null when events should be ignored.
 */
const cursorHosts = new WeakMap();

function getCursorHost(context) {
	let host = cursorHosts.get(context);
	if (!host) {
		const bindingName = `__recordlyCursor_${process.pid}_${++bindingCounter}`;
		const created = { bindingName, session: null, ready: null };
		created.ready = (async () => {
			await context.exposeBinding(bindingName, (_source, raw) => {
				if (created.session) {
					created.session(raw);
				}
			});
			await context.addInitScript(installCursorListener, bindingName);
			for (const existing of context.pages()) {
				await existing.evaluate(installCursorListener, bindingName).catch(() => undefined);
			}
		})();
		cursorHosts.set(context, created);
		// A failed setup must not be cached: the next attachCursor starts over.
		created.ready.catch(() => {
			if (cursorHosts.get(context) === created) {
				cursorHosts.delete(context);
			}
		});
		host = created;
	}
	return host;
}

function isFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}

async function attachCursor(client, page, { offsetX = 0, offsetY = 0, flushMs = 50 } = {}) {
	const host = getCursorHost(page.context());
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

	function onRawEvent(raw) {
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
	}

	await host.ready;
	// Route events to this session; a previous session that was never detached stops receiving.
	host.session = onRawEvent;

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
			if (host.session === onRawEvent) {
				host.session = null;
			}
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

const VIEWPORT_TOLERANCE_PX = 4;
const MAX_SIZE_ATTEMPTS = 4;

/** Re-reads the window until two consecutive reads agree (or maxMs): resizes land asynchronously. */
async function measureSettledWindow(page, { intervalMs = 50, maxMs = 1000 } = {}) {
	const same = (a, b) =>
		a.innerWidth === b.innerWidth &&
		a.innerHeight === b.innerHeight &&
		a.outerWidth === b.outerWidth &&
		a.outerHeight === b.outerHeight;
	let previous = await measureWindow(page);
	const deadline = Date.now() + maxMs;
	while (Date.now() < deadline) {
		await sleep(intervalMs);
		const next = await measureWindow(page);
		if (same(previous, next)) {
			return next;
		}
		previous = next;
	}
	return previous;
}

const CDP_DETACH_TIMEOUT_MS = 500;

/**
 * Runs fn(cdp) with a CDP session on the page, bounded as a whole by timeoutMs: attaching, the work
 * and detaching can each hang on a wedged Chrome, and none of them may hang the caller. A session
 * attached after the timeout already fired is detached straight away.
 */
async function withBoundedCdpSession(page, { timeoutMs, timeoutMessage }, fn) {
	let cdp;
	let abandoned = false;
	let timer;
	const detach = async (session) => {
		let detachTimer;
		const bound = new Promise((resolve) => {
			detachTimer = setTimeout(resolve, CDP_DETACH_TIMEOUT_MS);
		});
		try {
			await Promise.race([Promise.resolve(session.detach()).catch(() => undefined), bound]);
		} finally {
			clearTimeout(detachTimer);
		}
	};
	const work = (async () => {
		const session = await page.context().newCDPSession(page);
		if (abandoned) {
			await detach(session);
			throw new Error(timeoutMessage);
		}
		cdp = session;
		return fn(session);
	})();
	// If the timeout wins, the abandoned work must not surface as an unhandled rejection.
	work.catch(() => undefined);
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
	});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		abandoned = true;
		clearTimeout(timer);
		if (cdp) {
			await detach(cdp);
		}
	}
}

/**
 * Sizes the browser window so the page viewport is width x height. Needed when launched with
 * viewport: null (e.g. --app windows), where the OS window size governs. Display scaling can leave
 * it a pixel or two off; that's cosmetic (cursor mapping reads live metrics per event), so up to
 * VIEWPORT_TOLERANCE_PX per axis is accepted with a warning. Throws only beyond that (the display
 * can't fit it). Resolves to the achieved { width, height }. Bounded by timeoutMs (default 20 s).
 */
async function sizeWindowForViewport(page, { width, height, timeoutMs = 20000 }) {
	return withBoundedCdpSession(
		page,
		{
			timeoutMs,
			timeoutMessage: `Couldn't size the browser window within ${timeoutMs} ms`,
		},
		(cdp) => sizeWithSession(cdp, page, { width, height }),
	);
}

async function sizeWithSession(cdp, page, { width, height }) {
	const { windowId, bounds } = await cdp.send("Browser.getWindowForTarget");
	if (bounds && bounds.windowState && bounds.windowState !== "normal") {
		await cdp.send("Browser.setWindowBounds", {
			windowId,
			bounds: { windowState: "normal" },
		});
	}

	const resize = async (request) => {
		await cdp.send("Browser.setWindowBounds", {
			windowId,
			bounds: { left: 0, top: 0, ...request },
		});
		return measureSettledWindow(page);
	};
	const error = (view) => Math.abs(view.innerWidth - width) + Math.abs(view.innerHeight - height);

	let current = await measureSettledWindow(page);
	let best;
	for (let attempt = 0; attempt < MAX_SIZE_ATTEMPTS && error(current) > 0; attempt++) {
		// Correct by the remaining delta from where the window really is now.
		const request = {
			width: current.outerWidth + (width - current.innerWidth),
			height: current.outerHeight + (height - current.innerHeight),
		};
		current = await resize(request);
		if (!best || error(current) < best.error) {
			best = { error: error(current), request };
		}
	}
	// Fractional display scaling can make corrections oscillate; end on the closest size seen.
	if (best && error(current) > best.error) {
		current = await resize(best.request);
	}

	const achieved = { width: current.innerWidth, height: current.innerHeight };
	if (achieved.width === width && achieved.height === height) {
		return achieved;
	}
	if (
		Math.abs(achieved.width - width) <= VIEWPORT_TOLERANCE_PX &&
		Math.abs(achieved.height - height) <= VIEWPORT_TOLERANCE_PX
	) {
		console.warn(
			`Browser viewport is ${achieved.width}×${achieved.height} rather than ${width}×${height}; continuing (cursor mapping is unaffected)`,
		);
		return achieved;
	}
	throw new Error(
		`Couldn't size the browser viewport to ${width}×${height} (got ${achieved.width}×${achieved.height}); the display may be too small`,
	);
}

/**
 * Maximizes the browser window and resolves to the settled page viewport { width, height }. Uses the
 * same CDP window control as sizeWindowForViewport; an already-maximized window is only measured.
 * Bounded by timeoutMs (default 5 s) so a stuck window manager can't hang a script. Cursor mapping
 * reads live window metrics per event, so a maximized window needs no special handling there.
 */
async function maximizeWindow(page, { timeoutMs = 5000 } = {}) {
	return withBoundedCdpSession(
		page,
		{
			timeoutMs,
			timeoutMessage: `Couldn't maximize the browser window within ${timeoutMs} ms`,
		},
		async (cdp) => {
			let { windowId, bounds } = await cdp.send("Browser.getWindowForTarget");
			// Confirm the state took; retry the maximize once if it didn't.
			for (let attempt = 0; attempt < 2; attempt++) {
				if (bounds && bounds.windowState === "maximized") {
					break;
				}
				await cdp.send("Browser.setWindowBounds", {
					windowId,
					bounds: { windowState: "maximized" },
				});
				({ windowId, bounds } = await cdp.send("Browser.getWindowForTarget"));
			}
			if (!bounds || bounds.windowState !== "maximized") {
				throw new Error("The browser window did not maximize");
			}
			const settled = await measureSettledWindow(page);
			return { width: settled.innerWidth, height: settled.innerHeight };
		},
	);
}

// --- Gliding mouse -----------------------------------------------------------------------------

const lastMousePosition = new WeakMap();

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function easeInOutCubic(t) {
	return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

async function readPageMousePosition(page) {
	try {
		const position = await page.evaluate(() => window.__recordlyLastMouse || null);
		if (position && isFiniteNumber(position.x) && isFiniteNumber(position.y)) {
			return { x: position.x, y: position.y };
		}
	} catch {
		// No evaluate, or the page is navigating: fall back.
	}
	return undefined;
}

/**
 * Moves the mouse to the centre of `locator` along an eased path (~1 step per 16 ms), then waits
 * `pauseMs`, without clicking. Uses real Playwright mouse input, so the injected listeners see
 * genuine DOM events. Resolves to the client point it ended on. Use it to bring the drawn cursor to
 * an element whose value you then set programmatically (e.g. `selectOption` on a native <select>,
 * so Chrome's popup, which a window recording doesn't capture, never opens).
 */
async function glideTo(page, locator, { durationMs = 600, pauseMs = 120 } = {}) {
	await locator.scrollIntoViewIfNeeded();
	const box = await locator.boundingBox();
	if (!box) {
		throw new Error("glideTo: the target has no bounding box (is it visible?)");
	}
	const target = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

	// The page's own record sees every mouse move (including the script's own page.mouse.move and
	// locator.click calls); the helper's memory only knows its own glides.
	let from = (await readPageMousePosition(page)) || lastMousePosition.get(page);
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
	return { x: target.x, y: target.y };
}

/** glideTo, then a left click at the point it ended on. */
async function glideClick(page, locator, options = {}) {
	await glideTo(page, locator, options);
	await page.mouse.down({ button: "left" });
	await sleep(40);
	await page.mouse.up({ button: "left" });
}

// --- App window --------------------------------------------------------------------------------

/**
 * Finds the page of a Chrome `--app=<url>` window in a persistent `context`: one already open at
 * `url` (prefix match), else one that arrives within `timeoutMs` (default 5000); failing both,
 * navigates the first page (or a new one) to `url`. The page is brought to the front.
 */
async function openAppPage(context, url, { timeoutMs = 5000 } = {}) {
	const isAppPage = (page) => page.url().startsWith(url);
	let page = context.pages().find(isAppPage);
	if (!page) {
		page = await context
			.waitForEvent("page", { predicate: isAppPage, timeout: timeoutMs })
			.catch(() => undefined);
	}
	if (!page) {
		page = context.pages()[0] || (await context.newPage());
		await page.goto(url);
	}
	await page.bringToFront();
	return page;
}

// --- Client ------------------------------------------------------------------------------------

function createClient(control, { quickTimeoutMs = QUICK_REQUEST_TIMEOUT_MS } = {}) {
	async function request(method, urlPath, body, options) {
		let response;
		try {
			response = await httpJson(control, method, urlPath, body, options);
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

	const quick = { timeoutMs: quickTimeoutMs };
	const client = {
		status: () => request("GET", "/v1/status", undefined, quick),
		sources: async () => (await request("GET", "/v1/sources", undefined, quick)).sources,
		// No timeout: these wait on the recorder (and stop on the editor saving the project).
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
 * NOT_RUNNING_MESSAGE when the discovery file is missing/stale or the port refuses connections,
 * and with NOT_RESPONDING_MESSAGE when the server doesn't answer within `timeoutMs` (default 5 s;
 * also used by status() and sources()). Pass `control: { port, token }` to skip discovery.
 */
async function connect(options = {}) {
	const control = options.control || resolveControlFile(options).info;
	const client = createClient(
		{ port: control.port, token: control.token },
		isFiniteNumber(options.timeoutMs) && options.timeoutMs > 0
			? { quickTimeoutMs: options.timeoutMs }
			: {},
	);
	await client.status();
	return client;
}

module.exports = {
	NOT_RUNNING_MESSAGE,
	NOT_RESPONDING_MESSAGE,
	resolveControlFile,
	connect,
	glideClick,
	glideTo,
	openAppPage,
	pageEventToScreen,
	sizeWindowForViewport,
	maximizeWindow,
};
