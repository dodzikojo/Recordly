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
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, CONTROL_DISCOVERY_FILE);
	await fs.writeFile(
		file,
		JSON.stringify({ port: info.port, token: info.token, pid: info.pid }),
		"utf8",
	);
	return file;
}

export async function removeDiscoveryFile(dir: string): Promise<void> {
	await fs.rm(path.join(dir, CONTROL_DISCOVERY_FILE), { force: true });
}
