import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CONTROL_DISCOVERY_FILE,
	DEFAULT_CONTROL_PORT,
	removeDiscoveryFile,
	resolveControlConfig,
	writeDiscoveryFile,
} from "./config";

describe("resolveControlConfig", () => {
	it("is disabled by default on the default port", () => {
		expect(resolveControlConfig({}, [])).toEqual({ enabled: false, port: 47821 });
		expect(DEFAULT_CONTROL_PORT).toBe(47821);
	});

	it("is enabled by RECORDLY_CONTROL=1", () => {
		expect(resolveControlConfig({ RECORDLY_CONTROL: "1" }, []).enabled).toBe(true);
	});

	it("is not enabled by other RECORDLY_CONTROL values", () => {
		expect(resolveControlConfig({ RECORDLY_CONTROL: "0" }, []).enabled).toBe(false);
		expect(resolveControlConfig({ RECORDLY_CONTROL: "" }, []).enabled).toBe(false);
	});

	it("is enabled by the --control argument", () => {
		expect(resolveControlConfig({}, ["electron.exe", ".", "--control"]).enabled).toBe(true);
	});

	it("honours RECORDLY_CONTROL_PORT", () => {
		expect(resolveControlConfig({ RECORDLY_CONTROL_PORT: "50000" }, []).port).toBe(50000);
	});

	it("falls back to the default port for invalid values", () => {
		for (const value of ["abc", "70000", "0", "-5", "1.5", ""]) {
			expect(resolveControlConfig({ RECORDLY_CONTROL_PORT: value }, []).port).toBe(47821);
		}
	});
});

describe("discovery file", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-control-"));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("round-trips port, token and pid", async () => {
		const file = await writeDiscoveryFile(dir, { port: 50000, token: "abc", pid: 1234 });
		expect(path.basename(file)).toBe(CONTROL_DISCOVERY_FILE);
		expect(CONTROL_DISCOVERY_FILE).toBe("control-server.json");
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
			port: 50000,
			token: "abc",
			pid: 1234,
		});
	});

	it("removes the file and tolerates a missing one", async () => {
		const file = await writeDiscoveryFile(dir, { port: 1, token: "t", pid: 2 });
		await removeDiscoveryFile(dir);
		await expect(fs.access(file)).rejects.toThrow();
		await expect(removeDiscoveryFile(dir)).resolves.toBeUndefined();
	});

	it.skipIf(process.platform === "win32")(
		"writes the token owner-only, even over a stale file",
		async () => {
			const stale = path.join(dir, CONTROL_DISCOVERY_FILE);
			await fs.writeFile(stale, "old", { mode: 0o644 });
			const file = await writeDiscoveryFile(dir, { port: 1, token: "t", pid: 2 });
			expect((await fs.stat(file)).mode & 0o077).toBe(0);
			expect((await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		},
	);

	it("overwrites an existing discovery file", async () => {
		await writeDiscoveryFile(dir, { port: 1, token: "old", pid: 2 });
		const file = await writeDiscoveryFile(dir, { port: 3, token: "new", pid: 4 });
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
			port: 3,
			token: "new",
			pid: 4,
		});
	});

	it("creates the directory if needed", async () => {
		const nested = path.join(dir, "nested");
		const file = await writeDiscoveryFile(nested, { port: 1, token: "t", pid: 2 });
		expect(JSON.parse(await fs.readFile(file, "utf8")).port).toBe(1);
	});
});
