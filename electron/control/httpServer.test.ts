import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCursorInactiveError } from "../ipc/cursor/agentCursor";
import { startControlServer } from "./httpServer";
import { ControlError, type RecordingController } from "./types";

// agentCursor.ts pulls in electron-backed state; the server only needs its error class.
vi.mock("electron", () => ({ app: { getPath: vi.fn(() => "/tmp") } }));

const TOKEN = "test-token";

function makeController(overrides: Partial<RecordingController> = {}) {
	const controller = {
		status: vi.fn(() => ({
			recording: false,
			paused: false,
			agentCursor: false,
			source: null,
			lastTake: null,
		})),
		listSources: vi.fn(async () => [
			{ id: "screen:1:0", name: "Screen 1", kind: "screen" as const },
		]),
		start: vi.fn(async () => ({
			source: { id: "screen:1:0", name: "Screen 1", kind: "screen" as const },
			agentCursor: false,
			startedAtMs: 1,
		})),
		pause: vi.fn(async () => {}),
		resume: vi.fn(async () => {}),
		stop: vi.fn(async () => ({ videoPath: "a.mp4", projectPath: "a.recordly" })),
		cancel: vi.fn(async () => {}),
		sendCursorEvents: vi.fn(() => ({ accepted: 1, rejected: [] })),
		...overrides,
	};
	return controller satisfies RecordingController;
}

let closers: Array<() => Promise<void>> = [];

async function boot(
	controller: RecordingController,
	mcpHandler?: (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void>,
) {
	const server = await startControlServer({ port: 0, token: TOKEN, controller, mcpHandler });
	closers.push(server.close);
	const base = `http://127.0.0.1:${server.port}`;
	const call = (path: string, init: RequestInit = {}, auth = true) =>
		fetch(base + path, {
			...init,
			headers: {
				...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}),
				...(init.body ? { "Content-Type": "application/json" } : {}),
				...(init.headers as Record<string, string> | undefined),
			},
		});
	return { server, base, call };
}

afterEach(async () => {
	await Promise.all(closers.map((close) => close()));
	closers = [];
});

