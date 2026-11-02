import { describe, expect, it } from "vitest";
import { checkControlRequest } from "./auth";

const expected = { token: "secret-token", port: 47821 };
const good = { host: "127.0.0.1:47821", authorization: "Bearer secret-token" };

describe("checkControlRequest", () => {
	it("rejects a missing token with 401", () => {
		expect(checkControlRequest({ host: "127.0.0.1:47821" }, expected)).toMatchObject({
			ok: false,
			status: 401,
		});
	});

	it("rejects a wrong token with 401", () => {
		for (const authorization of [
			"Bearer nope",
			"Bearer secret-token-longer",
			"Bearer ",
			"secret-token",
			"Basic secret-token",
		]) {
			expect(checkControlRequest({ ...good, authorization }, expected)).toMatchObject({
				ok: false,
				status: 401,
			});
		}
	});

	it("accepts the right token with 127.0.0.1 or localhost host", () => {
		expect(checkControlRequest(good, expected)).toEqual({ ok: true });
		expect(checkControlRequest({ ...good, host: "localhost:47821" }, expected)).toEqual({
			ok: true,
		});
	});

	it("rejects other hosts and ports with 403", () => {
		for (const host of ["evil.example:47821", "127.0.0.1:1", "127.0.0.1", undefined]) {
			expect(checkControlRequest({ ...good, host }, expected)).toMatchObject({
				ok: false,
				status: 403,
			});
		}
	});

	it("rejects any Origin header with 403, even a same-origin one", () => {
		for (const origin of ["http://127.0.0.1:47821", "https://evil.example", "null"]) {
			expect(checkControlRequest({ ...good, origin }, expected)).toMatchObject({
				ok: false,
				status: 403,
			});
		}
	});

	it("checks origin and host before the token", () => {
		expect(
			checkControlRequest({ host: "evil.example:47821", origin: "x" }, expected),
		).toMatchObject({ ok: false, status: 403 });
	});
});
