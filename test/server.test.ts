import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DailiesServer } from "../src/server.ts";
import { Store, type Item, type PostView } from "../src/store.ts";
import { PNG, tempDir, writeFile } from "./helpers.ts";

let server: DailiesServer;
let base: string;
let store: Store;
let items: Item[];
let shutdowns = 0;

before(async () => {
	const dir = tempDir();
	store = new Store(join(dir, "home"), "box");
	items = [await store.addFile(writeFile(dir, "left.png", PNG)), await store.addFile(writeFile(dir, "right.txt", "hello world"))];
	server = new DailiesServer(store, { host: "127.0.0.1", onShutdown: () => (shutdowns += 1) });
	await server.listen(0);
	base = `http://127.0.0.1:${server.port}`;
});

after(() => server.close());

async function post<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
	const response = await fetch(base + path, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: (await response.json()) as T };
}

// Reads server-sent events until `count` of `type` arrive.
async function collect(path: string, type: string, count: number, during: () => Promise<void>): Promise<unknown[]> {
	const controller = new AbortController();
	const response = await fetch(base + path, { signal: controller.signal });
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	const found: unknown[] = [];
	let buffer = "";
	let started = false;
	while (found.length < count) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let end: number;
		while ((end = buffer.indexOf("\n\n")) >= 0) {
			const block = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			const name = /^event: (.*)$/m.exec(block)?.[1];
			const data = /^data: (.*)$/m.exec(block)?.[1];
			if (name === type && data) found.push(JSON.parse(data));
		}
		if (!started) {
			started = true;
			await during();
		}
	}
	controller.abort();
	return found;
}

test("a post reaches open pages as it is made", async () => {
	let made: PostView | undefined;
	const [pushed] = await collect("/api/events", "post", 1, async () => {
		const result = await post<{ post: PostView; viewers: number; url: string }>("/api/posts", {
			project: "game",
			lane: "summ-1",
			session: "s1",
			title: "Two options",
			items,
		});
		assert.equal(result.status, 201);
		assert.equal(result.body.viewers, 1);
		assert.match(result.body.url, /#p_/);
		made = result.body.post;
	});
	assert.equal((pushed as PostView).id, made!.id);
});

test("the page loads the feed, the files, and ranges of them", async () => {
	const state = (await (await fetch(`${base}/api/state`)).json()) as { posts: PostView[]; tree: { groups: { lane: string }[] }[] };
	assert.equal(state.posts[0]?.title, "Two options");
	assert.deepEqual(state.tree[0]!.groups.map((group) => group.lane), ["summ-1"]);

	const image = await fetch(`${base}/blob/${items[0]!.sha256}.png`);
	assert.equal(image.headers.get("content-type"), "image/png");
	assert.match(image.headers.get("cache-control") ?? "", /immutable/);
	assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);

	const part = await fetch(`${base}/blob/${items[1]!.sha256}.txt`, { headers: { range: "bytes=6-" } });
	assert.equal(part.status, 206);
	assert.equal(await part.text(), "world");

	const page = await fetch(`${base}/`);
	assert.match(await page.text(), /agents dailies/);
	assert.equal((await fetch(`${base}/blob/${"0".repeat(64)}.png`)).status, 404);
	assert.equal((await fetch(`${base}/../package.json`)).status, 404);
});

test("marks, comments and the selection add up to the context", async () => {
	const postId = server.catalog.posts[0]!.id;
	assert.equal((await post("/api/verdicts", { item: items[1]!.id, verdict: "adopted", by: "human" })).status, 201);
	assert.equal((await post("/api/comments", { post: postId, item: items[1]!.id, text: "  darker, please ", by: "human" })).status, 201);
	assert.equal((await post("/api/select", { post: postId, item: items[1]!.id })).status, 200);

	const context = (await (await fetch(`${base}/api/context`)).json()) as {
		selected: boolean;
		selection: { item: string };
		post: PostView;
	};
	assert.equal(context.selected, true);
	assert.equal(context.selection.item, items[1]!.id);
	assert.equal(context.post.items[1]?.verdict, "adopted");
	assert.equal(context.post.comments[0]?.text, "darker, please");
	assert.equal(store.readSelection()?.item, items[1]!.id);

	assert.equal((await post("/api/verdicts", { item: "i_nope", verdict: "adopted" })).status, 404);
	assert.equal((await post("/api/verdicts", { item: items[0]!.id, verdict: "maybe" })).status, 400);
	assert.equal((await post("/api/comments", { post: postId, text: "   " })).status, 400);
});

test("a comment on a session's post is pushed to that session's watchers", async () => {
	const postId = server.catalog.posts[0]!.id;
	const [comment] = await collect("/api/watch?session=s1", "feedback", 1, async () => {
		const count = (await (await fetch(`${base}/api/watchers?session=s1`)).json()) as { watching: number };
		assert.equal(count.watching, 1);
		await post("/api/comments", { post: postId, text: "go on", by: "human" });
	});
	assert.equal((comment as { text: string }).text, "go on");
});

