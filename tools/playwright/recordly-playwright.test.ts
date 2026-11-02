import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);

interface Metrics {
	screenX: number;
	screenY: number;
	outerWidth: number;
	innerWidth: number;
	outerHeight: number;
	innerHeight: number;
}

interface CursorHandle {
	flush(): Promise<void>;
	detach(): Promise<void>;
	stats(): {
		sent: number;
		accepted: number;
		rejected: number;
		dropped409: number;
		failed: number;
	};
}

interface Client {
	status(): Promise<unknown>;
	sources(): Promise<unknown>;
	start(options: unknown): Promise<unknown>;
	stop(): Promise<unknown>;
	attachCursor(page: unknown, options?: Record<string, unknown>): Promise<CursorHandle>;
}

interface Helper {
	NOT_RUNNING_MESSAGE: string;
	NOT_RESPONDING_MESSAGE: string;
	resolveControlFile(options: {
		env: Record<string, string | undefined>;
		appData?: string;
		platform?: NodeJS.Platform;
		homeDir?: string;
		exists: (file: string) => boolean;
		readJson: (file: string) => unknown;
		isPidAlive: (pid: number) => boolean;
	}): { file: string; info: { port: number; token: string; pid: number } };
	connect(options?: Record<string, unknown>): Promise<Client>;
	pageEventToScreen(
		metrics: Metrics,
		clientX: number,
		clientY: number,
		correction?: { offsetX?: number; offsetY?: number },
	): { x: number; y: number };
	sizeWindowForViewport(
		page: unknown,
		size: { width: number; height: number },
	): Promise<{ width: number; height: number }>;
}

const helper = require("./recordly-playwright.cjs") as Helper;

const NOT_RUNNING =
	"Recordly's control server isn't running; start Recordly with RECORDLY_CONTROL=1";

describe("resolveControlFile", () => {
	const appData = path.join("C:", "AppData");
	const devFile = path.join(appData, "Recordly-dev", "control-server.json");
	const packagedFile = path.join(appData, "Recordly", "control-server.json");
	const explicitFile = path.join("D:", "custom", "control-server.json");

	const infos: Record<string, { port: number; token: string; pid: number }> = {
		[devFile]: { port: 1, token: "dev", pid: 11 },
		[packagedFile]: { port: 2, token: "packaged", pid: 22 },
		[explicitFile]: { port: 3, token: "explicit", pid: 33 },
	};

	function resolve(
		env: Record<string, string | undefined>,
		alivePids: number[],
		present: string[] = Object.keys(infos),
	) {
		return helper.resolveControlFile({
			env,
			appData,
			exists: (file) => present.includes(file),
			readJson: (file) => infos[file],
			isPidAlive: (pid) => alivePids.includes(pid),
		});
	}

	it("prefers RECORDLY_CONTROL_FILE over the dev and packaged files", () => {
		const result = resolve({ RECORDLY_CONTROL_FILE: explicitFile }, [11, 22, 33]);
		expect(result.file).toBe(explicitFile);
		expect(result.info.token).toBe("explicit");
	});

	it("prefers the dev userData directory over the packaged one", () => {
		expect(resolve({}, [11, 22]).file).toBe(devFile);
	});

	it("skips a file whose pid is dead", () => {
		expect(resolve({}, [22]).file).toBe(packagedFile);
	});

	it("throws the not-running message when no file is live", () => {
		expect(() => resolve({}, [])).toThrow(NOT_RUNNING);
		expect(() => resolve({}, [11, 22], [])).toThrow(NOT_RUNNING);
	});

	it("ignores a malformed discovery file", () => {
		const result = helper.resolveControlFile({
			env: {},
			appData,
			exists: () => true,
			readJson: (file) => {
				if (file === devFile) {
					throw new SyntaxError("bad json");
				}
				return infos[file];
			},
			isPidAlive: () => true,
		});
		expect(result.file).toBe(packagedFile);
	});

	describe("userData directories per platform", () => {
		const home = path.join("/", "home", "me");
		const live = { port: 4, token: "t", pid: 44 };

		function found(
			platform: NodeJS.Platform,
			env: Record<string, string | undefined>,
			present: string[],
		) {
			const checked: string[] = [];
			try {
				return helper.resolveControlFile({
					env,
					platform,
					homeDir: home,
					exists: (file) => {
						checked.push(file);
						return present.includes(file);
					},
					readJson: () => live,
					isPidAlive: () => true,
				}).file;
			} catch {
				return checked;
			}
		}

		it("uses %APPDATA% on Windows", () => {
			const base = path.join("C:", "Roaming");
			expect(found("win32", { APPDATA: base }, [])).toEqual([
				path.join(base, "Recordly-dev", "control-server.json"),
				path.join(base, "Recordly", "control-server.json"),
			]);
		});

		it("uses ~/Library/Application Support on macOS, dev before packaged", () => {
			const base = path.join(home, "Library", "Application Support");
			const dev = path.join(base, "Recordly-dev", "control-server.json");
			const packaged = path.join(base, "Recordly", "control-server.json");
			expect(found("darwin", {}, [])).toEqual([dev, packaged]);
			expect(found("darwin", {}, [dev, packaged])).toBe(dev);
			expect(found("darwin", {}, [packaged])).toBe(packaged);
		});

		it("uses $XDG_CONFIG_HOME on Linux, else ~/.config", () => {
			const xdg = path.join("/", "xdg");
			expect(found("linux", { XDG_CONFIG_HOME: xdg }, [])).toEqual([
				path.join(xdg, "Recordly-dev", "control-server.json"),
				path.join(xdg, "Recordly", "control-server.json"),
			]);
			const config = path.join(home, ".config");
			expect(found("linux", {}, [])).toEqual([
				path.join(config, "Recordly-dev", "control-server.json"),
				path.join(config, "Recordly", "control-server.json"),
			]);
		});

		it("still checks RECORDLY_CONTROL_FILE first", () => {
			const explicit = path.join("/", "custom", "control-server.json");
			const base = path.join(home, "Library", "Application Support");
			expect(found("darwin", { RECORDLY_CONTROL_FILE: explicit }, [])).toEqual([
				explicit,
				path.join(base, "Recordly-dev", "control-server.json"),
				path.join(base, "Recordly", "control-server.json"),
			]);
		});
	});
});

