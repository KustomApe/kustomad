import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { detectWhere, issueFromBranch } from "../src/where.ts";
import { tempDir } from "./helpers.ts";

test("an issue key is read from the branch name", () => {
	assert.equal(issueFromBranch("summ-239"), "SUMM-239");
	assert.equal(issueFromBranch("shunkimura/summ-239-familiar-recolor"), "SUMM-239");
	assert.equal(issueFromBranch("feature/ABC-12_fix"), "ABC-12");
	assert.equal(issueFromBranch("main"), undefined);
	assert.equal(issueFromBranch("release-2026"), undefined);
	assert.equal(issueFromBranch("fix-12-then-abc-3"), "ABC-3");
	assert.equal(issueFromBranch(undefined), undefined);
});

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

test("a post is placed by repository and worktree", () => {
	const root = tempDir();
	const repo = join(root, "game");
	mkdirSync(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "commit", "-q", "--allow-empty", "-m", "start");
	git(repo, "worktree", "add", "-q", join(repo, ".claude", "worktrees", "summ-7"), "-b", "someone/summ-7-thing");

	const main = detectWhere(repo, { CLAUDE_CODE_SESSION_ID: "s1" });
	assert.equal(main.project, "game");
	assert.equal(main.lane, "main");
	assert.equal(main.issue, undefined);
	assert.equal(main.session, "s1");

	const worktree = detectWhere(join(repo, ".claude", "worktrees", "summ-7"), {});
	assert.equal(worktree.project, "game");
	assert.equal(worktree.lane, "summ-7");
	assert.equal(worktree.branch, "someone/summ-7-thing");
	assert.equal(worktree.issue, "SUMM-7");
	assert.equal(worktree.session, undefined);
});

test("outside git, the folder names the post", () => {
	const dir = tempDir("loose-");
	const where = detectWhere(dir, {});
	assert.equal(where.lane, where.project);
	assert.ok(where.project.startsWith("loose-"));
});