test("other sites cannot use the API", async () => {
	assert.equal((await fetch(`${base}/api/select`, { method: "POST", body: "{}", headers: { "content-type": "text/plain" } })).status, 415);
	assert.equal((await post("/api/select", {}, { origin: "https://evil.example" })).status, 403);
	// Node's fetch will not override Host, so speak HTTP directly.
	const { request } = await import("node:http");
	const status = await new Promise<number>((resolve) => {
		request({ host: "127.0.0.1", port: server.port, path: "/api/health", headers: { host: `evil.example:${server.port}` } }, (response) => {
			response.resume();
			resolve(response.statusCode ?? 0);
		}).end();
	});
	assert.equal(status, 403);
});

test("answers are checked against the question, pushed to pages and to whoever waits on the post", async () => {
	const ask = await post<{ post: PostView }>("/api/posts", {
		project: "game",
		lane: "summ-1",
		session: "s2",
		title: "Which?",
		items: [items[0]],
		questions: [
			{ id: "q1", text: "Which?", items: [], options: [{ id: "o1", key: "A", items: [items[0]!.id] }, { id: "o2", key: "B", label: "Neither", items: [] }] },
			{ id: "q2", text: "Which colors?", multi: true, items: [], options: [{ id: "o1", key: "A", label: "Red", items: [] }, { id: "o2", key: "B", label: "Blue", items: [] }] },
		],
	});
	assert.equal(ask.status, 201);
	const postId = ask.body.post.id;
	assert.equal((await post("/api/answers", { post: postId, question: "q1", choices: ["o9"] })).status, 400);
	assert.equal((await post("/api/answers", { post: postId, question: "q1", choices: ["o1", "o2"] })).status, 400);
	assert.equal((await post("/api/answers", { post: postId, question: "q1", choices: [] })).status, 400);
	assert.equal((await post("/api/answers", { post: postId, question: "q9", choices: ["o1"] })).status, 404);
	assert.equal((await post("/api/answers", { post: postId, question: "q2", choices: ["o1", "o2"] })).status, 201);

	const [pushed] = await collect(`/api/watch?post=${postId}`, "feedback", 1, async () => {
		const count = (await (await fetch(`${base}/api/watchers?session=nobody&post=${postId}`)).json()) as { watching: number };
		assert.equal(count.watching, 1);
		await post("/api/answers", { post: postId, question: "q1", choices: ["o2"], text: " redo it ", by: "human" });
	});
	assert.deepEqual((pushed as { choices: string[]; text: string }).choices, ["o2"]);
	assert.equal((pushed as { text: string }).text, "redo it");
	assert.deepEqual(server.catalog.openQuestions(server.catalog.post(postId)!), []);
});

test("a file comes back under its own name: to save, and as a path for upload dialogs", async () => {
	const item = items[0]!;
	const saved = await fetch(`${base}/files/${item.id}/left.png?download`);
	assert.equal(saved.status, 200);
	assert.equal(saved.headers.get("content-type"), "image/png");
	assert.match(saved.headers.get("content-disposition") ?? "", /^attachment; filename="left\.png"; filename\*=UTF-8''left\.png$/);
	assert.match((await fetch(`${base}/files/${item.id}/x`)).headers.get("content-disposition") ?? "", /^inline;/);
	assert.equal((await fetch(`${base}/files/i_nope/x`)).status, 404);

	const { body } = await post<{ path: string }>("/api/path", { item: item.id });
	assert.match(body.path, /\/named\/i_[a-z0-9]+\/left\.png$/);
	assert.deepEqual(readFileSync(body.path), PNG);
	assert.equal(statSync(body.path).nlink >= 2, true);
	assert.equal((await post<{ path: string }>("/api/path", { item: item.id })).body.path, body.path);
});

function hasFfmpeg(): boolean {
	try {
		const encoders = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		return ["libtheora", "libvpx-vp9", "libopus"].every((name) => encoders.includes(name));
	} catch {
		return false;
	}
}

test("a video browsers cannot play is converted once to WebM", { skip: !hasFfmpeg() && "ffmpeg with libtheora, libvpx-vp9 and libopus is not installed" }, async () => {
	const dir = join(store.home, "..");
	const ogv = join(dir, "clip.ogv");
	execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=10:duration=1", "-c:v", "libtheora", ogv]);
	const clip = await store.addFile(ogv);
	await post("/api/posts", { project: "game", lane: "summ-1", items: [clip] });
	const played = await fetch(`${base}/play/${clip.id}`);
	assert.equal(played.status, 200);
	assert.equal(played.headers.get("content-type"), "video/webm");
	assert.ok((await played.arrayBuffer()).byteLength > 100);
	assert.ok(existsSync(join(store.home, "derived", `${clip.sha256}.webm`)));
	const mp4 = await fetch(`${base}/play/${items[0]!.id}`, { redirect: "manual" });
	assert.equal(mp4.status, 302);
});

