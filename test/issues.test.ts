import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { dueForRefresh, fetchIssue, issueCommandFor, markFetched, normalizeIssue } from "../src/issues.ts";
import { Store } from "../src/store.ts";
import { tempDir, writeFile } from "./helpers.ts";

test("issues from Linear (linear-tui), GitHub (gh) and Jira-like JSON read the same", () => {
	assert.deepEqual(
		normalizeIssue({
			identifier: "SUMM-167",
			title: "How to play",
			description: "## Goal\nPlay without a manual.",
			state: { name: "In Progress", type: "started" },
			url: "https://linear.app/x/issue/SUMM-167",
			project: { name: "Early access" },
			milestone: { name: "M1" },
			labels: [{ name: "ui" }],
			assignee: null,
		}),
		{
			title: "How to play",
			description: "## Goal\nPlay without a manual.",
			status: "In Progress",
			url: "https://linear.app/x/issue/SUMM-167",
			details: ["Early access", "M1", "ui"],
		},
	);
	assert.deepEqual(normalizeIssue({ title: "Crash", body: "Steps", state: "OPEN", url: "https://github.com/a/b/issues/3", labels: [{ name: "bug" }] }), {
		title: "Crash",
		description: "Steps",
		status: "OPEN",
		url: "https://github.com/a/b/issues/3",
		details: ["bug"],
	});
	assert.deepEqual(normalizeIssue({ fields: { summary: "Login", description: "x", status: { name: "Done" } } }), {
		title: "Login",
		description: "x",
		status: "Done",
		url: undefined,
		details: undefined,
	});
});

test("the issue command comes from the user's config, per project or for all", () => {
	const dir = tempDir();
	const config = writeFile(dir, "config.json", JSON.stringify({ issueCommand: "gh issue view {key} --json title", projects: { game: { issueCommand: "linear-tui issue show {key} --json" } } }));
	const env = { AGENTS_DAILIES_CONFIG: config };
	assert.equal(issueCommandFor("game", env), "linear-tui issue show {key} --json");
	assert.equal(issueCommandFor("other", env), "gh issue view {key} --json title");
	assert.equal(issueCommandFor("game", { ...env, AGENTS_DAILIES_ISSUE_COMMAND: "x {key}" }), "x {key}");
	assert.equal(issueCommandFor("game", { AGENTS_DAILIES_CONFIG: join(dir, "missing.json") }), undefined);
});

test("fetching runs the command with the key and reads its JSON", async () => {
	const info = await fetchIssue(`printf '{"title":"%s","state":{"name":"Todo"}}' {key}`, "ABC-12");
	assert.deepEqual(info, { title: "ABC-12", description: undefined, status: "Todo", url: undefined, details: undefined });
	await assert.rejects(fetchIssue("echo not json", "ABC-12"), /did not print JSON/);
	await assert.rejects(fetchIssue("echo {}", "ABC-12; rm -rf /"), /not an issue key/);
});

test("an issue is fetched again only after a while", () => {
	const store = new Store(join(tempDir(), "home"), "m");
	assert.equal(dueForRefresh(store, "ABC-1"), true);
	markFetched(store, "abc-1", new Date("2026-10-01T00:00:00Z"));
	assert.equal(dueForRefresh(store, "ABC-1", Date.parse("2026-10-01T00:10:00Z")), false);
	assert.equal(dueForRefresh(store, "ABC-1", Date.parse("2026-10-01T01:00:00Z")), true);
});
