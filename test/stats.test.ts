import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { DailiesServer } from "../src/server.ts";
import { stats, type StatsView } from "../src/stats.ts";
import { buildIdea, buildIdeaChange, buildPost, Catalog, Store, type Item, type Kind } from "../src/store.ts";
import { tempDir } from "./helpers.ts";

const file = (id: string, kind: Kind = "image"): Item => ({ id, sha256: id.padEnd(64, "0"), ext: ".png", name: `${id}.png`, mime: "image/png", kind, size: 1 });
const at = (iso: string) => new Date(iso);

/** Three days ending 2026-10-13 in Japan (UTC+9): 10/11 00:00 JST is 10/10 15:00 UTC. */
function sample(): Catalog {
	const catalog = new Catalog();
	const early = buildPost({ project: "game", lane: "main", items: [file("i_a"), file("i_b", "video")] }, "m", at("2026-10-10T15:30:00Z"));
	const late = buildPost({ project: "game", lane: "main", items: [file("i_c")], questions: [{ id: "q1", text: "Which?", items: [], options: [{ id: "o1", key: "A", label: "This", items: [] }] }] }, "m", at("2026-10-13T14:00:00Z"));
	const tools = buildPost({ project: "tools", lane: "main", items: [file("i_d", "html")] }, "m", at("2026-10-12T01:00:00Z"));
	const devlog = buildPost({ project: "game", lane: "main", items: [], kind: "devlog", devlog: { summary: "x" } }, "m", at("2026-10-12T02:00:00Z"));
	// Before the period (the 3 days before), and one taken back.
	const old = buildPost({ project: "game", lane: "main", items: [file("i_e")] }, "m", at("2026-10-08T03:00:00Z"));
	const retracted = buildPost({ project: "game", lane: "main", items: [file("i_f")] }, "m", at("2026-10-12T03:00:00Z"));
	for (const event of [early, late, tools, devlog, old, retracted]) catalog.apply(event);
	catalog.apply({ type: "retract", id: "r_1", at: "2026-10-12T04:00:00Z", machine: "m", post: retracted.id, by: "agent" });
	// The user marks a file 3 minutes in, then comments; the agent's own comment does not count.
	catalog.apply({ type: "verdict", id: "v_1", at: "2026-10-10T15:33:00Z", machine: "m", post: early.id, item: "i_a", verdict: "adopted", by: "human" });
	catalog.apply({ type: "comment", id: "c_1", at: "2026-10-10T16:00:00Z", machine: "m", post: early.id, text: "nice", by: "human" });
	catalog.apply({ type: "comment", id: "c_2", at: "2026-10-12T01:10:00Z", machine: "m", post: tools.id, text: "mine", by: "agent" });
	catalog.apply({ type: "answer", id: "a_1", at: "2026-10-13T15:00:00Z", machine: "m", post: late.id, question: "q1", choices: ["o1"], by: "human" });
	catalog.apply({ type: "comment", id: "c_3", at: "2026-10-08T04:00:00Z", machine: "m", post: old.id, text: "ok", by: "human" });
	// Ideas: one added and finished in the period, one older and still open.
	const idea = buildIdea({ title: "Frame stepping", project: "game" }, "m", at("2026-10-11T00:00:00Z"));
	catalog.apply(idea);
	catalog.apply(buildIdeaChange({ idea: idea.id, status: "done" }, catalog, "m", at("2026-10-12T00:00:00Z")));
	catalog.apply(buildIdea({ title: "Old", project: "game", status: "candidate" }, "m", at("2026-10-01T00:00:00Z")));
	return catalog;
}

