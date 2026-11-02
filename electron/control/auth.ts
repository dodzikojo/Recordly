import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export type ControlAuthResult = { ok: true } | { ok: false; status: 401 | 403; reason: string };

function tokensMatch(provided: string, expected: string): boolean {
	const a = Buffer.from(provided, "utf8");
	const b = Buffer.from(expected, "utf8");
	// timingSafeEqual requires equal lengths; a length mismatch is rejected up front.
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Origin and Host are checked before the token so that browser-originated requests
 * (CSRF / DNS rebinding) are refused regardless of whether they guessed a token.
 */
export function checkControlRequest(
	headers: IncomingHttpHeaders,
	expected: { token: string; port: number },
): ControlAuthResult {
	if (headers.origin !== undefined) {
		return { ok: false, status: 403, reason: "Requests with an Origin header are refused" };
	}

	const host = typeof headers.host === "string" ? headers.host.toLowerCase() : "";
	if (host !== `127.0.0.1:${expected.port}` && host !== `localhost:${expected.port}`) {
		return { ok: false, status: 403, reason: "Host header not allowed" };
	}

	const authorization = headers.authorization;
	const prefix = "Bearer ";
	if (typeof authorization !== "string" || !authorization.startsWith(prefix)) {
		return { ok: false, status: 401, reason: "Missing bearer token" };
	}
	if (!tokensMatch(authorization.slice(prefix.length), expected.token)) {
		return { ok: false, status: 401, reason: "Invalid bearer token" };
	}

	return { ok: true };
}
