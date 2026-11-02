import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCursorInactiveError } from "../ipc/cursor/agentCursor";
import { startControlServer } from "./httpServer";
import { createMcpRequestHandler } from "./mcpServer";
import { ControlError, type RecordingController } from "./types";

// agentCursor.ts pulls in electron-backed state; the server only needs its error class.
vi.mock("electron", () => ({ app: { getPath: vi.fn(() => "/tmp") } }));

const TOKEN = "test-token";

const EXPECTED_TOOLS = [
	"recordly_cancel_recording",
	"recordly_list_sources",
	"recordly_pause_recording",
	"recordly_resume_recording",
	"recordly_send_cursor_events",
	"recordly_start_recording",
	"recordly_status",
	"recordly_stop_recording",
];

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
			source: { id: "window:9:0", name: "ORCA", kind: "window" as const },
			agentCursor: true,
			startedAtMs: 42,
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

let cleanups: Array<() => Promise<void>> = [];

async function boot(controller: RecordingController, token: string | null = TOKEN) {
	const server = await startControlServer({
		port: 0,
		token: TOKEN,
		controller,
		mcpHandler: createMcpRequestHandler(controller),
	});
	cleanups.push(server.close);
	const client = new Client({ name: "test-client", version: "1.0.0" });
	const transport = new StreamableHTTPClientTransport(
		new URL(`http://127.0.0.1:${server.port}/mcp`),
		{
			requestInit: {
				headers: token === null ? {} : { Authorization: `Bearer ${token}` },
			},
		},
	);
	cleanups.push(() => client.close());
	return { server, client, transport };
}

function textOf(result: unknown): string {
	const content = (result as { content: Array<{ type: string; text: string }> }).content;
	expect(content).toHaveLength(1);
	expect(content[0].type).toBe("text");
	return content[0].text;
}

afterEach(async () => {
	for (const cleanup of cleanups.reverse()) {
		await cleanup().catch(() => undefined);
	}
	cleanups = [];
});

describe("MCP endpoint", () => {
	it("lists the eight recordly tools", async () => {
		const { client, transport } = await boot(makeController());
		await client.connect(transport);
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOLS);
		for (const tool of tools) {
			expect(tool.description).toBeTruthy();
		}
		const start = tools.find((tool) => tool.name === "recordly_start_recording");
		expect(start?.description).toMatch(/ignore/i);
	});

	it("passes start arguments to the controller and returns its result as JSON text", async () => {
		const controller = makeController();
		const { client, transport } = await boot(controller);
		await client.connect(transport);
		const result = await client.callTool({
			name: "recordly_start_recording",
			arguments: { source: { windowTitle: "ORCA" }, agentCursor: true },
		});
		expect(result.isError).toBeFalsy();
		expect(controller.start).toHaveBeenCalledWith({
			source: { windowTitle: "ORCA" },
			agentCursor: true,
		});
		expect(JSON.parse(textOf(result))).toEqual({
			source: { id: "window:9:0", name: "ORCA", kind: "window" },
			agentCursor: true,
			startedAtMs: 42,
		});
	});

	it("returns status, sources, and {ok:true} for void actions", async () => {
		const controller = makeController();
		const { client, transport } = await boot(controller);
		await client.connect(transport);

		const status = await client.callTool({ name: "recordly_status", arguments: {} });
		expect(JSON.parse(textOf(status))).toMatchObject({ recording: false });

		const sources = await client.callTool({ name: "recordly_list_sources", arguments: {} });
		expect(JSON.parse(textOf(sources))).toEqual([
			{ id: "screen:1:0", name: "Screen 1", kind: "screen" },
		]);

		for (const name of [
			"recordly_pause_recording",
			"recordly_resume_recording",
			"recordly_cancel_recording",
		]) {
			const result = await client.callTool({ name, arguments: {} });
			expect(result.isError).toBeFalsy();
			expect(JSON.parse(textOf(result))).toEqual({ ok: true });
		}
		expect(controller.pause).toHaveBeenCalledTimes(1);
		expect(controller.resume).toHaveBeenCalledTimes(1);
		expect(controller.cancel).toHaveBeenCalledTimes(1);

		const stop = await client.callTool({ name: "recordly_stop_recording", arguments: {} });
		expect(JSON.parse(textOf(stop))).toEqual({ videoPath: "a.mp4", projectPath: "a.recordly" });
	});

	it("forwards cursor events to the controller", async () => {
		const controller = makeController();
		const { client, transport } = await boot(controller);
		await client.connect(transport);
		const events = [
			{ atMs: 10, x: 1, y: 2, kind: "move" },
			{ atMs: 20, x: 1, y: 2, kind: "down", button: "left" },
		];
		const result = await client.callTool({
			name: "recordly_send_cursor_events",
			arguments: { events },
		});
		expect(controller.sendCursorEvents).toHaveBeenCalledWith(events);
		expect(JSON.parse(textOf(result))).toEqual({ accepted: 1, rejected: [] });
	});

	it("reports a ControlError as an isError result containing the code", async () => {
		const controller = makeController({
			start: vi.fn(async () => {
				throw new ControlError("conflict", "Already recording");
			}),
		});
		const { client, transport } = await boot(controller);
		await client.connect(transport);
		const result = await client.callTool({
			name: "recordly_start_recording",
			arguments: { source: { display: 0 } },
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("conflict");
		expect(textOf(result)).toContain("Already recording");
	});

	it("maps AgentCursorInactiveError to conflict and unknown errors to internal", async () => {
		const controller = makeController({
			sendCursorEvents: vi.fn(() => {
				throw new AgentCursorInactiveError();
			}),
			stop: vi.fn(async () => {
				throw new Error("boom");
			}),
		});
		const { client, transport } = await boot(controller);
		await client.connect(transport);

		const cursor = await client.callTool({
			name: "recordly_send_cursor_events",
			arguments: { events: [] },
		});
		expect(cursor.isError).toBe(true);
		expect(textOf(cursor)).toMatch(/^conflict: /);

		const stop = await client.callTool({ name: "recordly_stop_recording", arguments: {} });
		expect(stop.isError).toBe(true);
		expect(textOf(stop)).toBe("internal: boom");
	});

	it("rejects malformed start arguments without calling the controller", async () => {
		const controller = makeController();
		const { client, transport } = await boot(controller);
		await client.connect(transport);
		const bad = [
			{ source: { windowTitle: "ORCA" }, countdownSeconds: 11 },
			{ source: {} },
			{ source: { display: 0, id: "x" } },
			{},
		];
		for (const args of bad) {
			let errored = false;
			try {
				const result = await client.callTool({
					name: "recordly_start_recording",
					arguments: args,
				});
				errored = result.isError === true;
			} catch {
				errored = true;
			}
			expect(errored).toBe(true);
		}
		expect(controller.start).not.toHaveBeenCalled();
	});

	it("answers an empty POST with a JSON-RPC 400 and GET with a non-5xx status", async () => {
		const { server } = await boot(makeController());
		const url = `http://127.0.0.1:${server.port}/mcp`;
		const headers = {
			Authorization: `Bearer ${TOKEN}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};
		const empty = await fetch(url, { method: "POST", headers });
		expect(empty.status).toBe(400);
		expect((await empty.json()).error.code).toBe(-32700);

		const get = await fetch(url, { method: "GET", headers });
		expect(get.status).toBeLessThan(500);
		await get.body?.cancel();
	});

	it("refuses a client without the token (401)", async () => {
		const { client, transport } = await boot(makeController(), null);
		await expect(client.connect(transport)).rejects.toMatchObject({ code: 401 });
	});
});
