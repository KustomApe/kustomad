import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { describeChoices } from "./feedback.ts";
import { mainBranch } from "./landed.ts";
import type { AnswerEvent, Catalog, CommitRef, Post, PostView, Store } from "./store.ts";
import { git } from "./where.ts";

export interface Sections {
	summary?: string;
	craft?: string;
	struggle?: string;
	decided?: string;
}

const HEADINGS: [keyof Sections, RegExp][] = [
	["craft", /^(工夫|craft|what worked)/i],
	["struggle", /^(苦労|struggle|what was hard|hard)/i],
	["decided", /^(決めた|決定|decided|decisions?)/i],
];

/** Splits Markdown into the summary and the 工夫 / 苦労 / 決めたこと sections (English headings too). */
export function splitSections(text: string): Sections {
	const out: Record<keyof Sections, string[]> = { summary: [], craft: [], struggle: [], decided: [] };
	let current: keyof Sections = "summary";
	for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
		const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
		if (heading) {
			const name = heading[1]!.replace(/[:：]\s*$/, "");
			const found = HEADINGS.find(([, pattern]) => pattern.test(name));
			if (found) {
				current = found[0];
				continue;
			}
		}
		out[current].push(line);
	}
	const clean = (lines: string[]) => lines.join("\n").trim() || undefined;
	return { summary: clean(out.summary), craft: clean(out.craft), struggle: clean(out.struggle), decided: clean(out.decided) };
}

/** `2h`, `3d`, `1w`, `90m`, an ISO time or `2026-10-01 18:00` → ISO. */
export function parseSince(value: string, now: number = Date.now()): string {
	const relative = /^(\d+(?:\.\d+)?)\s*(m|min|h|d|w)$/i.exec(value.trim());
	if (relative) {
		const unit = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[relative[2]!.toLowerCase() as "m"]!;
		return new Date(now - Number(relative[1]) * unit).toISOString();
	}
	const parsed = Date.parse(value.trim().replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, "$1T$2"));
	if (Number.isNaN(parsed)) throw new Error(`cannot read the time ${JSON.stringify(value)} (try 2h, 3d, or 2026-10-01 18:00)`);
	return new Date(parsed).toISOString();
}

export interface IssueSummary {
	key?: string;
	project: string;
	title?: string;
	status?: string;
	entries: PostView[];
}

export interface Decision {
	post: string;
	title?: string;
	question: string;
	answer: string;
	note?: string;
	at: string;
}

export interface TranscriptInfo {
	project: string;
	session: string;
	path: string;
	size: number;
	modified: string;
	prompts: string[];
}

export interface Summary {
	since: string;
	until: string;
	issues: IssueSummary[];
	decisions: Decision[];
	commits: (CommitRef & { project: string })[];
	transcripts: TranscriptInfo[];
}

/** Everything recorded in a period: entries by issue, decisions, commits and transcripts. */
export function collect(catalog: Catalog, store: Store, period: { since: string; until?: string }): Summary {
	const until = period.until ?? new Date(Date.now() + 1000).toISOString();
	const entries = catalog.list({ kind: "devlog", since: period.since, until }).reverse();
	const issues = new Map<string, IssueSummary>();
	for (const entry of entries) {
		const key = entry.issue ? `issue:${entry.issue}` : `project:${entry.project}`;
		let group = issues.get(key);
		if (!group) {
			const info = catalog.issue(entry.issue);
			group = { key: entry.issue, project: entry.project, title: info?.title, status: info?.status, entries: [] };
			issues.set(key, group);
		}
		group.entries.push(entry);
	}

	const decisions: Decision[] = [];
	for (const event of catalog.history) {
		if (event.type !== "answer" || event.by !== "human" || event.at < period.since || event.at >= until) continue;
		const post = catalog.post(event.post);
		const question = post?.questions?.find((candidate) => candidate.id === event.question);
		if (!post || !question || post.retracted) continue;
		decisions.push({ post: post.id, title: post.title, question: question.text, answer: describeChoices(post, event as AnswerEvent, catalog), note: event.text, at: event.at });
	}

	// Commits that landed on the main branch of every repository a post came from.
	const commits: Summary["commits"] = [];
	const repos = new Map<string, string>();
	for (const post of catalog.posts) if (post.cwd && !repos.has(post.project) && existsSync(post.cwd)) repos.set(post.project, post.cwd);
	for (const [project, cwd] of repos) {
		const main = mainBranch(cwd);
		if (!main) continue;
		const out = git(cwd, "log", main, "--no-merges", `--since=${period.since}`, `--until=${until}`, "--format=%H%x09%cI%x09%s");
		for (const line of out?.split("\n").filter(Boolean) ?? []) {
			const [sha, at, ...subject] = line.split("\t");
			commits.push({ sha: sha!, at, subject: subject.join("\t"), project });
		}
	}

	return { since: period.since, until, issues: [...issues.values()], decisions, commits, transcripts: transcriptsIn(store, period.since, until) };
}

