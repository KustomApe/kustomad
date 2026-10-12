import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DailiesServer } from "../src/server.ts";
import { buildIdea, buildIdeaChange, Catalog, Store, type IdeaView } from "../src/store.ts";
import { tempDir } from "./helpers.ts";

test("an idea reads as its first record with every change applied, whatever order they arrive in", () => {
	const idea = buildIdea({ title: "Frame stepping", body: "`,` and `.`", project: "game", by: "human" }, "here", new Date("2026-10-01T10:00:00Z"));
	const known = new Catalog();
	known.apply(idea);
	const doing = buildIdeaChange({ idea: idea.id, status: "doing" }, known, "here", new Date("2026-10-02T10:00:00Z"));
	const renamed = buildIdeaChange({ idea: idea.id, title: "Frame stepping keys", body: "" }, known, "there", new Date("2026-10-03T10:00:00Z"));
	const done = buildIdeaChange({ idea: idea.id, status: "done" }, known, "there", new Date("2026-10-04T10:00:00Z"));

	const inOrder = new Catalog();
	for (const event of [idea, doing, renamed, done]) inOrder.apply(event);
	const shuffled = new Catalog();
	for (const event of [done, renamed, idea, doing, done]) shuffled.apply(event);

	const expected: IdeaView = { id: idea.id, at: idea.at, updated: done.at, title: "Frame stepping keys", status: "done", project: "game", by: "human", changes: 3 };
	assert.deepEqual(inOrder.idea(idea.id), expected);
	assert.deepEqual(shuffled.idea(idea.id), expected);
});

test("lists hide done and dropped ideas unless asked, and a project's list includes ideas for everything", () => {
	const catalog = new Catalog();
	const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 10, minute));
	const mine = buildIdea({ title: "Mine", project: "game" }, "m", at(1));
	const everyone = buildIdea({ title: "Everyone", body: "for all" }, "m", at(2));
	const other = buildIdea({ title: "Other", project: "tools" }, "m", at(3));
	const finished = buildIdea({ title: "Finished", project: "game", status: "done" }, "m", at(4));
	for (const event of [mine, everyone, other, finished]) catalog.apply(event);

	assert.deepEqual(catalog.ideas().map((idea) => idea.title), ["Other", "Everyone", "Mine"]);
	assert.deepEqual(catalog.ideas({ project: "game" }).map((idea) => idea.title), ["Everyone", "Mine"]);
	assert.deepEqual(catalog.ideas({ project: "game", all: true }).map((idea) => idea.title), ["Finished", "Everyone", "Mine"]);
	assert.deepEqual(catalog.ideas({ status: "done" }).map((idea) => idea.title), ["Finished"]);
	assert.deepEqual(catalog.ideas({ q: "FOR all" }).map((idea) => idea.title), ["Everyone"]);
	assert.equal(catalog.counts().ideas, 3);
});

test("an idea needs a title and a known status, and a change must change something", () => {
	assert.throws(() => buildIdea({ title: "  " }, "m"), /needs a title/);
	assert.throws(() => buildIdea({ title: "x", status: "later" as never }, "m"), /status is one of/);
	const catalog = new Catalog();
	const idea = buildIdea({ title: "Same" }, "m");
	catalog.apply(idea);
	assert.throws(() => buildIdeaChange({ idea: idea.id, title: "Same", status: "idea" }, catalog, "m"), /nothing to change/);
	assert.throws(() => buildIdeaChange({ idea: idea.id, title: "" }, catalog, "m"), /needs a title/);
	assert.throws(() => buildIdeaChange({ idea: "n_missing", status: "done" }, catalog, "m"), /no idea n_missing/);
});

test("the viewer adds and moves ideas, keeps them in the log, and tells open tabs", async () => {
	const store = new Store(join(tempDir(), "home"), "box");
	const server = new DailiesServer(store, { host: "127.0.0.1" });
	await server.listen(0);
	const base = `http://127.0.0.1:${server.port}`;
	const send = async (path: string, body: unknown) => {
		const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		return { status: response.status, body: (await response.json()) as { idea: IdeaView; url: string; error?: string } };
	};
	try {
		const events = await fetch(`${base}/api/events`);
		const reader = events.body!.getReader();
		const added = await send("/api/ideas", { title: "Board", project: "game", by: "human" });
		assert.equal(added.status, 201);
		assert.equal(added.body.idea.status, "idea");
		assert.match(added.body.url, /\?mode=ideas#n_/);
		const moved = await send("/api/ideas/change", { idea: added.body.idea.id, status: "candidate", by: "human" });
		assert.equal(moved.body.idea.status, "candidate");
		assert.equal((await send("/api/ideas/change", { idea: "n_nope", status: "done" })).status, 404);
		assert.equal((await send("/api/ideas", { title: "" })).status, 400);

		let text = "";
		while ((text.match(/event: idea\n/g) ?? []).length < 2) text += new TextDecoder().decode((await reader.read()).value);
		await reader.cancel();

		const listed = (await (await fetch(`${base}/api/ideas?project=game`)).json()) as { ideas: IdeaView[]; projects: { project: string; open: number }[]; counts: { ideas: number } };
		assert.deepEqual(listed.ideas.map((idea) => idea.status), ["candidate"]);
		assert.deepEqual(listed.projects, [{ project: "game", open: 1 }]);
		assert.equal(listed.counts.ideas, 1);
		assert.equal((await fetch(`${base}/api/ideas?status=later`)).status, 400);
		// What the log adds up to is what the viewer shows.
		assert.deepEqual(store.load().idea(added.body.idea.id), moved.body.idea);
	} finally {
		await server.close();
	}
});

test("kustomad idea adds, changes and lists ideas for this repository", async (t) => {
	const dir = tempDir();
	const env = { ...process.env, KUSTOMAD_HOME: join(dir, "home"), KUSTOMAD_PORT: String(49000 + Math.floor(Math.random() * 1000)), KUSTOMAD_NO_OPEN: "1" };
	const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
	const run = (...args: string[]) =>
		new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
			execFile(process.execPath, [cli, ...args], { env, cwd: dir }, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout, stderr })),
		);
	t.after(() => run("stop"));
	const added = await run("idea", "add", "Frame", "stepping", "--status", "candidate", "--json");
	assert.equal(added.code, 0, added.stderr);
	const { idea } = JSON.parse(added.stdout) as { idea: IdeaView };
	assert.equal(idea.title, "Frame stepping");
	assert.equal(idea.project, join(dir).split("/").pop());
	assert.equal((await run("idea", "add", "Everywhere", "--global")).code, 0);
	const changed = await run("idea", "set", idea.id, "--status", "done");
	assert.match(changed.stdout, /\[done\]\s+Frame stepping/);
	const open = await run("idea", "list");
	assert.match(open.stdout, /Everywhere/);
	assert.doesNotMatch(open.stdout, /Frame stepping/);
	assert.match((await run("idea", "list", "--all")).stdout, /\[done\]\s+Frame stepping/);
	const wrong = await run("idea", "set", idea.id, "--status", "later");
	assert.equal(wrong.code, 1);
	assert.match(wrong.stderr, /--status is one of idea, candidate, doing, done, dropped/);
});
