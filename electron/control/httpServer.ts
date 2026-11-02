import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { AgentCursorInactiveError } from "../ipc/cursor/agentCursor";
import { checkControlRequest } from "./auth";
import {
	ControlError,
	type ControlErrorCode,
	type RecordingController,
	type StartOptions,
} from "./types";

export const MAX_CONTROL_BODY_BYTES = 1024 * 1024;

export type McpHandler = (
	req: IncomingMessage,
	res: ServerResponse,
	body: unknown,
) => Promise<void>;

export interface ControlServerOptions {
	port: number;
	token: string;
	controller: RecordingController;
	mcpHandler?: McpHandler;
}

export interface ControlServerHandle {
	port: number;
	close(): Promise<void>;
}

const STATUS_BY_CODE: Record<ControlErrorCode, number> = {
	bad_request: 400,
	not_found: 404,
	conflict: 409,
	timeout: 504,
	internal: 500,
};

class BodyTooLargeError extends Error {}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
	if (res.headersSent || res.writableEnded) {
		return;
	}
	const text = JSON.stringify(payload);
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.setHeader("Cache-Control", "no-store");
	res.setHeader("Content-Length", Buffer.byteLength(text));
	res.end(text);
}

function sendError(
	res: ServerResponse,
	status: number,
	code: ControlErrorCode | "unauthorized" | "forbidden",
	message: string,
	details?: unknown,
): void {
	sendJson(res, status, {
		error: { code, message, ...(details === undefined ? {} : { details }) },
	});
}

function sendControlError(res: ServerResponse, error: unknown): void {
	if (error instanceof ControlError) {
		sendError(res, STATUS_BY_CODE[error.code], error.code, error.message, error.details);
	} else if (error instanceof AgentCursorInactiveError) {
		sendError(res, 409, "conflict", error.message);
	} else if (error instanceof BodyTooLargeError) {
		sendError(res, 413, "bad_request", "Request body exceeds 1 MB");
	} else {
		sendError(
			res,
			500,
			"internal",
			error instanceof Error ? error.message : "Unexpected error",
		);
	}
}

/** Reads the whole body (to keep the connection sane) but rejects once it exceeds the limit. */
function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let tooLarge = false;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_CONTROL_BODY_BYTES) {
				tooLarge = true;
				chunks.length = 0;
				return;
			}
			if (!tooLarge) {
				chunks.push(chunk);
			}
		});
		req.on("end", () =>
			tooLarge
				? reject(new BodyTooLargeError())
				: resolve(Buffer.concat(chunks).toString("utf8")),
		);
		req.on("error", reject);
	});
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const text = await readBody(req);
	if (text.trim() === "") {
		return undefined;
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new ControlError("bad_request", "Request body is not valid JSON");
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function startControlServer(opts: ControlServerOptions): Promise<ControlServerHandle> {
	const { controller, token, mcpHandler } = opts;
	let listeningPort = opts.port;

	async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const auth = checkControlRequest(req.headers, { token, port: listeningPort });
		if (!auth.ok) {
			sendError(
				res,
				auth.status,
				auth.status === 401 ? "unauthorized" : "forbidden",
				auth.reason,
			);
			return;
		}

		const method = req.method ?? "GET";
		const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;

		if (pathname === "/mcp") {
			if (!mcpHandler || !["POST", "GET", "DELETE"].includes(method)) {
				sendError(res, 404, "not_found", "Not found");
				return;
			}
			const body = method === "POST" ? await readJsonBody(req) : undefined;
			await mcpHandler(req, res, body);
			return;
		}

		if (method === "GET" && pathname === "/v1/status") {
			sendJson(res, 200, controller.status());
			return;
		}
		if (method === "GET" && pathname === "/v1/sources") {
			sendJson(res, 200, { sources: await controller.listSources() });
			return;
		}

		if (method !== "POST") {
			sendError(res, 404, "not_found", "Not found");
			return;
		}

		switch (pathname) {
			case "/v1/recording/start": {
				const body = await readJsonBody(req);
				if (!isPlainObject(body)) {
					throw new ControlError("bad_request", "Request body must be a JSON object");
				}
				sendJson(res, 200, await controller.start(body as unknown as StartOptions));
				return;
			}
			case "/v1/recording/pause":
				await controller.pause();
				sendJson(res, 200, { ok: true });
				return;
			case "/v1/recording/resume":
				await controller.resume();
				sendJson(res, 200, { ok: true });
				return;
			case "/v1/recording/stop":
				sendJson(res, 200, await controller.stop());
				return;
			case "/v1/recording/cancel":
				await controller.cancel();
				sendJson(res, 200, { ok: true });
				return;
			case "/v1/cursor-events": {
				const body = await readJsonBody(req);
				const events = isPlainObject(body) ? body.events : undefined;
				sendJson(res, 200, controller.sendCursorEvents(events));
				return;
			}
			default:
				sendError(res, 404, "not_found", "Not found");
		}
	}

	const server = http.createServer((req, res) => {
		route(req, res).catch((error) => {
			if (res.headersSent) {
				console.warn("[control] handler failed after the response started:", error);
				res.destroy();
				return;
			}
			if (
				!(error instanceof ControlError) &&
				!(error instanceof AgentCursorInactiveError) &&
				!(error instanceof BodyTooLargeError)
			) {
				console.warn("[control] unexpected handler error:", error);
			}
			sendControlError(res, error);
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(opts.port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	listeningPort = (server.address() as AddressInfo).port;
	// A late socket error must never crash the main process.
	server.on("error", (error) => console.warn("[control] server error:", error));

	return {
		port: listeningPort,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}
