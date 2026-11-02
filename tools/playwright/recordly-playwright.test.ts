import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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
	start(options: unknown): Promise<unknown>;
	stop(): Promise<unknown>;
	attachCursor(page: unknown, options?: Record<string, unknown>): Promise<CursorHandle>;
}

interface Helper {
	NOT_RUNNING_MESSAGE: string;
	resolveControlFile(options: {
		env: Record<string, string | undefined>;
		appData: string;
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
	sizeWindowForViewport(page: unknown, size: { width: number; height: number }): Promise<void>;
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
	/** A fake page + CDP session whose window obeys `minWidth` (a small display clamps it). */
	function fakeWindow(opts: { chromeW: number; chromeH: number; maxWidth?: number }) {
		const state = { outerW: 1000, outerH: 700, chromeW: opts.chromeW, chromeH: opts.chromeH };
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
					state.outerW = Math.min(bounds.width, opts.maxWidth ?? Infinity);
					state.outerH = bounds.height;
				}
				return {};
			},
			detach: async () => undefined,
		};
		const page = {
			context: () => ({ newCDPSession: async () => cdp }),
			evaluate: async () => ({
				outerWidth: state.outerW,
				outerHeight: state.outerH,
				innerWidth: state.outerW - state.chromeW,
				innerHeight: state.outerH - state.chromeH,
			}),
		};
		return { page, sent };
	}

	it("restores a normal window and sizes it so the viewport matches", async () => {
		const { page, sent } = fakeWindow({ chromeW: 16, chromeH: 130 });
		await helper.sizeWindowForViewport(page, { width: 1440, height: 900 });
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

	it("throws a clear error when the display is too small", async () => {
		const { page } = fakeWindow({ chromeW: 16, chromeH: 130, maxWidth: 1200 });
		await expect(
			helper.sizeWindowForViewport(page, { width: 1440, height: 900 }),
		).rejects.toThrow(
			/Couldn't size the browser viewport to 1440×900 \(got 1184×900\); the display may be too small/,
		);
	});
});
