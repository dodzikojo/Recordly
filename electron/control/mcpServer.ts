import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { AgentCursorInactiveError } from "../ipc/cursor/agentCursor";
import { ControlError, type RecordingController, type StartOptions } from "./types";

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
};

const sourceSchema = z.union([
	z.strictObject({
		id: z.string().min(1).describe("Capture source id from recordly_list_sources"),
	}),
	z.strictObject({ display: z.number().int().min(0).describe("0-based screen index") }),
	z.strictObject({
		windowTitle: z
			.string()
			.min(1)
			.describe("Substring of the window title; must match exactly one window"),
	}),
]);

const cursorEventSchema = z.strictObject({
	atMs: z.number().describe("Milliseconds since the take started"),
	x: z.number().describe("Screen x coordinate"),
	y: z.number().describe("Screen y coordinate"),
	kind: z.enum(["move", "down", "up"]),
	button: z.enum(["left", "right", "middle"]).optional(),
	cursor: z.string().optional().describe("CSS cursor name, e.g. pointer or text"),
});

function textResult(value: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function errorResult(text: string): ToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

function describeError(error: unknown): ToolResult {
	if (error instanceof ControlError) {
		const details = error.details === undefined ? "" : ` ${JSON.stringify(error.details)}`;
		return errorResult(`${error.code}: ${error.message}${details}`);
	}
	if (error instanceof AgentCursorInactiveError) {
		return errorResult(`conflict: ${error.message}`);
	}
	return errorResult(`internal: ${error instanceof Error ? error.message : String(error)}`);
}

/** Runs a controller call and converts any throw into an isError result; never rejects. */
async function run(action: () => unknown): Promise<ToolResult> {
	try {
		const result = await action();
		return textResult(result === undefined ? { ok: true } : result);
	} catch (error) {
		return describeError(error);
	}
}

function createServer(controller: RecordingController): McpServer {
	const server = new McpServer({ name: "recordly", version: "1.0.0" });

	server.registerTool(
		"recordly_status",
		{
			description:
				"Report whether Recordly is recording, paused, and the last take's output paths.",
		},
		() => run(() => controller.status()),
	);

	server.registerTool(
		"recordly_list_sources",
		{ description: "List the screens and windows Recordly can capture." },
		() => run(() => controller.listSources()),
	);

	server.registerTool(
		"recordly_start_recording",
		{
			description:
				"Start a recording of one screen or window. Set agentCursor to true when a script drives the cursor: Recordly then ignores the real mouse and uses recordly_send_cursor_events instead.",
			inputSchema: {
				source: sourceSchema,
				agentCursor: z.boolean().optional(),
				countdownSeconds: z.number().min(0).max(10).optional(),
			},
		},
		(args) => run(() => controller.start(args as StartOptions)),
	);

	server.registerTool(
		"recordly_pause_recording",
		{ description: "Pause the current recording." },
		() => run(() => controller.pause()),
	);

	server.registerTool(
		"recordly_resume_recording",
		{ description: "Resume a paused recording." },
		() => run(() => controller.resume()),
	);

	server.registerTool(
		"recordly_stop_recording",
		{
			description:
				"Stop the current recording and save it; returns the video and project paths.",
		},
		() => run(() => controller.stop()),
	);

	server.registerTool(
		"recordly_cancel_recording",
		{ description: "Cancel the current recording and discard its footage." },
		() => run(() => controller.cancel()),
	);

	server.registerTool(
		"recordly_send_cursor_events",
		{
			description:
				"Send scripted cursor events (move, down, up) for an agent-driven recording started with agentCursor true.",
			inputSchema: { events: z.array(cursorEventSchema).max(1000) },
		},
		(args) => run(() => controller.sendCursorEvents(args.events)),
	);

	return server;
}

function sendJsonRpcError(
	res: ServerResponse,
	status: number,
	code: number,
	message: string,
): void {
	if (res.headersSent || res.writableEnded) {
		return;
	}
	const text = JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.setHeader("Content-Length", Buffer.byteLength(text));
	res.end(text);
}

/**
 * Stateless Streamable HTTP: every request gets its own McpServer and transport, closed when the
 * response closes. The handler never throws; a failure before headers go out becomes a 500.
 */
export function createMcpRequestHandler(
	controller: RecordingController,
): (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void> {
	return async (req, res, body) => {
		try {
			if (req.method === "POST" && body === undefined) {
				// The control server already consumed the stream; the SDK cannot re-read it.
				sendJsonRpcError(res, 400, -32700, "Parse error: empty request body");
				return;
			}
			const server = createServer(controller);
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
			res.on("close", () => {
				void transport.close().catch(() => undefined);
				void server.close().catch(() => undefined);
			});
			await server.connect(transport);
			await transport.handleRequest(req, res, body);
		} catch (error) {
			console.warn("[control] MCP request failed:", error);
			if (res.headersSent) {
				res.destroy();
				return;
			}
			sendJsonRpcError(res, 500, -32603, "Internal server error");
		}
	};
}
