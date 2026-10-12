import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { compareVersions, ROOT, version } from "./config.ts";
import { ISSUE_KEY } from "./issues.ts";
import { mimeOfExt, needsTranscode } from "./media.ts";
import {
	buildAmend,
	buildIdea,
	buildIdeaChange,
	buildPost,
	buildRetract,
	newId,
	safeName,
	type AmendInput,
	type AnswerEvent,
	type Author,
	type Catalog,
	type CommentEvent,
	type DailiesEvent,
	type IdeaChangeInput,
	type IdeaInput,
	type IdeaView,
	type IssueEvent,
	type Item,
	type ListFilter,
	type PostInput,
	type RetractInput,
	type Selection,
	type Store,
	type Verdict,
	type VerdictEvent,
	isIdeaStatus,
} from "./store.ts";

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

const WEB = join(ROOT, "web");
const STATIC: Record<string, [string, string]> = {
	"/": ["index.html", "text/html; charset=utf-8"],
	"/index.html": ["index.html", "text/html; charset=utf-8"],
	"/app.js": ["app.js", "text/javascript; charset=utf-8"],
	"/i18n.js": ["i18n.js", "text/javascript; charset=utf-8"],
	"/style.css": ["style.css", "text/css; charset=utf-8"],
	"/icon.svg": ["icon.svg", "image/svg+xml"],
	"/favicon.ico": ["icon.svg", "image/svg+xml"],
	"/vendor/model-viewer.js": [join("vendor", "model-viewer.min.js"), "text/javascript; charset=utf-8"],
};

export interface ServerOptions {
	host?: string;
	/** Called once the server closed because a newer version (or `stop`) asked it to. */
	onShutdown?: () => void;
}

function author(value: unknown): Author {
	return value === "agent" ? "agent" : "human";
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
	response.end(text);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += (chunk as Buffer).length;
		if (size > 32 * 1024 * 1024) throw new HttpError(413, "body too large");
		chunks.push(chunk as Buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (!text.trim()) return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new HttpError(400, "invalid JSON");
	}
}

