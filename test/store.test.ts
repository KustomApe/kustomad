import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildPost, Store, titleFromBranch, type VerdictEvent } from "../src/store.ts";
import { PNG, tempDir, writeFile } from "./helpers.ts";

test("a file is stored once per content and described by kind", async () => {
	const dir = tempDir();
	const store = new Store(join(dir, "home"), "box");
	const a = await store.addFile(writeFile(dir, "a.png", PNG));
	const b = await store.addFile(writeFile(dir, "b.png", PNG));
	assert.equal(a.sha256, b.sha256);
	assert.notEqual(a.id, b.id);
	assert.equal(a.kind, "image");
	assert.equal(a.mime, "image/png");
	assert.equal(a.size, PNG.length);
	assert.ok(existsSync(store.blobPath(a.sha256, ".png")));
	const shards = readdirSync(join(store.blobDir, a.sha256.slice(0, 2)));
	assert.deepEqual(shards, [`${a.sha256}.png`]);
	assert.deepEqual(readFileSync(store.blobPath(a.sha256, ".png")), PNG);
});

test("each machine appends to its own log, and every log is read back", async () => {
	const dir = tempDir();
	const home = join(dir, "home");
	const here = new Store(home, "here");
	const there = new Store(home, "there");
	const item = await here.addFile(writeFile(dir, "x.glb", "glTF"));
	const post = buildPost({ project: "p", lane: "l", items: [item] }, "here", new Date("2026-10-01T00:00:00Z"));
	here.append(post);
	const verdict: VerdictEvent = { type: "verdict", id: "v_1", at: "2026-10-01T00:01:00Z", machine: "there", post: post.id, item: item.id, verdict: "adopted", by: "human" };
	there.append(verdict);
	assert.ok(existsSync(join(home, "log", "here.jsonl")));
	assert.ok(existsSync(join(home, "log", "there.jsonl")));

	const catalog = here.load();
	assert.equal(catalog.posts.length, 1);
	assert.equal(catalog.verdictOf(item.id), "adopted");
	assert.equal(catalog.view(post).items[0]?.kind, "model");
});

test("a torn line does not lose the rest of the log", async () => {
	const dir = tempDir();
	const store = new Store(join(dir, "home"), "m");
	const item = await store.addFile(writeFile(dir, "a.png", PNG));
	store.append(buildPost({ project: "p", lane: "l", items: [item] }, "m"));
	appendFileSync(store.logPath, '{"type":"post","id":');
	assert.equal(store.load().posts.length, 1);
});

test("the latest mark wins, and clearing a mark leaves none", async () => {
	const dir = tempDir();
	const store = new Store(join(dir, "home"), "m");
	const item = await store.addFile(writeFile(dir, "a.png", PNG));
	const post = buildPost({ project: "p", lane: "l", items: [item] }, "m", new Date("2026-10-01T00:00:00Z"));
	store.append(post);
	const mark = (at: string, verdict: "adopted" | "rejected" | null): VerdictEvent => ({
		type: "verdict",
		id: `v_${at}`,
		at,
		machine: "m",
		post: post.id,
		item: item.id,
		verdict,
		by: "human",
	});
	store.append(mark("2026-10-01T00:02:00Z", "rejected"));
	store.append(mark("2026-10-01T00:01:00Z", "adopted"));
	assert.equal(store.load().verdictOf(item.id), "rejected");
	store.append(mark("2026-10-01T00:03:00Z", null));
	assert.equal(store.load().verdictOf(item.id), null);
});

test("posts list newest first, page by id, and filter by lane and issue", async () => {
	const dir = tempDir();
	const store = new Store(join(dir, "home"), "m");
	const item = await store.addFile(writeFile(dir, "a.png", PNG));
	const ids: string[] = [];
	for (let index = 0; index < 5; index++) {
		const post = buildPost(
			{ project: "p", lane: index % 2 ? "odd" : "even", issue: index === 4 ? "SUMM-1" : undefined, items: [item] },
			"m",
			new Date(Date.UTC(2026, 9, 1, 0, index)),
		);
		ids.push(post.id);
		store.append(post);
	}
	const catalog = store.load();
	assert.deepEqual(
		catalog.list({ limit: 2 }).map((post) => post.id),
		[ids[4], ids[3]],
	);
	assert.deepEqual(
		catalog.list({ limit: 2, before: ids[3] }).map((post) => post.id),
		[ids[2], ids[1]],
	);
	assert.deepEqual(
		catalog.list({ lane: "odd" }).map((post) => post.id),
		[ids[3], ids[1]],
	);
	assert.deepEqual(
		catalog.list({ issue: "summ-1" }).map((post) => post.id),
		[ids[4]],
	);
	assert.deepEqual(
		catalog.tree()[0]!.groups.map((group) => [group.issue ?? group.lane, group.count]),
		[
			["SUMM-1", 1],
			["odd", 2],
			["even", 2],
		],
	);
});

test("a post needs files", () => {
	assert.throws(() => buildPost({ project: "p", lane: "l", items: [] }, "m"), /at least one item/);
});

