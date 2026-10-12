import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, flagOn, version, viewerUrl } from "./config.ts";
import { DailiesServer } from "./server.ts";
import type { AmendInput, RetractInput, Store } from "./store.ts";

type Env = Record<string, string | undefined>;

export interface Health {
	ok: boolean;
	version: string;
	pid: number;
	viewers: number;
	home: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function health(base: string, timeoutMs = 1500): Promise<Health | undefined> {
	try {
		const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
		if (!response.ok) return undefined;
		return (await response.json()) as Health;
	} catch {
		return undefined;
	}
}

export class ApiError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export async function api<T>(base: string, path: string, body?: unknown): Promise<T> {
	const response = await fetch(`${base}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});
	const data = (await response.json().catch(() => ({}))) as T & { error?: string };
	if (!response.ok) throw new ApiError(response.status, data.error ?? `${path}: HTTP ${response.status}`);
	return data;
}

// Next to this file: cli.ts when Node runs the sources, cli.js in a build.
const CLI = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./cli.ts" : "./cli.js", import.meta.url));

/** Starts `serve` in the background, detached, logging to server.log. */
function startViewer(store: Store, env: Env): void {
	mkdirSync(store.home, { recursive: true });
	const log = openSync(join(store.home, "server.log"), "a");
	const child = spawn(process.execPath, [...process.execArgv, CLI, "serve"], {
		detached: true,
		stdio: ["ignore", log, log],
		env: { ...process.env, ...env },
	});
	child.unref();
}

/**
 * The running viewer's address, starting it (or replacing an older one) when needed.
 * Undefined when it cannot run; then the CLI records into the store itself.
 */
export async function ensureViewer(store: Store, env: Env = process.env): Promise<string | undefined> {
	const base = viewerUrl(env);
	const running = await health(base);
	if (running) {
		if (running.home !== store.home) return base; // someone else's viewer on our port: still talk to it
		if (compareVersions(version(), running.version) <= 0) return base;
		await api(base, "/api/shutdown", { version: version() }).catch(() => undefined);
		for (let tries = 0; tries < 40 && (await health(base, 300)); tries++) await sleep(100);
	}
	startViewer(store, env);
	for (let tries = 0; tries < 80; tries++) {
		await sleep(tries < 10 ? 50 : 100);
		if (await health(base, 500)) return base;
	}
	return undefined;
}

/** POSTs to the viewer, or, when it does not run, applies the same write in this process. */
export async function write<T>(store: Store, base: string | undefined, path: string, body: unknown): Promise<T> {
	if (base) return api<T>(base, path, body);
	const local = new DailiesServer(store);
	const input = body as Record<string, unknown>;
	const by = input.by === "human" ? "human" : "agent";
	try {
		switch (path) {
			case "/api/posts": {
				const post = local.addPost(input as never);
				return { post, viewers: 0, url: `${viewerUrl()}/#${post.id}` } as T;
			}
			case "/api/comments":
				return local.addComment(String(input.post), input.item ? String(input.item) : undefined, String(input.text ?? ""), by) as T;
			case "/api/issues":
				return local.setIssue(input) as T;
			case "/api/amend": {
				const result = local.amend({ ...(input as unknown as AmendInput), by });
				return { ...result, url: `${viewerUrl()}/#${result.post.id}` } as T;
			}
			case "/api/retract":
				return local.retract({ ...(input as unknown as RetractInput), by }) as T;
		}
	} catch (error) {
		const status = (error as { status?: number }).status ?? 500;
		throw new ApiError(status, (error as Error).message);
	}
	throw new Error(`cannot ${path} without the viewer`);
}

export function openBrowser(url: string, env: Env = process.env): boolean {
	if (flagOn(env.KUSTOMAD_NO_OPEN)) return false;
	let command: string;
	let args: string[];
	if (env.KUSTOMAD_BROWSER) {
		command = "sh";
		args = ["-c", `${env.KUSTOMAD_BROWSER} "$1"`, "sh", url];
	} else if (process.platform === "darwin") {
		command = "open";
		args = [url];
	} else if (process.platform === "win32") {
		command = "cmd";
		args = ["/c", "start", "", url];
	} else {
		command = "xdg-open";
		args = [url];
	}
	try {
		const child = spawn(command, args, { detached: true, stdio: "ignore" });
		child.on("error", () => undefined);
		child.unref();
		return true;
	} catch {
		return false;
	}
}

/**
 * Follows a server-sent event stream until `onEvent` returns true or the time runs out;
 * reconnects (starting the viewer again) if it goes away. Resolves true when stopped by an event.
 */
export async function follow(
	store: Store,
	path: string,
	onEvent: (type: string, data: unknown) => boolean | Promise<boolean>,
	options: { timeoutMs: number; env?: Env; onConnect?: () => boolean | Promise<boolean> },
): Promise<boolean> {
	const deadline = Date.now() + options.timeoutMs;
	while (Date.now() < deadline) {
		const base = await ensureViewer(store, options.env);
		if (!base) {
			await sleep(2000);
			continue;
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
		try {
			const response = await fetch(`${base}${path}`, { signal: controller.signal });
			if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let connected = false;
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let end: number;
				while ((end = buffer.indexOf("\n\n")) >= 0) {
					const block = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					const type = /^event: (.*)$/m.exec(block)?.[1];
					const data = /^data: (.*)$/m.exec(block)?.[1];
					if (!type) continue;
					if (type === "hello" && !connected) {
						connected = true;
						// Something may have arrived before we listened.
						if (options.onConnect && (await options.onConnect())) {
							controller.abort();
							return true;
						}
						continue;
					}
					let parsed: unknown = undefined;
					try {
						parsed = data ? JSON.parse(data) : undefined;
					} catch {
						parsed = data;
					}
					if (await onEvent(type, parsed)) {
						controller.abort();
						return true;
					}
				}
			}
		} catch (error) {
			if (Date.now() >= deadline) break;
			if ((error as Error).name !== "AbortError") await sleep(1000);
		} finally {
			clearTimeout(timer);
		}
	}
	return false;
}