/** `attachment; filename="x.png"; filename*=UTF-8''x.png` — an ASCII fallback and the real name. */
export function disposition(kind: "inline" | "attachment", name: string): string {
	const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
	return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/** Sends a file, answering Range requests (video seeking needs them). */
function sendFile(request: IncomingMessage, response: ServerResponse, path: string, type: string, cache: string, headers: Record<string, string> = {}): void {
	let size: number;
	try {
		size = statSync(path).size;
	} catch {
		throw new HttpError(404, "not found");
	}
	const base = { "content-type": type, "cache-control": cache, "accept-ranges": "bytes", "x-content-type-options": "nosniff", ...headers };
	const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ""));
	if (range && (range[1] || range[2])) {
		let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
		let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
		if (!range[1]) end = size - 1;
		if (start >= size || start > end) {
			response.writeHead(416, { "content-range": `bytes */${size}` });
			return void response.end();
		}
		start = Math.max(0, start);
		end = Math.max(start, end);
		response.writeHead(206, { ...base, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
		if (request.method === "HEAD") return void response.end();
		createReadStream(path, { start, end }).pipe(response);
		return;
	}
	response.writeHead(200, { ...base, "content-length": size });
	if (request.method === "HEAD") return void response.end();
	createReadStream(path).pipe(response);
}

interface Stream {
	response: ServerResponse;
	write(text: string): void;
}

export class DailiesServer {
	readonly store: Store;
	catalog: Catalog;
	private server: Server | undefined;
	private readonly host: string;
	private readonly onShutdown: () => void;
	private allowedHosts: Set<string> | undefined;
	private readonly clients = new Set<Stream>();
	private readonly watchers = new Map<string, Set<Stream>>();
	private keepAlive: NodeJS.Timeout | undefined;
	private selection: Selection | undefined;
	private readonly converting = new Map<string, Promise<string>>();
	port = 0;

	constructor(store: Store, options: ServerOptions = {}) {
		this.store = store;
		this.host = options.host ?? "127.0.0.1";
		this.onShutdown = options.onShutdown ?? (() => undefined);
		this.catalog = store.load();
		this.selection = store.readSelection();
	}

	get url(): string {
		const host = this.host === "0.0.0.0" || this.host === "::" ? "127.0.0.1" : this.host;
		return `http://${host.includes(":") ? `[${host}]` : host}:${this.port}/`;
	}

	get viewers(): number {
		return this.clients.size;
	}

	listen(port: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const server = createServer((request, response) => {
				this.handle(request, response).catch((error: unknown) => {
					const status = error instanceof HttpError ? error.status : 500;
					if (status === 500) console.error(error);
					if (response.headersSent) return void response.destroy();
					sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
				});
			});
			server.once("error", reject);
			server.listen(port, this.host, () => {
				server.off("error", reject);
				this.server = server;
				this.port = (server.address() as AddressInfo).port;
				// Over a trusted network (0.0.0.0) any name may reach us; on loopback, only our own.
				this.allowedHosts =
					this.host === "0.0.0.0" || this.host === "::"
						? undefined
						: new Set([`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`, `${this.host}:${this.port}`]);
				this.keepAlive = setInterval(() => this.broadcast("ping", {}), 25_000);
				this.keepAlive.unref();
				resolve();
			});
		});
	}

	close(): Promise<void> {
		if (this.keepAlive) clearInterval(this.keepAlive);
		for (const client of this.clients) client.response.end();
		for (const set of this.watchers.values()) for (const watcher of set) watcher.response.end();
		this.clients.clear();
		this.watchers.clear();
		const server = this.server;
		this.server = undefined;
		if (!server) return Promise.resolve();
		return new Promise((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections?.();
		});
	}

	// Writes ------------------------------------------------------------------

	private record(event: DailiesEvent): void {
		this.store.append(event);
		this.catalog.apply(event);
	}

	addPost(input: PostInput): ReturnType<Catalog["view"]> {
		const known = new Map<string, Item>();
		for (const item of input.items ?? []) {
			if (!item || typeof item.id !== "string" || !/^[0-9a-f]{64}$/.test(String(item.sha256))) throw new HttpError(400, "each item needs an id and a sha256");
			if (!existsSync(this.store.blobPath(item.sha256, item.ext ?? ""))) throw new HttpError(400, `the file of ${item.id} is not in the store`);
			known.set(item.id, item);
		}
		let post;
		try {
			post = buildPost({ ...input, items: [...known.values()] }, this.store.machine);
		} catch (error) {
			throw new HttpError(400, (error as Error).message);
		}
		this.record(post);
		const view = this.catalog.view(this.catalog.post(post.id)!);
		this.broadcast("post", view);
		return view;
	}

	setVerdict(itemId: string, verdict: Verdict | null, by: Author): VerdictEvent {
		if (verdict !== null && verdict !== "adopted" && verdict !== "rejected") throw new HttpError(400, "verdict is adopted, rejected or null");
		const post = this.catalog.postOfItem(itemId);
		if (!post) throw new HttpError(404, `no item ${itemId}`);
		const event: VerdictEvent = { type: "verdict", id: newId("v"), at: new Date().toISOString(), machine: this.store.machine, post: post.id, item: itemId, verdict, by };
		this.record(event);
		this.broadcast("verdict", event);
		this.notify(event, post.session);
		return event;
	}

	addComment(postId: string, itemId: string | undefined, text: string, by: Author): CommentEvent {
		const post = this.catalog.post(postId);
		if (!post) throw new HttpError(404, `no post ${postId}`);
		const trimmed = text.trim();
		if (!trimmed) throw new HttpError(400, "a comment needs text");
		if (itemId && !this.catalog.item(itemId)) throw new HttpError(404, `no item ${itemId}`);
		const event: CommentEvent = { type: "comment", id: newId("c"), at: new Date().toISOString(), machine: this.store.machine, post: post.id, item: itemId, text: trimmed, by };
		if (!itemId) delete event.item;
		this.record(event);
		this.broadcast("comment", event);
		this.notify(event, post.session);
		return event;
	}

	addAnswer(postId: string, questionId: string, choices: unknown, text: string | undefined, by: Author): AnswerEvent {
		const post = this.catalog.post(postId);
		if (!post) throw new HttpError(404, `no post ${postId}`);
		const question = post.questions?.find((candidate) => candidate.id === questionId);
		if (!question) throw new HttpError(404, `no question ${questionId} in ${postId}`);
		if (!Array.isArray(choices) || !choices.length) throw new HttpError(400, "choose at least one option");
		const ids = [...new Set(choices.map(String))];
		for (const id of ids) if (!question.options.some((option) => option.id === id)) throw new HttpError(400, `no option ${id}`);
		if (ids.length > 1 && !question.multi) throw new HttpError(400, "this question takes one option");
		const note = text?.trim() || undefined;
		const event: AnswerEvent = { type: "answer", id: newId("a"), at: new Date().toISOString(), machine: this.store.machine, post: post.id, question: question.id, choices: ids, text: note, by };
		if (!note) delete event.text;
		this.record(event);
		this.broadcast("answer", event);
		this.notify(event, post.session);
		return event;
	}

	setIssue(body: Record<string, unknown>): IssueEvent {
		const key = String(body.key ?? "").trim();
		if (!ISSUE_KEY.test(key)) throw new HttpError(400, `${JSON.stringify(key)} is not an issue key`);
		const current = this.catalog.issueEvent(key);
		const field = (name: "title" | "description" | "status" | "url") => {
			const value = body[name];
			if (typeof value === "string") return value.trim() || undefined;
			return body.merge ? current?.[name] : undefined;
		};
		const details = Array.isArray(body.details) ? body.details.map(String).filter(Boolean) : body.merge ? current?.details : undefined;
		const next = { title: field("title"), description: field("description"), status: field("status"), url: field("url"), details: details?.length ? details : undefined };
		if (current) {
			const same = (["title", "description", "status", "url"] as const).every((name) => (current[name] ?? undefined) === next[name]) && JSON.stringify(current.details ?? null) === JSON.stringify(next.details ?? null);
			if (same) return current;
		}
		const event = JSON.parse(JSON.stringify({ type: "issue", id: newId("s"), at: new Date().toISOString(), machine: this.store.machine, key: key.toUpperCase(), ...next, by: author(body.by) })) as IssueEvent;
		this.record(event);
		this.broadcast("issue", this.catalog.issue(event.key));
		return event;
	}

	amend(input: AmendInput) {
		const items = (input.items ?? []).filter((item) => item && /^[0-9a-f]{64}$/.test(String(item.sha256)));
		for (const item of items) if (!existsSync(this.store.blobPath(item.sha256, item.ext ?? ""))) throw new HttpError(400, `the file of ${item.id} is not in the store`);
		let event;
		try {
			event = buildAmend({ ...input, items }, this.catalog, this.store.machine);
		} catch (error) {
			const message = (error as Error).message;
			throw new HttpError(/^no devlog entry/.test(message) ? 404 : 400, message);
		}
		this.record(event);
		const post = this.catalog.view(this.catalog.post(event.post)!);
		this.broadcast("amend", { amend: event, post });
		return { post, amend: event };
	}

	retract(input: RetractInput) {
		let event;
		try {
			event = buildRetract(input, this.catalog, this.store.machine);
		} catch (error) {
			const message = (error as Error).message;
			throw new HttpError(/^no devlog entry/.test(message) ? 404 : 400, message);
		}
		this.record(event);
		const post = this.catalog.view(this.catalog.post(event.post)!);
		this.broadcast("retract", { retract: event, post });
		return { post, retract: event };
	}

	addIdea(input: IdeaInput): IdeaView {
		let event;
		try {
			event = buildIdea(input, this.store.machine);
		} catch (error) {
			throw new HttpError(400, (error as Error).message);
		}
		this.record(event);
		const idea = this.catalog.idea(event.id)!;
		this.broadcast("idea", idea);
		return idea;
	}

	changeIdea(input: IdeaChangeInput): IdeaView {
		let event;
		try {
			event = buildIdeaChange(input, this.catalog, this.store.machine);
		} catch (error) {
			const message = (error as Error).message;
			throw new HttpError(/^no idea/.test(message) ? 404 : 400, message);
		}
		this.record(event);
		const idea = this.catalog.idea(event.idea)!;
		this.broadcast("idea", idea);
		return idea;
	}

	select(postId: string | null, itemId?: string): Selection {
		if (postId && !this.catalog.post(postId)) throw new HttpError(404, `no post ${postId}`);
		this.selection = { post: postId, item: itemId || undefined, at: new Date().toISOString() };
		this.store.writeSelection(this.selection);
		this.broadcast("select", this.selection);
		return this.selection;
	}

	/** What the agent means by "this one": the selection, or the newest post. */
	context() {
		const selected = this.selection?.post ? this.catalog.post(this.selection.post) : undefined;
		const newest = this.catalog.list({ kind: "review", limit: 1 })[0] ?? this.catalog.list({ limit: 1 })[0];
		const post = selected ?? (newest ? this.catalog.post(newest.id) : undefined);
		const view = post ? this.catalog.view(post) : null;
		const item = selected && this.selection?.item ? this.catalog.item(this.selection.item) : undefined;
		return { selected: Boolean(selected), selection: this.selection ?? null, post: view, item: item ?? null };
	}

	counts() {
		return this.catalog.counts();
	}

	/** Projects with ideas still open, and every project posts were made in, for the board's sidebar. */
	private ideaProjects(): { project: string; open: number }[] {
		const open = new Map<string, number>();
		for (const idea of this.catalog.ideas()) if (idea.project) open.set(idea.project, (open.get(idea.project) ?? 0) + 1);
		for (const node of this.catalog.tree()) if (!open.has(node.project)) open.set(node.project, 0);
		for (const idea of this.catalog.ideas({ all: true })) if (idea.project && !open.has(idea.project)) open.set(idea.project, 0);
		return [...open].map(([project, count]) => ({ project, open: count })).sort((a, b) => b.open - a.open || a.project.localeCompare(b.project));
	}

	// Streams -----------------------------------------------------------------

	private openStream(request: IncomingMessage, response: ServerResponse, set: Set<Stream>, hello: unknown): void {
		response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
		const stream: Stream = { response, write: (text) => response.write(text) };
		set.add(stream);
		stream.write(`retry: 2000\nevent: hello\ndata: ${JSON.stringify(hello)}\n\n`);
		request.on("close", () => {
			set.delete(stream);
			if (set === this.clients) this.broadcast("viewers", { viewers: this.clients.size });
		});
	}

	private broadcast(type: string, data: unknown): void {
		const message = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
		for (const client of this.clients) client.write(message);
		if (type === "ping") for (const set of this.watchers.values()) for (const watcher of set) watcher.write(message);
	}

	/** Wakes whoever waits on this post, or on the session that made it (human feedback only). */
	private notify(event: CommentEvent | AnswerEvent | VerdictEvent, session: string | undefined): void {
		if (event.by !== "human") return;
		const message = `event: feedback\ndata: ${JSON.stringify(event)}\n\n`;
		const keys = [`post:${event.post}`];
		if (session && event.type !== "verdict") keys.push(`session:${session}`);
		for (const key of keys) for (const watcher of this.watchers.get(key) ?? []) watcher.write(message);
	}

	private watching(key: string): number {
		return this.watchers.get(key)?.size ?? 0;
	}

	// Video -------------------------------------------------------------------

	private convert(item: Item): Promise<string> {
		const target = join(this.store.home, "derived", `${item.sha256}.webm`);
		if (existsSync(target)) return Promise.resolve(target);
		const running = this.converting.get(item.sha256);
		if (running) return running;
		mkdirSync(join(this.store.home, "derived"), { recursive: true });
		const temporary = `${target}.${process.pid}.tmp.webm`;
		const job = new Promise<string>((resolve, reject) => {
			const child = spawn(
				"ffmpeg",
				["-v", "error", "-y", "-i", this.store.blobPath(item.sha256, item.ext), "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "34", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-c:a", "libopus", temporary],
				{ stdio: ["ignore", "ignore", "pipe"] },
			);
			let errors = "";
			child.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
			child.on("error", (error) => reject(error));
			child.on("exit", (code) => {
				if (code === 0 && existsSync(temporary)) {
					renameSync(temporary, target);
					resolve(target);
				} else {
					try {
						unlinkSync(temporary);
					} catch {
						// nothing written
					}
					reject(new Error(`ffmpeg could not convert ${item.name}: ${errors.trim().split("\n").pop() ?? code}`));
				}
			});
		}).finally(() => this.converting.delete(item.sha256));
		this.converting.set(item.sha256, job);
		return job;
	}

	// Routing -----------------------------------------------------------------

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (this.allowedHosts && !this.allowedHosts.has(String(request.headers.host ?? ""))) throw new HttpError(403, "unexpected Host header");
		const url = new URL(request.url ?? "/", "http://viewer");
		const path = url.pathname;
		const method = request.method ?? "GET";

		if (method === "POST") {
			// JSON only: a cross-site form cannot send it, and a cross-site fetch would need a
			// preflight this server never answers.
			if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw new HttpError(415, "send JSON");
			const origin = request.headers.origin;
			if (origin && origin !== "null") {
				let host = "";
				try {
					host = new URL(origin).host;
				} catch {
					throw new HttpError(403, "cross-origin request");
				}
				if (this.allowedHosts ? !this.allowedHosts.has(host) : host !== String(request.headers.host ?? "")) throw new HttpError(403, "cross-origin request");
			} else if (origin === "null") throw new HttpError(403, "cross-origin request");
			const body = (await readJson(request)) as Record<string, unknown>;
			switch (path) {
				case "/api/posts": {
					const post = this.addPost(body as unknown as PostInput);
					return sendJson(response, 201, { post, viewers: this.viewers, url: `${this.url}#${post.id}` });
				}
				case "/api/verdicts":
					return sendJson(response, 201, this.setVerdict(String(body.item ?? ""), (body.verdict ?? null) as Verdict | null, author(body.by)));
				case "/api/comments":
					return sendJson(response, 201, this.addComment(String(body.post ?? ""), body.item ? String(body.item) : undefined, String(body.text ?? ""), author(body.by)));
				case "/api/answers":
					return sendJson(response, 201, this.addAnswer(String(body.post ?? ""), String(body.question ?? ""), body.choices, body.text === undefined || body.text === null ? undefined : String(body.text), author(body.by)));
				case "/api/issues":
					return sendJson(response, 201, this.setIssue(body));
				case "/api/amend": {
					const result = this.amend({ ...(body as unknown as AmendInput), by: body.by === "human" ? "human" : "agent" });
					return sendJson(response, 201, { ...result, url: `${this.url}#${result.post.id}` });
				}
				case "/api/retract":
					return sendJson(response, 201, this.retract({ ...(body as unknown as RetractInput), by: body.by === "human" ? "human" : "agent" }));
				case "/api/ideas": {
					const idea = this.addIdea({ ...(body as unknown as IdeaInput), by: author(body.by) });
					return sendJson(response, 201, { idea, url: `${this.url}?mode=ideas#${idea.id}` });
				}
				case "/api/ideas/change": {
					const idea = this.changeIdea({ ...(body as unknown as IdeaChangeInput), idea: String(body.idea ?? ""), by: author(body.by) });
					return sendJson(response, 201, { idea, url: `${this.url}?mode=ideas#${idea.id}` });
				}
				case "/api/path": {
					const item = this.catalog.item(String(body.item ?? ""));
					if (!item) throw new HttpError(404, `no item ${body.item}`);
					return sendJson(response, 200, { item: item.id, path: this.store.namedPath(item) });
				}
				case "/api/select":
					return sendJson(response, 200, this.select(body.post ? String(body.post) : null, body.item ? String(body.item) : undefined));
				case "/api/shutdown": {
					// Sessions may run different versions side by side; only a newer one may
					// replace this viewer (or `stop`, on purpose), or they would take turns forever.
					const theirs = typeof body.version === "string" ? body.version : "";
					if (!body.force && !(theirs && compareVersions(theirs, version()) > 0)) {
						return sendJson(response, 409, { error: `this viewer (${version()}) is not older than ${theirs || "the caller"}; keep using it`, version: version() });
					}
					sendJson(response, 200, { ok: true });
					setImmediate(() => {
						const fallback = setTimeout(this.onShutdown, 1500);
						fallback.unref();
						void this.close().then(() => {
							clearTimeout(fallback);
							this.onShutdown();
						});
					});
					return;
				}
			}
			throw new HttpError(404, `no ${path}`);
		}

		if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method not allowed");
		const param = (name: string) => url.searchParams.get(name) || undefined;
		const mode = (): "devlog" | "review" => (url.searchParams.get("mode") === "devlog" ? "devlog" : "review");

		switch (path) {
			case "/api/health":
				return sendJson(response, 200, { ok: true, version: version(), pid: process.pid, viewers: this.viewers, home: this.store.home });
			case "/api/state": {
				const filter: ListFilter = {
					limit: Math.min(Number(url.searchParams.get("limit")) || 40, 200),
					before: param("before"),
					project: param("project"),
					lane: param("lane"),
					issue: param("issue"),
					session: param("session"),
					q: param("q"),
					open: url.searchParams.get("open") === "1",
					kind: mode(),
					since: param("since"),
					until: param("until"),
				};
				return sendJson(response, 200, {
					posts: this.catalog.list(filter),
					tree: this.catalog.tree(filter.kind),
					counts: this.counts(),
					issue: this.catalog.issue(filter.issue) ?? null,
					selection: this.selection ?? null,
					machine: this.store.machine,
					version: version(),
				});
			}
			case "/api/ideas": {
				const status = param("status");
				if (status !== undefined && !isIdeaStatus(status)) throw new HttpError(400, `no status ${status}`);
				const ideas = this.catalog.ideas({ project: param("project"), status, q: param("q"), all: url.searchParams.get("all") === "1" });
				return sendJson(response, 200, { ideas, projects: this.ideaProjects(), counts: this.counts() });
			}
			case "/api/tree":
				return sendJson(response, 200, { tree: this.catalog.tree(mode()), counts: this.counts() });
			case "/api/issue":
				return sendJson(response, 200, { issue: this.catalog.issue(url.searchParams.get("key") ?? "") ?? null });
			case "/api/context":
				return sendJson(response, 200, this.context());
			case "/api/feedback": {
				const since = url.searchParams.get("since") ?? "";
				return sendJson(response, 200, { history: this.catalog.history.filter((event) => event.at > since) });
			}
			case "/api/events":
				return this.openStream(request, response, this.clients, { version: version(), viewers: this.clients.size + 1 });
			case "/api/watch": {
				const session = url.searchParams.get("session");
				const post = url.searchParams.get("post");
				if (!session && !post) throw new HttpError(400, "session or post is required");
				const key = post ? `post:${post}` : `session:${session}`;
				const set = this.watchers.get(key) ?? new Set<Stream>();
				this.watchers.set(key, set);
				return this.openStream(request, response, set, { version: version(), watching: key });
			}
			case "/api/watchers": {
				const session = url.searchParams.get("session") ?? "";
				const post = url.searchParams.get("post");
				return sendJson(response, 200, { session, watching: this.watching(`session:${session}`) + (post ? this.watching(`post:${post}`) : 0) });
			}
		}

		const blob = /^\/blob\/([0-9a-f]{64})(\.[a-z0-9]{1,12})?$/.exec(path);
		if (blob) {
			const ext = blob[2] ?? "";
			return sendFile(request, response, this.store.blobPath(blob[1]!, ext), mimeOfExt(ext), "public, max-age=31536000, immutable");
		}

		const named = /^\/files\/(i_[a-z0-9]+)(?:\/[^/]*)?$/.exec(path);
		if (named) {
			const item = this.catalog.item(named[1]!);
			if (!item) throw new HttpError(404, "no such file");
			const kind = url.searchParams.has("download") ? "attachment" : "inline";
			const headers: Record<string, string> = { "content-disposition": disposition(kind, item.name) };
			// Pages and SVGs the agent made run in their own origin-less sandbox.
			if (item.kind === "html" || item.ext === ".svg") headers["content-security-policy"] = "sandbox allow-scripts";
			return sendFile(request, response, this.store.blobPath(item.sha256, item.ext), item.mime, "public, max-age=31536000, immutable", headers);
		}

		const play = /^\/play\/(i_[a-z0-9]+)$/.exec(path);
		if (play) {
			const item = this.catalog.item(play[1]!);
			if (!item) throw new HttpError(404, "no such file");
			const plain = `/files/${item.id}/${encodeURIComponent(safeName(item.name))}`;
			if (!needsTranscode(item)) {
				response.writeHead(302, { location: plain });
				return void response.end();
			}
			let converted: string;
			try {
				converted = await this.convert(item);
			} catch {
				response.writeHead(302, { location: plain });
				return void response.end();
			}
			return sendFile(request, response, converted, "video/webm", "public, max-age=31536000, immutable");
		}

		const asset = STATIC[path];
		if (asset) return sendFile(request, response, join(WEB, asset[0]), asset[1], path.startsWith("/vendor/") ? "public, max-age=86400" : "no-cache");
		const license = /^\/vendor\/licenses\/([a-z0-9-]+\.txt)$/.exec(path);
		if (license) return sendFile(request, response, join(WEB, "vendor", "licenses", license[1]!), "text/plain; charset=utf-8", "no-cache");
		throw new HttpError(404, `no ${path}`);
	}
}