function names(catalog: Catalog, ids: string[]): string {
	return ids.map((id) => catalog.item(id)?.name ?? id).join(", ");
}

function corrected(post: Post): string | undefined {
	const notes = post.amended;
	if (!notes?.length) return undefined;
	const last = notes[notes.length - 1]!;
	const reason = [...notes].reverse().find((note) => note.reason)?.reason;
	const times = notes.length > 1 ? ` ${notes.length} times` : "";
	return `(Corrected${times}, last ${last.at.slice(0, 16)}${reason ? `: ${reason}` : ""})`;
}

/** The period as Markdown, to write an update or a devlog post from. */
export function summaryMarkdown(catalog: Catalog, store: Store, summary: Summary): string {
	const lines: string[] = [];
	lines.push(`# Devlog material, ${summary.since.slice(0, 16)} – ${summary.until.slice(0, 16)}`);
	lines.push("");
	if (!summary.issues.length && !summary.decisions.length && !summary.commits.length) {
		lines.push("Nothing was recorded in this period.");
		return `${lines.join("\n")}\n`;
	}
	if (summary.issues.length) {
		lines.push("## Entries");
		for (const group of summary.issues) {
			lines.push("");
			const head = group.key ? `${group.key}${group.title ? ` ${group.title}` : ""}${group.status ? ` [${group.status}]` : ""}` : group.project;
			lines.push(`## ${head}`);
			for (const entry of group.entries) {
				lines.push("");
				lines.push(`### ${entry.title ?? "(untitled)"}`);
				lines.push(`${entry.at.slice(0, 16)} · ${entry.project}${entry.issue ? ` · ${entry.issue}` : ""} · ${entry.id}`);
				const note = corrected(entry);
				if (note) lines.push(note);
				const devlog = entry.devlog;
				if (devlog?.summary) lines.push("", devlog.summary);
				if (devlog?.craft) lines.push("", `Craft (工夫):\n${devlog.craft}`);
				if (devlog?.struggle) lines.push("", `Struggle (苦労):\n${devlog.struggle}`);
				if (devlog?.decided) lines.push("", `Decided (決めたこと):\n${devlog.decided}`);
				const files: string[] = [];
				if (devlog?.before.length) files.push(`Before: ${names(catalog, devlog.before)}`);
				if (devlog?.after.length) files.push(`After: ${names(catalog, devlog.after)}`);
				if (files.length) {
					lines.push("");
					lines.push(...files);
					const paths = [...(devlog?.before ?? []), ...(devlog?.after ?? [])]
						.map((id) => catalog.item(id))
						.filter((item) => item !== undefined)
						.map((item) => `  ${item.name}: ${store.blobPath(item.sha256, item.ext)}`);
					lines.push("Files:", ...paths);
				}
				if (devlog?.commits.length) {
					lines.push("", "Commits:");
					for (const commit of devlog.commits) lines.push(`- ${commit.sha.slice(0, 9)} ${commit.subject}`);
				}
			}
		}
		lines.push("");
	}
	if (summary.decisions.length) {
		lines.push("## Decisions in the viewer", "");
		for (const decision of summary.decisions) {
			lines.push(`- ${decision.at.slice(0, 16)} "${decision.question}" → ${decision.answer}${decision.note ? ` — "${decision.note}"` : ""}${decision.title ? ` (${decision.title})` : ""}`);
		}
		lines.push("");
	}
	if (summary.commits.length) {
		lines.push("## Commits on the main branch", "");
		for (const commit of summary.commits) lines.push(`- ${commit.project} ${commit.sha.slice(0, 9)} ${commit.at?.slice(0, 16) ?? ""} ${commit.subject}`);
		lines.push("");
	}
	if (summary.transcripts.length) {
		lines.push("## Agent transcripts", "");
		for (const transcript of summary.transcripts) {
			lines.push(`- ${transcript.project} ${transcript.session} (${Math.round(transcript.size / 1024)} KB, ${transcript.modified.slice(0, 16)}): ${transcript.path}`);
			for (const prompt of transcript.prompts) lines.push(`  > ${prompt}`);
		}
		lines.push("");
	}
	return `${lines.join("\n")}\n`;
}