describe("control http server", () => {
	it("returns 401 without a token", async () => {
		const { call } = await boot(makeController());
		const res = await call("/v1/status", {}, false);
		expect(res.status).toBe(401);
		expect((await res.json()).error).toBeDefined();
	});

	it("refuses requests carrying an Origin header", async () => {
		const { call } = await boot(makeController());
		// fetch forbids setting Origin in browsers, but Node's undici allows it.
		const res = await call("/v1/status", { headers: { Origin: "http://evil.example" } });
		expect(res.status).toBe(403);
	});

	it("returns the controller status", async () => {
		const controller = makeController();
		const { call } = await boot(controller);
		const res = await call("/v1/status");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(controller.status());
	});

	it("lists sources", async () => {
		const { call } = await boot(makeController());
		const res = await call("/v1/sources");
		expect(await res.json()).toEqual({
			sources: [{ id: "screen:1:0", name: "Screen 1", kind: "screen" }],
		});
	});

	it("passes the parsed body to controller.start", async () => {
		const controller = makeController();
		const { call } = await boot(controller);
		const body = { source: { display: 0 }, agentCursor: true };
		const res = await call("/v1/recording/start", {
			method: "POST",
			body: JSON.stringify(body),
		});
		expect(res.status).toBe(200);
		expect(controller.start).toHaveBeenCalledWith(body);
		expect((await res.json()).startedAtMs).toBe(1);
	});

	it("routes pause, resume, stop and cancel", async () => {
		const controller = makeController();
		const { call } = await boot(controller);
		for (const action of ["pause", "resume", "stop", "cancel"] as const) {
			const res = await call(`/v1/recording/${action}`, { method: "POST" });
			expect(res.status).toBe(200);
			expect(controller[action]).toHaveBeenCalledTimes(1);
		}
	});

	it("maps ControlError codes to statuses", async () => {
		const table: Array<[ConstructorParameters<typeof ControlError>[0], number]> = [
			["bad_request", 400],
			["not_found", 404],
			["conflict", 409],
			["timeout", 504],
			["internal", 500],
		];
		for (const [code, status] of table) {
			const controller = makeController({
				stop: vi.fn(async () => {
					throw new ControlError(code, "nope", { hint: 1 });
				}),
			});
			const { call } = await boot(controller);
			const res = await call("/v1/recording/stop", { method: "POST" });
			expect(res.status).toBe(status);
			expect(await res.json()).toEqual({
				error: { code, message: "nope", details: { hint: 1 } },
			});
		}
	});

	it("maps unexpected exceptions to a 500 internal error", async () => {
		const { call } = await boot(
			makeController({
				pause: vi.fn(async () => {
					throw new Error("boom");
				}),
			}),
		);
		const res = await call("/v1/recording/pause", { method: "POST" });
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: { code: "internal", message: "boom" } });
	});

	it("maps AgentCursorInactiveError from cursor events to 409", async () => {
		const controller = makeController({
			sendCursorEvents: vi.fn(() => {
				throw new AgentCursorInactiveError();
			}),
		});
		const { call } = await boot(controller);
		const res = await call("/v1/cursor-events", {
			method: "POST",
			body: JSON.stringify({ events: [] }),
		});
		expect(res.status).toBe(409);
		expect((await res.json()).error.code).toBe("conflict");
	});

	it("passes body.events to sendCursorEvents and returns the ingest result", async () => {
		const controller = makeController();
		const { call } = await boot(controller);
		const events = [{ atMs: 1, x: 2, y: 3, kind: "move" }];
		const res = await call("/v1/cursor-events", {
			method: "POST",
			body: JSON.stringify({ events }),
		});
		expect(res.status).toBe(200);
		expect(controller.sendCursorEvents).toHaveBeenCalledWith(events);
		expect(await res.json()).toEqual({ accepted: 1, rejected: [] });
	});

	it("returns 400 for invalid JSON", async () => {
		const controller = makeController();
		const { call } = await boot(controller);
		const res = await call("/v1/recording/start", { method: "POST", body: "{not json" });
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe("bad_request");
		expect(controller.start).not.toHaveBeenCalled();
	});

	it("returns 413 for bodies over 1 MB", async () => {
		const { call } = await boot(makeController());
		const res = await call("/v1/cursor-events", {
			method: "POST",
			body: JSON.stringify({ events: [], pad: "x".repeat(1024 * 1024 + 10) }),
		});
		expect(res.status).toBe(413);
	});

	it("returns 404 for unknown routes and wrong methods", async () => {
		const { call } = await boot(makeController());
		expect((await call("/v1/nope")).status).toBe(404);
		expect((await call("/v1/status", { method: "POST" })).status).toBe(404);
	});

	it("returns 404 for /mcp without a handler", async () => {
		const { call } = await boot(makeController());
		expect((await call("/mcp", { method: "POST", body: "{}" })).status).toBe(404);
	});

	it("delegates /mcp to the handler with the parsed body, behind auth", async () => {
		const mcpHandler = vi.fn(
			async (_req: IncomingMessage, res: ServerResponse, body: unknown) => {
				res.statusCode = 200;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ echoed: body }));
			},
		);
		const { call } = await boot(makeController(), mcpHandler);
		expect((await call("/mcp", { method: "POST", body: "{}" }, false)).status).toBe(401);
		const res = await call("/mcp", { method: "POST", body: JSON.stringify({ a: 1 }) });
		expect(await res.json()).toEqual({ echoed: { a: 1 } });
		await call("/mcp", { method: "GET" });
		expect(mcpHandler.mock.calls[1][2]).toBeUndefined();
	});

	it("survives an mcpHandler that throws", async () => {
		const { call } = await boot(
			makeController(),
			vi.fn(async () => {
				throw new Error("mcp broke");
			}),
		);
		const res = await call("/mcp", { method: "POST", body: "{}" });
		expect(res.status).toBe(500);
		expect((await call("/v1/status")).status).toBe(200);
	});

	it("frees the port on close", async () => {
		const { server } = await boot(makeController());
		const port = server.port;
		await server.close();
		await expect(fetch(`http://127.0.0.1:${port}/v1/status`)).rejects.toThrow();
		const again = await startControlServer({
			port,
			token: TOKEN,
			controller: makeController(),
		});
		expect(again.port).toBe(port);
		await again.close();
	});
});