test("stats count a period in the viewer's time zone, against the period before", () => {
	const view = stats(sample(), { days: 3, tz: 540, now: at("2026-10-13T14:30:00Z") });
	assert.equal(view.range.from, "2026-10-10T15:00:00.000Z");
	assert.equal(view.range.to, "2026-10-13T15:00:00.000Z");
	assert.deepEqual(
		view.daily.map((day) => [day.day, day.reviews, day.devlog, day.replies, day.ideasAdded, day.ideasDone]),
		[
			["2026-10-11", 1, 0, 2, 1, 0],
			["2026-10-12", 1, 1, 0, 0, 1],
			["2026-10-13", 1, 0, 0, 0, 0],
		],
	);
	assert.deepEqual(view.totals, { reviews: 3, files: 4, devlog: 1, questions: 1, answered: 1, replies: 2, ideasAdded: 1, ideasDone: 1 });
	assert.deepEqual(view.previous, { reviews: 1, files: 1, devlog: 0, questions: 0, answered: 0, replies: 1, ideasAdded: 0, ideasDone: 0 });
	assert.deepEqual(view.kinds, [
		{ kind: "image", count: 2 },
		{ kind: "html", count: 1 },
		{ kind: "video", count: 1 },
	]);
	assert.deepEqual(view.verdicts, { adopted: 1, rejected: 0, unmarked: 3 });
	// Waits: 3 min (early) and 60 min (late, answered after the period ends); tools never got a reply.
	assert.equal(view.response.samples, 2);
	assert.equal(view.response.median, 31.5 * 60_000);
	assert.deepEqual(
		view.response.buckets.map((bucket) => bucket.count),
		[1, 0, 1, 0, 0],
	);
	// 2026-10-11 00:30 JST is a Sunday.
	assert.equal(view.hours[0]![0], 2);
	assert.deepEqual(
		view.projects.map((entry) => [entry.project, entry.reviews, entry.devlog, entry.replies]),
		[
			["game", 2, 1, 2],
			["tools", 1, 0, 0],
		],
	);
	assert.deepEqual(view.ideas, { idea: 0, candidate: 1, doing: 0, done: 1, dropped: 0 });
});

test("stats for one project leave out the others", () => {
	const view = stats(sample(), { days: 3, tz: 540, now: at("2026-10-13T14:30:00Z"), project: "tools" });
	assert.equal(view.totals.reviews, 1);
	assert.equal(view.totals.replies, 0);
	assert.equal(view.response.median, null);
	assert.deepEqual(view.ideas, { idea: 0, candidate: 0, doing: 0, done: 0, dropped: 0 });
});

test("an idea moved back out of done no longer counts as done", () => {
	const catalog = new Catalog();
	const idea = buildIdea({ title: "x" }, "m", at("2026-10-12T00:00:00Z"));
	catalog.apply(idea);
	catalog.apply(buildIdeaChange({ idea: idea.id, status: "done" }, catalog, "m", at("2026-10-12T01:00:00Z")));
	assert.equal(catalog.ideaDoneAt(idea.id), "2026-10-12T01:00:00.000Z");
	catalog.apply(buildIdeaChange({ idea: idea.id, status: "doing" }, catalog, "m", at("2026-10-12T02:00:00Z")));
	assert.equal(catalog.ideaDoneAt(idea.id), undefined);
	assert.equal(stats(catalog, { days: 1, now: at("2026-10-12T12:00:00Z") }).totals.ideasDone, 0);
});

test("the viewer serves stats with the projects to choose from", async () => {
	const store = new Store(join(tempDir(), "home"), "box");
	for (const event of sample().posts) store.append(event);
	const server = new DailiesServer(store, { host: "127.0.0.1" });
	await server.listen(0);
	try {
		const response = await fetch(`http://127.0.0.1:${server.port}/api/stats?days=7&tz=540&project=game`);
		assert.equal(response.status, 200);
		const body = (await response.json()) as { stats: StatsView; projects: string[] };
		assert.equal(body.stats.daily.length, 7);
		assert.equal(body.stats.range.tz, 540);
		assert.equal(body.stats.project, "game");
		assert.deepEqual(body.projects, ["game", "tools"]);
	} finally {
		await server.close();
	}
});
