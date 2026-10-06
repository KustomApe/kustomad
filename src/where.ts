import { execFileSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import type { Where } from "./store.ts";

/** Runs git quietly; undefined when it fails or git is missing. */
export function git(cwd: string, ...args: string[]): string | undefined {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trimEnd();
	} catch {
		return undefined;
	}
}

/** Words that come before a number in branch names without being an issue tracker's key. */
const NOT_KEYS = new Set(["release", "releases", "fix", "fixes", "hotfix", "bugfix", "bug", "feature", "feat", "chore", "v", "ver", "version", "rc", "beta", "alpha", "wip", "tmp", "temp", "test", "tests", "pr", "pull", "merge", "backport", "draft", "try", "step", "part", "phase", "day", "week", "sprint", "build", "node", "python", "ubuntu", "macos", "windows", "then", "and", "or"]);

/** `me/summ-239-familiar-recolor` → `SUMM-239`. */
export function issueFromBranch(branch: string | undefined): string | undefined {
	if (!branch) return undefined;
	const pattern = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{0,14})-(\d{1,7})(?=$|[^0-9])/g;
	for (let match = pattern.exec(branch); match; match = pattern.exec(branch)) {
		const prefix = match[1]!;
		if (NOT_KEYS.has(prefix.toLowerCase())) {
			// Look again from inside this match, so `fix-12-abc-3` still finds ABC-3.
			pattern.lastIndex = match.index + 1;
			continue;
		}
		return `${prefix.toUpperCase()}-${match[2]}`;
	}
	return undefined;
}

export interface GitInfo {
	/** The main checkout's folder (the repository). */
	root: string;
	/** This checkout's folder. */
	top: string;
	branch?: string;
	/** True in a linked worktree. */
	linked: boolean;
}

export function gitInfo(cwd: string): GitInfo | undefined {
	const out = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel", "--abbrev-ref", "HEAD");
	if (!out) {
		const top = git(cwd, "rev-parse", "--show-toplevel");
		if (!top) return undefined;
		return { root: top, top, branch: git(cwd, "symbolic-ref", "--short", "-q", "HEAD"), linked: false };
	}
	const [common, top, head] = out.split("\n");
	if (!common || !top) return undefined;
	const root = basename(common) === ".git" ? dirname(common) : common.replace(/\.git$/, "");
	const branch = head && head !== "HEAD" ? head : git(cwd, "symbolic-ref", "--short", "-q", "HEAD");
	return { root: resolve(root), top: resolve(top), branch: branch || undefined, linked: resolve(root) !== resolve(top) };
}

/** Where a post made from `cwd` belongs: repository, worktree lane, branch, issue, session. */
export function detectWhere(cwd: string, env: Record<string, string | undefined> = process.env): Where {
	const session = env.AGENTS_DAILIES_SESSION || env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || undefined;
	const info = gitInfo(cwd);
	if (!info) {
		const name = basename(resolve(cwd)) || "home";
		return { project: name, lane: name, session, cwd: resolve(cwd) };
	}
	const project = basename(info.root) || "repo";
	const lane = info.linked ? basename(info.top) : (info.branch ?? "main");
	return { project, lane, branch: info.branch, issue: issueFromBranch(info.branch), session, cwd: resolve(cwd) };
}
