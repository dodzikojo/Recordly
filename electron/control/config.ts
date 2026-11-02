import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const CONTROL_DISCOVERY_FILE = "control-server.json";
export const DEFAULT_CONTROL_PORT = 47821;

export interface ControlConfig {
	enabled: boolean;
	port: number;
}

function parsePort(value: string | undefined): number {
	if (value === undefined || !/^\d+$/.test(value.trim())) {
		return DEFAULT_CONTROL_PORT;
	}
	const port = Number(value.trim());
	return port >= 1 && port <= 65535 ? port : DEFAULT_CONTROL_PORT;
}

/** The control server is off unless RECORDLY_CONTROL=1 or --control is present. */
export function resolveControlConfig(env: NodeJS.ProcessEnv, argv: string[]): ControlConfig {
	return {
		enabled: env.RECORDLY_CONTROL === "1" || argv.includes("--control"),
		port: parsePort(env.RECORDLY_CONTROL_PORT),
	};
}

export async function writeDiscoveryFile(
	dir: string,
	info: { port: number; token: string; pid: number },
): Promise<string> {
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const file = path.join(dir, CONTROL_DISCOVERY_FILE);
	// The file holds the bearer token: write it owner-only to a temp file, then rename over the
	// target. A stale file with looser permissions is replaced, not reused (mode only applies on
	// creation). rename replaces an existing file on Windows too.
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		await fs.writeFile(
			tmp,
			JSON.stringify({ port: info.port, token: info.token, pid: info.pid }),
			{ encoding: "utf8", mode: 0o600 },
		);
		await fs.rename(tmp, file);
	} catch (error) {
		await fs.rm(tmp, { force: true }).catch(() => undefined);
		throw error;
	}
	return file;
}

export async function removeDiscoveryFile(dir: string): Promise<void> {
	await fs.rm(path.join(dir, CONTROL_DISCOVERY_FILE), { force: true });
}