test("a post can ask questions about its files, and the latest answer counts", async () => {
	const dir = tempDir();
	const store = new Store(join(dir, "home"), "m");
	const item = await store.addFile(writeFile(dir, "a.png", PNG));
	const question = {
		id: "q1",
		text: "Keep it?",
		items: [],
		options: [
			{ id: "o1", key: "A", items: [item.id] },
			{ id: "o2", key: "B", label: "Redo it", items: [] },
		],
	};
	assert.throws(() => buildPost({ project: "p", lane: "l", items: [], questions: [{ ...question, options: [{ id: "o1", key: "A", items: ["i_nope"] }] }] }, "m"), /unknown item/);
	assert.throws(() => buildPost({ project: "p", lane: "l", items: [item], questions: [question, question] }, "m"), /own id/);
	const textOnly = buildPost({ project: "p", lane: "l", items: [], questions: [{ ...question, options: [{ id: "o1", key: "A", label: "Yes", items: [] }] }] }, "m");
	assert.equal(textOnly.items.length, 0);

	const post = buildPost({ project: "p", lane: "l", items: [item], questions: [question] }, "m", new Date("2026-10-01T00:00:00Z"));
	store.append(post);
	assert.deepEqual(store.load().openQuestions(post).map((open) => open.id), ["q1"]);
	const answer = (at: string, choices: string[], text?: string) => ({ type: "answer" as const, id: `a_${at}`, at, machine: "m", post: post.id, question: "q1", choices, text, by: "human" as const });
	store.append(answer("2026-10-01T00:02:00Z", ["o2"], "darker"));
	store.append(answer("2026-10-01T00:01:00Z", ["o1"]));
	const catalog = store.load();
	assert.deepEqual(catalog.openQuestions(post), []);
	assert.deepEqual(catalog.view(post).answers.q1?.choices, ["o2"]);
	assert.equal(catalog.view(post).answers.q1?.text, "darker");
});

test("the tree groups posts by repository, issue or branch, and session", async () => {
	const dir = tempDir();
	const store = new Store(join(dir, "home"), "m");
	const item = await store.addFile(writeFile(dir, "a.png", PNG));
	const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 0, minute));
	const add = (minute: number, extra: Partial<Parameters<typeof buildPost>[0]>) =>
		store.append(buildPost({ project: "game", lane: "main", items: [item], ...extra }, "m", at(minute)));
	add(0, { lane: "summ-7", branch: "me/summ-7-blue-capes", issue: "SUMM-7", session: "s1", title: "Capes A/B" });
	add(1, { lane: "main", session: "s2", title: "Notes" });
	add(2, { lane: "summ-7", branch: "me/summ-7-blue-capes", issue: "SUMM-7", session: "s3", title: "Capes again" });
	add(3, { project: "tool", lane: "main", title: "Other repo" });
	store.append({ type: "issue", id: "s_1", at: at(4).toISOString(), machine: "m", key: "summ-7", title: "Blue capes", status: "In Progress", by: "agent" });

	const catalog = store.load();
	const tree = catalog.tree();
	assert.deepEqual(tree.map((project) => project.project), ["tool", "game"]);
	const game = tree[1]!;
	assert.deepEqual(game.groups.map((group) => [group.issue ?? group.lane, group.title, group.count]), [
		["SUMM-7", "Blue capes", 2],
		["main", "main", 1],
	]);
	assert.equal(game.groups[0]!.status, "In Progress");
	assert.deepEqual(game.groups[0]!.sessions.map((session) => [session.session, session.title]), [
		["s3", "Capes again"],
		["s1", "Capes A/B"],
	]);
	assert.deepEqual(catalog.list({ issue: "summ-7", session: "s1" }).map((post) => post.title), ["Capes A/B"]);
	assert.deepEqual(catalog.list({ q: "capes AGAIN" }).map((post) => post.title), ["Capes again"]);
	assert.deepEqual(catalog.list({ q: "blue" }).map((post) => post.title), ["Capes again", "Capes A/B"]);
	assert.equal(titleFromBranch("me/summ-7-blue-capes", "SUMM-7"), "blue capes");
	assert.equal(titleFromBranch("main", "SUMM-7"), undefined);
});

test("review and devlog posts are listed and grouped apart", async () => {
	const dir = tempDir();
	const store = new Store(join(dir, "home"), "m");
	const item = await store.addFile(writeFile(dir, "a.png", PNG));
	store.append(buildPost({ project: "p", lane: "summ-1", issue: "SUMM-1", title: "Shown", items: [item] }, "m", new Date("2026-10-01T00:00:00Z")));
	store.append(
		buildPost({ project: "p", lane: "summ-2", issue: "SUMM-2", title: "Logged", items: [], kind: "devlog", devlog: { summary: "x", craft: "y", before: [], after: [], commits: [] } }, "m", new Date("2026-10-01T00:01:00Z")),
	);
	const catalog = store.load();
	assert.deepEqual(catalog.list({ kind: "review" }).map((post) => post.title), ["Shown"]);
	assert.deepEqual(catalog.list({ kind: "devlog" }).map((post) => post.title), ["Logged"]);
	assert.equal(catalog.list({ kind: "devlog" })[0]!.devlog?.craft, "y");
	assert.deepEqual(catalog.tree("review")[0]!.groups.map((group) => group.issue), ["SUMM-1"]);
	assert.deepEqual(catalog.tree("devlog")[0]!.groups.map((group) => group.issue), ["SUMM-2"]);
	assert.deepEqual(catalog.list({ q: "y" }).map((post) => post.title), ["Logged"]);
});
