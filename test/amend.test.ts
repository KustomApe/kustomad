import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { collect, summaryMarkdown } from "../src/devlog.ts";
import { buildAmend, buildPost, buildRetract, Store, type AmendEvent, type Item, type PostEvent } from "../src/store.ts";
import { PNG, tempDir, writeFile } from "./helpers.ts";

// An entry with a before, an after and a loose file, recorded by machine "here".
async function setup() {
	const dir = tempDir();
	const home = join(dir, "home");
	const here = new Store(home, "here");
	const wrong = await here.addFile(writeFile(dir, "wrong_before.png", PNG));
	const after = await here.addFile(writeFile(dir, "after.png", Buffer.concat([PNG, Buffer.from("a")])));
	const loose = await here.addFile(writeFile(dir, "notes.txt", "notes"));
	const entry = buildPost(
		{
			project: "game",
			lane: "main",
			issue: "SUMM-1",
			title: "Thicker cape",
			items: [wrong, after, loose],
			kind: "devlog",
			devlog: { summary: "Reads at game size.", craft: "Normals.", struggle: "The hood clipped.", before: [wrong.id], after: [after.id], commits: [{ sha: "abc123", subject: "feat: cape" }] },
		},
		"here",
		new Date("2026-10-03T10:00:00Z"),
	);
	here.append(entry);
	return { dir, home, here, wrong, after, loose, entry };
}

function amendAt(input: Parameters<typeof buildAmend>[0], store: Store, at: string): AmendEvent {
	return buildAmend(input, store.load(), store.machine, new Date(at));
}