test("an issue is recorded once per change, and an agent's fields merge with the tracker's", async () => {
	const first = await post<{ id: string; title: string }>("/api/issues", { key: "summ-1", title: "Capes", status: "Todo", by: "agent" });
	assert.equal(first.status, 201);
	const again = await post<{ id: string }>("/api/issues", { key: "SUMM-1", title: "Capes", status: "Todo" });
	assert.equal(again.body.id, first.body.id);
	const merged = await post<{ title: string; status: string; description: string }>("/api/issues", { key: "SUMM-1", description: "Make them blue", merge: true });
	assert.deepEqual([merged.body.title, merged.body.status, merged.body.description], ["Capes", "Todo", "Make them blue"]);
	assert.equal((await post("/api/issues", { key: "not a key" })).status, 400);

	const state = (await (await fetch(`${base}/api/state?issue=SUMM-1&q=nothing-matches`)).json()) as { posts: unknown[]; issue: { title: string }; tree: unknown[] };
	assert.equal(state.posts.length, 0);
	assert.equal(state.issue.title, "Capes");
	assert.ok(state.tree.length > 0);
});

test("a devlog entry is corrected and retracted through the viewer, which tells open pages", async () => {
	const entry = await post<{ post: PostView }>("/api/posts", {
		project: "game",
		lane: "main",
		title: "Cape",
		items,
		kind: "devlog",
		devlog: { summary: "Thicker.", before: [items[0]!.id], after: [items[1]!.id] },
	});
	assert.equal(entry.status, 201);
	const id = entry.body.post.id;
	const devlogCount = async () => ((await (await fetch(`${base}/api/tree?mode=devlog`)).json()) as { counts: { devlog: number } }).counts.devlog;
	const count = await devlogCount();

	let made: { status: number; body: { post: PostView; url: string } } | undefined;
	const [pushed] = await collect("/api/events", "amend", 1, async () => {
		made = await post<{ post: PostView; url: string }>("/api/amend", { post: id, title: "A thicker cape", devlog: { before: [] }, reason: "wrong before", by: "agent" });
	});
	assert.equal(made!.status, 201);
	assert.match(made!.body.url, new RegExp(`#${id}$`));
	assert.equal((pushed as { post: PostView }).post.title, "A thicker cape");
	const state = (await (await fetch(`${base}/api/state?mode=devlog`)).json()) as { posts: PostView[] };
	const shown = state.posts.find((candidate) => candidate.id === id)!;
	assert.equal(shown.title, "A thicker cape");
	assert.deepEqual(shown.devlog?.before, []);
	assert.deepEqual(shown.amended?.map((note) => note.reason), ["wrong before"]);
	assert.equal(shown.original?.title, "Cape");
	// The file the correction took out is still served, for the entry as first recorded.
	assert.equal((await fetch(`${base}/files/${items[0]!.id}/left.png`)).status, 200);

	assert.equal((await post("/api/amend", { post: "p_nope", title: "x" })).status, 404);
	assert.equal((await post("/api/amend", { post: server.catalog.posts[0]!.id, title: "x" })).status, 400);
	assert.equal((await post("/api/amend", { post: id, reason: "nothing else" })).status, 400);
	assert.equal((await post("/api/amend", { post: id, title: "x" }, { origin: "https://evil.example" })).status, 403);

	const [gone] = await collect("/api/events", "retract", 1, async () => {
		assert.equal((await post("/api/retract", { post: id, reason: "twice", by: "agent" })).status, 201);
	});
	assert.equal((gone as { post: PostView }).post.retracted?.reason, "twice");
	const after = (await (await fetch(`${base}/api/state?mode=devlog`)).json()) as { posts: PostView[] };
	assert.equal(after.posts.some((candidate) => candidate.id === id), false);
	assert.equal(await devlogCount(), count - 1);
	assert.equal((await post("/api/retract", { post: id })).status, 400);
});

test("only a newer version (or stop on purpose) may shut the viewer down", async () => {
	const { compareVersions, version } = await import("../src/config.ts");
	assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
	assert.ok(compareVersions("0.3.0", "0.5.0") < 0);
	assert.equal(compareVersions("1.2.3", "1.2.3"), 0);

	assert.equal((await post("/api/shutdown", {})).status, 409);
	assert.equal((await post("/api/shutdown", { version: "0.0.1" })).status, 409);
	assert.equal((await post("/api/shutdown", { version: version() })).status, 409);
	assert.equal(shutdowns, 0);
	const [major, minor] = version().split(".").map(Number);
	assert.equal((await post("/api/shutdown", { version: `${major}.${(minor ?? 0) + 1}.0` })).status, 200);
	for (let tries = 0; tries < 40 && !shutdowns; tries++) await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(shutdowns, 1);
});