describe("pageEventToScreen", () => {
	const metrics: Metrics = {
		screenX: 100,
		screenY: 50,
		outerWidth: 1456,
		innerWidth: 1440,
		outerHeight: 1030,
		innerHeight: 900,
	};

	it("adds the window position and chrome insets to the client point", () => {
		expect(helper.pageEventToScreen(metrics, 10, 20)).toEqual({ x: 118, y: 192 });
	});

	it("applies the offset correction", () => {
		expect(helper.pageEventToScreen(metrics, 10, 20, { offsetX: 3, offsetY: -2 })).toEqual({
			x: 121,
			y: 190,
		});
	});

	it("follows the window when it moves between events", () => {
		const before = helper.pageEventToScreen(metrics, 10, 20);
		const after = helper.pageEventToScreen({ ...metrics, screenX: 160, screenY: 90 }, 10, 20);
		expect(after).toEqual({ x: before.x + 60, y: before.y + 40 });
	});
});

interface Recorded {
	method: string | undefined;
	url: string | undefined;
	headers: http.IncomingHttpHeaders;
	body: unknown;
}

describe("control client", () => {
	let server: http.Server | undefined;
	const requests: Recorded[] = [];
	let respond: (req: Recorded) => { status: number; body: unknown } = () => ({
		status: 200,
		body: {},
	});

	async function startFakeServer(): Promise<{ port: number; token: string }> {
		requests.length = 0;
		server = http.createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => {
				const text = Buffer.concat(chunks).toString("utf8");
				const recorded: Recorded = {
					method: req.method,
					url: req.url,
					headers: req.headers,
					body: text ? JSON.parse(text) : undefined,
				};
				requests.push(recorded);
				const { status, body } = respond(recorded);
				const payload = JSON.stringify(body);
				res.writeHead(status, { "Content-Type": "application/json" });
				res.end(payload);
			});
		});
		await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
		return { port: (server.address() as AddressInfo).port, token: "secret-token" };
	}

	afterEach(async () => {
		respond = () => ({ status: 200, body: {} });
		if (server) {
			const closing = server;
			server = undefined;
			await new Promise<void>((resolve) => {
				closing.close(() => resolve());
				closing.closeAllConnections();
			});
		}
	});

	it("sends the bearer token and JSON body on start", async () => {
		const control = await startFakeServer();
		respond = (req) =>
			req.url === "/v1/recording/start"
				? { status: 200, body: { agentCursor: true } }
				: { status: 200, body: { recording: false } };
		const client = await helper.connect({ control });
		const options = { source: { windowTitle: "Recordly calibration" }, agentCursor: true };
		await expect(client.start(options)).resolves.toEqual({ agentCursor: true });

		const start = requests.find((req) => req.url === "/v1/recording/start");
		expect(start?.method).toBe("POST");
		expect(start?.headers.authorization).toBe("Bearer secret-token");
		expect(start?.headers.origin).toBeUndefined();
		expect(start?.body).toEqual(options);
	});

	it("turns an error response into an Error carrying the server code", async () => {
		const control = await startFakeServer();
		const client = await helper.connect({ control });
		respond = () => ({
			status: 409,
			body: { error: { code: "conflict", message: "A take is already running; stop it" } },
		});
		await expect(client.start({ source: { display: 0 } })).rejects.toThrow(
			"conflict: A take is already running; stop it",
		);
	});

	it("fails fast when the discovery file points at a port nobody listens on", async () => {
		const control = await startFakeServer();
		await new Promise<void>((resolve) => {
			server?.close(() => resolve());
			server?.closeAllConnections();
		});
		server = undefined;
		await expect(helper.connect({ control })).rejects.toThrow(NOT_RUNNING);
	});

	/** Accepts connections and reads requests but never answers (a busy or blocked main process). */
	async function startSilentServer(): Promise<{ port: number; token: string }> {
		server = http.createServer(() => undefined);
		await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
		return { port: (server.address() as AddressInfo).port, token: "secret-token" };
	}

	const NOT_RESPONDING =
		"Recordly's control server isn't responding (it may be busy or showing a dialog); check the Recordly window";

	it("exports the not-responding message", () => {
		expect(helper.NOT_RESPONDING_MESSAGE).toBe(NOT_RESPONDING);
	});

	it("gives up on connect() when the server accepts but never answers", async () => {
		const control = await startSilentServer();
		const startedAt = Date.now();
		await expect(helper.connect({ control, timeoutMs: 150 })).rejects.toThrow(NOT_RESPONDING);
		expect(Date.now() - startedAt).toBeLessThan(2_000);
	});

	it("applies the timeout to status() and sources() but not to start()", async () => {
		// Answers connect()'s ping, then never answers status/sources; answers start only after
		// the quick timeout has passed (stop and start can legitimately take long).
		let statusCalls = 0;
		server = http.createServer((req, res) => {
			req.resume();
			const reply = (body: unknown) => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(body));
			};
			if (req.url === "/v1/status" && ++statusCalls === 1) {
				reply({ recording: false });
			} else if (req.url === "/v1/recording/start") {
				setTimeout(() => reply({ agentCursor: false }), 400);
			}
		});
		await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
		const control = { port: (server.address() as AddressInfo).port, token: "secret-token" };
		const client = await helper.connect({ control, timeoutMs: 150 });

		await expect(client.status()).rejects.toThrow(NOT_RESPONDING);
		await expect(client.sources()).rejects.toThrow(NOT_RESPONDING);
		await expect(client.start({ source: { display: 0 } })).resolves.toEqual({
			agentCursor: false,
		});
	});

	it("fails fast when no discovery file is live", async () => {
		await expect(
			helper.connect({
				env: {},
				appData: "C:\\nowhere",
				exists: () => false,
				readJson: () => undefined,
				isPidAlive: () => false,
			}),
		).rejects.toThrow(NOT_RUNNING);
	});

	describe("attachCursor", () => {
		interface FakeContext {
			bindings: Map<string, (source: unknown, raw: unknown) => unknown>;
			initScripts: unknown[];
		}

		function fakePage(): { page: unknown; context: FakeContext } {
			const context: FakeContext = { bindings: new Map(), initScripts: [] };
			const fakeContext = {
				exposeBinding: async (
					name: string,
					fn: (source: unknown, raw: unknown) => unknown,
				) => {
					context.bindings.set(name, fn);
				},
				addInitScript: async (script: unknown) => {
					context.initScripts.push(script);
				},
				pages: () => [],
			};
			return { page: { context: () => fakeContext }, context };
		}

		const metrics: Metrics = {
			screenX: 100,
			screenY: 50,
			outerWidth: 1456,
			innerWidth: 1440,
			outerHeight: 1030,
			innerHeight: 900,
		};

		function rawEvent(overrides: Record<string, unknown> = {}) {
			return {
				atMs: 1000,
				kind: "move",
				clientX: 10,
				clientY: 20,
				cursor: "pointer",
				metrics,
				...overrides,
			};
		}

		it("computes screen coordinates per event and posts batches with the correction", async () => {
			const control = await startFakeServer();
			respond = (req) => ({
				status: 200,
				body:
					req.url === "/v1/cursor-events"
						? {
								accepted: (req.body as { events: unknown[] }).events.length,
								rejected: [],
							}
						: {},
			});
			const client = await helper.connect({ control });
			const { page, context } = fakePage();
			const cursor = await client.attachCursor(page, { offsetX: 1, offsetY: 2, flushMs: 5 });

			expect(context.initScripts).toHaveLength(1);
			const [binding] = [...context.bindings.values()];
			// The window is nudged between the two events: the second must use the new position.
			await binding({}, rawEvent());
			await binding({}, rawEvent({ atMs: 1010, metrics: { ...metrics, screenX: 130 } }));
			await binding(
				{},
				rawEvent({ atMs: 1020, kind: "down", button: "right", cursor: undefined }),
			);
			await cursor.flush();

			const posts = requests.filter((req) => req.url === "/v1/cursor-events");
			const events = posts.flatMap((req) => (req.body as { events: unknown[] }).events);
			expect(events).toEqual([
				{ atMs: 1000, x: 119, y: 194, kind: "move", cursor: "pointer" },
				{ atMs: 1010, x: 149, y: 194, kind: "move", cursor: "pointer" },
				{ atMs: 1020, x: 119, y: 194, kind: "down", button: "right" },
			]);
			expect(cursor.stats()).toMatchObject({ sent: 3, accepted: 3, rejected: 0 });
			await cursor.detach();
		});

		it("treats a 409 on the final flush as done", async () => {
			const control = await startFakeServer();
			const client = await helper.connect({ control });
			const { page, context } = fakePage();
			const cursor = await client.attachCursor(page, { flushMs: 60_000 });
			const [binding] = [...context.bindings.values()];
			await binding({}, rawEvent());

			respond = () => ({
				status: 409,
				body: { error: { code: "conflict", message: "No agent-driven take is capturing" } },
			});
			await expect(cursor.detach()).resolves.toBeUndefined();
			expect(cursor.stats()).toMatchObject({ sent: 1, dropped409: 1 });
		});

		it("surfaces other flush errors from detach", async () => {
			const control = await startFakeServer();
			const client = await helper.connect({ control });
			const { page, context } = fakePage();
			const cursor = await client.attachCursor(page, { flushMs: 60_000 });
			const [binding] = [...context.bindings.values()];
			await binding({}, rawEvent());

			respond = () => ({
				status: 500,
				body: { error: { code: "internal", message: "boom" } },
			});
			await expect(cursor.detach()).rejects.toThrow("internal: boom");
		});

		it("ignores events that arrive after detach", async () => {
			const control = await startFakeServer();
			const client = await helper.connect({ control });
			const { page, context } = fakePage();
			const cursor = await client.attachCursor(page, { flushMs: 60_000 });
			const [binding] = [...context.bindings.values()];
			await cursor.detach();
			const before = requests.length;
			await binding({}, rawEvent());
			await cursor.flush();
			expect(requests.length).toBe(before);
		});
	});
});

