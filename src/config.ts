import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const NAME = "kustomad";
/** The name before the rename: its folders are still used until the new ones exist. */
const LEGACY_NAME = "agents-dailies";
export const DEFAULT_PORT = 4778;

/** The checkout this code runs from: the plugin root, or the package root. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type Env = Record<string, string | undefined>;

let cachedVersion: string | undefined;

export function version(): string {
	if (!cachedVersion) {
		try {
			cachedVersion = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
		} catch {
			cachedVersion = "0.0.0";
		}
	}
	return cachedVersion;
}

/** Compares dotted versions numerically: > 0 when `a` is newer. */
export function compareVersions(a: string, b: string): number {
	const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
	const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference) return difference;
	}
	return 0;
}

export function storeHome(env: Env = process.env): string {
	if (env.KUSTOMAD_HOME) return env.KUSTOMAD_HOME;
	const data = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
	return named(data);
}

/** `<base>/kustomad`, or the folder from before the rename while only that one exists. */
function named(base: string): string {
	const current = join(base, NAME);
	const legacy = join(base, LEGACY_NAME);
	return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

export function viewerPort(env: Env = process.env): number {
	const port = Number(env.KUSTOMAD_PORT);
	return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

export function viewerHost(env: Env = process.env): string {
	return env.KUSTOMAD_HOST || "127.0.0.1";
}

/** The address the CLI talks to: a wildcard bind is still reached on loopback. */
export function viewerUrl(env: Env = process.env): string {
	const host = viewerHost(env);
	const reach = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
	return `http://${reach.includes(":") ? `[${reach}]` : reach}:${viewerPort(env)}`;
}

/** A short, file-name-safe name for this machine: each machine appends to its own log. */
export function machineName(env: Env = process.env): string {
	const name = (env.KUSTOMAD_MACHINE || hostname() || "machine").toLowerCase().replace(/\.local$/, "");
	return name.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "machine";
}

export function flagOff(value: string | undefined): boolean {
	return value === "0" || value === "false" || value === "no" || value === "off";
}

export function flagOn(value: string | undefined): boolean {
	return Boolean(value) && !flagOff(value);
}

export interface UserConfig {
	issueCommand?: string;
	projects?: Record<string, { issueCommand?: string }>;
}

export function configPath(env: Env = process.env): string {
	if (env.KUSTOMAD_CONFIG) return env.KUSTOMAD_CONFIG;
	const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
	return join(named(base), "config.json");
}

/** The user's own config. A repository never supplies one, so it cannot make us run commands. */
export function readConfig(env: Env = process.env): UserConfig {
	try {
		const parsed = JSON.parse(readFileSync(configPath(env), "utf8")) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as UserConfig) : {};
	} catch {
		return {};
	}
}