/** One line per entry for `devlog list`. */
export function entryLine(catalog: Catalog, post: Post): string {
	const devlog = post.devlog;
	const marks: string[] = [];
	if (post.amended?.length) marks.push(`[edited ${post.amended.length}×]`);
	if (post.retracted) marks.push(`[retracted${post.retracted.reason ? `: ${post.retracted.reason}` : ""}]`);
	const files = devlog ? ` · before ${devlog.before.length} · after ${devlog.after.length}` : "";
	const issue = post.issue ? ` ${post.issue}` : "";
	const head = `${post.at.slice(0, 16).replace("T", " ")}${issue} ${post.title ?? "(untitled)"} (${post.id})${marks.length ? ` ${marks.join(" ")}` : ""}`;
	const summary = devlog?.summary ? `\n    ${devlog.summary.split("\n")[0]}` : "";
	return `${head}${files}${summary}${devlog?.before.length ? `\n    before: ${names(catalog, devlog.before)}` : ""}${devlog?.after.length ? `\n    after: ${names(catalog, devlog.after)}` : ""}`;
}

// Transcripts ---------------------------------------------------------------

export function claudeProjectsDir(env: Record<string, string | undefined> = process.env): string {
	return join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

/** Copies a Claude Code transcript into the store, before Claude Code cleans it up. */
export function keepTranscript(store: Store, project: string, path: string, session: string = basename(path, ".jsonl")): boolean {
	if (!existsSync(path)) return false;
	const dir = join(store.home, "transcripts", project.replace(/[^A-Za-z0-9_.-]/g, "_"));
	const target = join(dir, `${session.replace(/[^A-Za-z0-9_.-]/g, "_")}.jsonl`);
	const size = statSync(path).size;
	if (existsSync(target) && statSync(target).size >= size) return false;
	mkdirSync(dir, { recursive: true });
	copyFileSync(path, target);
	return true;
}

/** Keeps every transcript of a repository and its worktrees. Returns [present, copied now]. */
export function sweepTranscripts(store: Store, project: string, root: string, env: Record<string, string | undefined> = process.env): [number, number] {
	const projects = claudeProjectsDir(env);
	if (!existsSync(projects)) return [0, 0];
	// Claude Code names the folder after the path it was started in, which may be the
	// unresolved one (macOS: /var/… for /private/var/…).
	const roots = new Set([root, root.replace(/^\/private(?=\/)/, "")]);
	const prefixes = [...roots].map((path) => path.replace(/[^A-Za-z0-9]/g, "-"));
	let present = 0;
	let copied = 0;
	for (const folder of readdirSync(projects)) {
		if (!prefixes.some((prefix) => folder === prefix || folder.startsWith(`${prefix}-`))) continue;
		const dir = join(projects, folder);
		let files: string[];
		try {
			files = readdirSync(dir).filter((file) => file.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const file of files) {
			present += 1;
			if (keepTranscript(store, project, join(dir, file))) copied += 1;
		}
	}
	return [present, copied];
}

function userPrompts(path: string, limit = 3): string[] {
	const prompts: string[] = [];
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return prompts;
	}
	for (const line of text.split("\n")) {
		if (prompts.length >= limit) break;
		if (!line.includes('"user"')) continue;
		try {
			const event = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
			if (event.type !== "user" || event.message?.role !== "user") continue;
			const content = event.message.content;
			const value = typeof content === "string" ? content : Array.isArray(content) ? (content.find((part: { type?: string }) => part?.type === "text") as { text?: string } | undefined)?.text : undefined;
			if (!value || value.startsWith("<")) continue;
			prompts.push(value.replace(/\s+/g, " ").slice(0, 160));
		} catch {
			// not JSON
		}
	}
	return prompts;
}

export function transcriptsIn(store: Store, since: string, until: string): TranscriptInfo[] {
	const root = join(store.home, "transcripts");
	if (!existsSync(root)) return [];
	const out: TranscriptInfo[] = [];
	for (const project of readdirSync(root)) {
		const dir = join(root, project);
		let files: string[];
		try {
			files = readdirSync(dir).filter((file) => file.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const file of files) {
			const path = join(dir, file);
			const stat = statSync(path);
			const modified = stat.mtime.toISOString();
			if (modified < since || stat.birthtime.toISOString() >= until) continue;
			out.push({ project, session: file.slice(0, -6), path, size: stat.size, modified, prompts: userPrompts(path) });
		}
	}
	return out.sort((a, b) => (a.modified < b.modified ? -1 : 1));
}