describe("sizeWindowForViewport", () => {
	/**
	 * A fake page + CDP session. `maxWidth` clamps the window (a small display); `widthError` is
	 * added to the width of the Nth resize (display scaling landing a couple of px off; the last
	 * entry repeats); `staleReads` makes the first reads after a resize return the old size.
	 */
	function fakeWindow(opts: {
		chromeW: number;
		chromeH: number;
		maxWidth?: number;
		widthError?: number[];
		staleReads?: number;
	}) {
		const state = { outerW: 1000, outerH: 700, chromeW: opts.chromeW, chromeH: opts.chromeH };
		let stale: typeof state | undefined;
		let staleLeft = 0;
		let resizes = 0;
		let windowState = "maximized";
		const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
		const cdp = {
			send: async (method: string, params: Record<string, unknown> = {}) => {
				sent.push({ method, params });
				if (method === "Browser.getWindowForTarget") {
					return { windowId: 7, bounds: { windowState } };
				}
				const bounds = params.bounds as {
					width?: number;
					height?: number;
					windowState?: string;
				};
				if (bounds.windowState) {
					windowState = bounds.windowState;
				}
				if (bounds.width !== undefined && bounds.height !== undefined) {
					const errors = opts.widthError ?? [0];
					const error = errors[Math.min(resizes, errors.length - 1)];
					resizes += 1;
					stale = { ...state };
					staleLeft = opts.staleReads ?? 0;
					state.outerW = Math.min(bounds.width + error, opts.maxWidth ?? Infinity);
					state.outerH = bounds.height;
				}
				return {};
			},
			detach: async () => undefined,
		};
		const page = {
			context: () => ({ newCDPSession: async () => cdp }),
			evaluate: async () => {
				let view = state;
				if (stale && staleLeft > 0) {
					staleLeft -= 1;
					view = stale;
				}
				return {
					outerWidth: view.outerW,
					outerHeight: view.outerH,
					innerWidth: view.outerW - view.chromeW,
					innerHeight: view.outerH - view.chromeH,
				};
			},
		};
		return { page, sent };
	}

	const resizeCalls = (sent: Array<{ method: string; params: Record<string, unknown> }>) =>
		sent.filter(
			(call) =>
				call.method === "Browser.setWindowBounds" &&
				(call.params.bounds as { width?: number }).width !== undefined,
		);

	it("restores a normal window and sizes it so the viewport matches", async () => {
		const { page, sent } = fakeWindow({ chromeW: 16, chromeH: 130 });
		await expect(
			helper.sizeWindowForViewport(page, { width: 1440, height: 900 }),
		).resolves.toEqual({ width: 1440, height: 900 });
		const stateCall = sent.findIndex(
			(call) =>
				call.method === "Browser.setWindowBounds" &&
				(call.params.bounds as { windowState?: string }).windowState === "normal",
		);
		const sizeCall = sent.findIndex(
			(call) =>
				call.method === "Browser.setWindowBounds" &&
				(call.params.bounds as { width?: number }).width === 1456,
		);
		expect(stateCall).toBeGreaterThanOrEqual(0);
		expect(sizeCall).toBeGreaterThan(stateCall);
	});

	it("corrects a window that lands a couple of px off, without warning", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const { page, sent } = fakeWindow({ chromeW: 16, chromeH: 130, widthError: [2, 0] });
			await expect(
				helper.sizeWindowForViewport(page, { width: 1440, height: 900 }),
			).resolves.toEqual({ width: 1440, height: 900 });
			expect(resizeCalls(sent)).toHaveLength(2);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("waits for a resize to settle before judging the size", async () => {
		const { page } = fakeWindow({ chromeW: 16, chromeH: 130, staleReads: 1 });
		await expect(
			helper.sizeWindowForViewport(page, { width: 1440, height: 900 }),
		).resolves.toEqual({ width: 1440, height: 900 });
	});

	it("warns and returns the achieved size when stuck within 4px", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const { page } = fakeWindow({ chromeW: 16, chromeH: 130, widthError: [2] });
			await expect(
				helper.sizeWindowForViewport(page, { width: 1440, height: 900 }),
			).resolves.toEqual({ width: 1442, height: 900 });
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0][0])).toContain("1442×900");
		} finally {
			warn.mockRestore();
		}
	});

	it("throws a clear error when the display is too small", async () => {
		const { page } = fakeWindow({ chromeW: 16, chromeH: 130, maxWidth: 1200 });
		await expect(
			helper.sizeWindowForViewport(page, { width: 1440, height: 900 }),
		).rejects.toThrow(
			/Couldn't size the browser viewport to 1440×900 \(got 1184×900\); the display may be too small/,
		);
	});

	it("throws when the result is far off even if it keeps landing off", async () => {
		const { page } = fakeWindow({ chromeW: 16, chromeH: 130, widthError: [50] });
		await expect(
			helper.sizeWindowForViewport(page, { width: 1440, height: 900 }),
		).rejects.toThrow(/got 1490×900\); the display may be too small/);
	});
});
