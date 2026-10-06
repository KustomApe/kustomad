import { resolve } from "node:path";
import { simpleCommands } from "./shell.ts";
import type { CommitRef, SessionState } from "./store.ts";
import { git, gitInfo } from "./where.ts";

export interface GitStep {
	cwd: string;
	kind: "merge" | "commit";
	ref?: string;
}

/** Options of `git merge` that take a value. */
const MERGE_VALUE = new Set(["-m", "-F", "-s", "-X", "--strategy", "--strategy-option", "--file", "--message", "--cleanup", "--into-name", "-S", "--gpg-sign"]);

/** The merges and commits a shell command runs, following `cd` and `git -C`. */
export function gitSteps(command: string, cwd: string): GitStep[] {
	const steps: GitStep[] = [];
	let here = cwd;
	for (const words of simpleCommands(command)) {
		const args = stripAssignments(words);
		if (args[0] === "cd" && args[1]) {
			here = resolve(here, args[1]);
			continue;
		}
		if (args[0] !== "git") continue;
		let index = 1;
		let dir = here;
		while (index < args.length && args[index]!.startsWith("-")) {
			const flag = args[index]!;
			if (flag === "-C" && args[index + 1]) {
				dir = resolve(dir, args[index + 1]!);
				index += 2;
			} else if (flag === "-c" || flag === "--git-dir" || flag === "--work-tree") index += 2;
			else index += 1;
		}
		const sub = args[index];
		const rest = args.slice(index + 1);
		if (sub === "merge") {
			if (rest.some((arg) => arg === "--abort" || arg === "--continue" || arg === "--quit")) continue;
			let ref: string | undefined;
			for (let at = 0; at < rest.length; at++) {
				const arg = rest[at]!;
				if (MERGE_VALUE.has(arg)) {
					at += 1;
					continue;
				}
				if (arg.startsWith("-")) continue;
				ref = arg;
			}
			if (ref) steps.push({ cwd: dir, kind: "merge", ref });
		} else if (sub === "commit") {
			steps.push({ cwd: dir, kind: "commit" });
		} else if (sub === "pull") {
			steps.push({ cwd: dir, kind: "merge", ref: "FETCH_HEAD" });
		}
	}
	return steps;
}

function stripAssignments(words: string[]): string[] {
	let index = 0;
	while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index++;
	if (words[index] === "sudo" || words[index] === "command" || words[index] === "nohup") index++;
	return words.slice(index);
}

/** The repository's main branch: origin's HEAD, else main or master. */
export function mainBranch(cwd: string): string | undefined {
	const remote = git(cwd, "symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD");
	if (remote) return remote.replace(/^origin\//, "");
	for (const name of ["main", "master", "trunk", "develop"]) if (git(cwd, "rev-parse", "--verify", "-q", `refs/heads/${name}`)) return name;
	return undefined;
}

export interface Landing {
	/** The repository folder. */
	root: string;
	project: string;
	main: string;
	/** The merged branch, when it was a merge. */
	from?: string;
	commits: CommitRef[];
	/** Ids of the noted steps this landing came from. */
	keys: string[];
}

export function commitsIn(cwd: string, range: string): CommitRef[] {
	const out = git(cwd, "log", "--no-merges", "--format=%H%x09%cI%x09%s", range);
	if (!out) return [];
	return out
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [sha, at, ...subject] = line.split("\t");
			return { sha: sha!, at, subject: subject.join("\t") };
		});
}

/** Notes what a command is about to do, for `landings` to check once it ran. */
export function noteSteps(state: SessionState, command: string, cwd: string): boolean {
	const steps = gitSteps(command, cwd);
	if (!steps.length) return false;
	state.landing ??= [];
	for (const step of steps) {
		const info = gitInfo(step.cwd);
		if (!info) continue;
		const base = git(step.cwd, "rev-parse", "HEAD");
		const branch = info.branch;
		const main = mainBranch(step.cwd);
		// A merge counts when it runs on the main branch; a commit counts when made right on it.
		if (!main || branch !== main) continue;
		state.landing.push({ cwd: info.top, kind: step.kind, ref: step.ref, base, at: new Date().toISOString() });
	}
	return true;
}

/** Merges and main-branch commits the session noted that have since landed. */
export function landings(state: SessionState, recorded: Set<string> = new Set()): Landing[] {
	const out: Landing[] = [];
	for (const [index, step] of (state.landing ?? []).entries()) {
		const key = `${step.at}#${index}`;
		const info = gitInfo(step.cwd);
		if (!info || !step.base) continue;
		const main = mainBranch(step.cwd);
		if (!main) continue;
		const head = git(step.cwd, "rev-parse", main);
		if (!head || head === step.base) continue;
		// Landed: the main branch moved on from where it was, and still contains that point.
		if (git(step.cwd, "merge-base", "--is-ancestor", step.base, main) === undefined) continue;
		const commits = commitsIn(step.cwd, `${step.base}..${main}`).filter((commit) => !recorded.has(commit.sha));
		if (!commits.length) continue;
		const project = info.root.split(/[\\/]/).pop() ?? "repo";
		const existing = out.find((landing) => landing.root === info.root);
		if (existing) {
			for (const commit of commits) if (!existing.commits.some((known) => known.sha === commit.sha)) existing.commits.push(commit);
			existing.keys.push(key);
			if (step.kind === "merge" && step.ref && !existing.from) existing.from = step.ref;
			continue;
		}
		out.push({ root: info.root, project, main, from: step.kind === "merge" ? step.ref : undefined, commits, keys: [key] });
	}
	return out;
}

/** Whether every commit is on the main branch. */
export function notOnMain(cwd: string, shas: string[], main: string): string[] {
	return shas.filter((sha) => git(cwd, "merge-base", "--is-ancestor", sha, main) === undefined);
}