test("a correction replaces only the fields it gives, everywhere the entry is read", async () => {
	const { dir, here, wrong, after, entry } = await setup();
	const right = await here.addFile(writeFile(dir, "right_before.png", Buffer.concat([PNG, Buffer.from("b")])));
	here.append(amendAt({ post: entry.id, title: "A thicker cape", devlog: { before: [right.id] }, items: [right], reason: "wrong before" }, here, "2026-10-03T11:00:00Z"));

	const catalog = here.load();
	const post = catalog.post(entry.id)!;
	assert.equal(post.title, "A thicker cape");
	assert.equal(post.devlog?.summary, "Reads at game size.");
	assert.equal(post.devlog?.craft, "Normals.");
	assert.deepEqual(post.devlog?.before, [right.id]);
	assert.deepEqual(post.devlog?.after, [after.id]);
	// The wrong before leaves the entry; the after and the loose file stay.
	assert.deepEqual(post.items.map((item) => item.name), ["right_before.png", "after.png", "notes.txt"]);
	assert.equal(post.items.some((item) => item.id === wrong.id), false);
	assert.equal(catalog.item(wrong.id)?.name, "wrong_before.png");
	assert.equal(catalog.postOfItem(right.id)?.id, entry.id);
	assert.deepEqual(post.amended?.map((note) => [note.reason, note.fields]), [["wrong before", ["title", "before"]]]);

	// The list, the view (with the first record kept for the page) and the summary all read the corrected entry.
	const [listed] = catalog.list({ kind: "devlog" });
	assert.equal(listed?.title, "A thicker cape");
	assert.equal(listed?.original?.title, "Thicker cape");
	assert.deepEqual(listed?.original?.devlog?.before, [wrong.id]);
	assert.equal(catalog.list({ kind: "devlog", q: "thicker cape" }).length, 1);
	const summary = collect(catalog, here, { since: "2026-10-03T00:00:00Z", until: "2026-10-04T00:00:00Z" });
	assert.equal(summary.issues[0]?.entries[0]?.title, "A thicker cape");
	const text = summaryMarkdown(catalog, here, summary);
	assert.match(text, /### A thicker cape/);
	assert.match(text, /\(Corrected, last 2026-10-03T11:00: wrong before\)/);
	assert.match(text, /Before: right_before\.png/);
	assert.doesNotMatch(text, /wrong_before/);
});

test("the log stays append-only: the entry's own event is never rewritten", async () => {
	const { here, entry } = await setup();
	const before = readFileSync(here.logPath, "utf8");
	here.append(amendAt({ post: entry.id, devlog: { summary: "Fixed." } }, here, "2026-10-03T11:00:00Z"));
	here.append(buildRetract({ post: entry.id, reason: "twice" }, here.load(), "here", new Date("2026-10-03T12:00:00Z")));
	const after = readFileSync(here.logPath, "utf8");
	assert.ok(after.startsWith(before));
	const events = here.readEvents();
	assert.deepEqual(events.map((event) => event.type), ["post", "amend", "retract"]);
	const recorded = events[0] as PostEvent;
	assert.deepEqual(recorded, JSON.parse(JSON.stringify(entry)));
	assert.equal(recorded.devlog?.summary, "Reads at game size.");
});

test("corrections apply in log order, later ones winning, whatever order they arrive in", async () => {
	const { here, entry } = await setup();
	const first = amendAt({ post: entry.id, title: "First fix", devlog: { craft: "Better normals." } }, here, "2026-10-03T11:00:00Z");
	const second = amendAt({ post: entry.id, title: "Second fix", devlog: { craft: "" } }, here, "2026-10-03T12:00:00Z");
	for (const order of [
		[first, second],
		[second, first],
	]) {
		const catalog = here.load();
		for (const event of order) catalog.apply(event);
		const post = catalog.post(entry.id)!;
		assert.equal(post.title, "Second fix");
		assert.equal(post.devlog?.craft, undefined, "an empty text clears the section");
		assert.equal(post.devlog?.struggle, "The hood clipped.");
		assert.deepEqual(post.amended?.map((note) => note.id), [first.id, second.id]);
	}
});

test("a correction written by another machine applies once the logs are put together", async () => {
	const { home, here, entry } = await setup();
	const there = new Store(home, "there");
	const fix = amendAt({ post: entry.id, title: "Fixed on the laptop", reason: "typo" }, there, "2026-10-03T11:00:00Z");
	there.append(fix);
	assert.equal(here.load().post(entry.id)?.title, "Fixed on the laptop");

	// A clock that ran ahead can put a correction before the entry in the log; it still applies.
	const early = amendAt({ post: entry.id, devlog: { decided: "Keep the hem." } }, here, "2026-10-03T09:00:00Z");
	const catalog = new Store(tempDir(), "x").load();
	catalog.apply(early);
	catalog.apply(entry);
	assert.equal(catalog.post(entry.id)?.devlog?.decided, "Keep the hem.");

	// A correction for an entry nobody has is ignored.
	const stray: AmendEvent = { ...early, id: "e_stray", post: "p_missing" };
	const quiet = here.load();
	quiet.apply(stray);
	assert.equal(quiet.post("p_missing"), undefined);
	assert.equal(quiet.posts.length, 1);
});

test("a retracted entry leaves the devlog until it is brought back", async () => {
	const { here, entry } = await setup();
	assert.deepEqual([...here.load().recordedCommits()], ["abc123"]);
	here.append(buildRetract({ post: entry.id, reason: "recorded twice" }, here.load(), "here", new Date("2026-10-03T11:00:00Z")));
	let catalog = here.load();
	assert.deepEqual(catalog.post(entry.id)?.retracted, { at: "2026-10-03T11:00:00.000Z", reason: "recorded twice" });
	assert.equal(catalog.list({ kind: "devlog" }).length, 0);
	assert.equal(catalog.list({ kind: "devlog", retracted: true }).length, 1);
	assert.deepEqual(catalog.tree("devlog"), []);
	assert.equal(collect(catalog, here, { since: "2026-10-03T00:00:00Z", until: "2026-10-04T00:00:00Z" }).issues.length, 0);
	// Its commits may go into a new entry.
	assert.equal(catalog.recordedCommits().size, 0);
	assert.throws(() => buildRetract({ post: entry.id }, catalog, "here"), /already retracted/);
	assert.throws(() => buildAmend({ post: entry.id, title: "x" }, catalog, "here"), /is retracted/);

	here.append(buildRetract({ post: entry.id, undo: true }, catalog, "here", new Date("2026-10-03T12:00:00Z")));
	catalog = here.load();
	assert.equal(catalog.post(entry.id)?.retracted, undefined);
	assert.equal(catalog.list({ kind: "devlog" }).length, 1);
	assert.throws(() => buildRetract({ post: entry.id, undo: true }, catalog, "here"), /not retracted/);
});

test("a correction that cannot apply is refused with the reason", async () => {
	const { dir, here, entry, after } = await setup();
	const catalog = here.load();
	const shown = buildPost({ project: "game", lane: "main", items: [after] }, "here");
	catalog.apply(shown);
	assert.throws(() => buildAmend({ post: "p_nope", title: "x" }, catalog, "here"), /no devlog entry p_nope/);
	assert.throws(() => buildAmend({ post: shown.id, title: "x" }, catalog, "here"), /not a devlog entry/);
	assert.throws(() => buildRetract({ post: shown.id }, catalog, "here"), /not a devlog entry/);
	assert.throws(() => buildAmend({ post: entry.id, reason: "only a reason" }, catalog, "here"), /nothing to change/);
	assert.throws(() => buildAmend({ post: entry.id, devlog: { before: ["i_unknown"] } }, catalog, "here"), /not a file of this correction/);
	const titleless = { post: entry.id, title: "", devlog: { summary: "" } };
	assert.throws(() => buildAmend(titleless, catalog, "here"), /needs a title or a summary/);
	// The viewer's URL works as the id too.
	const other: Item = await here.addFile(writeFile(dir, "x.png", PNG));
	const event = buildAmend({ post: `http://127.0.0.1:4777/#${entry.id}`, devlog: { before: [], after: [other.id] }, items: [other] }, catalog, "here");
	assert.equal(event.post, entry.id);
	catalog.apply(event);
	assert.deepEqual(catalog.post(entry.id)?.devlog?.before, []);
	assert.deepEqual(catalog.post(entry.id)?.items.map((item) => item.name), ["x.png", "notes.txt"]);
});
