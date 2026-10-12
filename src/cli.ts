#!/usr/bin/env node
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { api, ApiError, ensureViewer, follow, health, openBrowser, write } from "./client.ts";
import { machineName, storeHome, version, viewerHost, viewerPort, viewerUrl } from "./config.ts";
import { collect, entryLine, parseSince, splitSections, summaryMarkdown, sweepTranscripts, type Sections } from "./devlog.ts";
import { describeChoices, describeFeedback, markDelivered, pendingFor } from "./feedback.ts";
import { guide, preToolUseHook, sessionEnd, sessionStart, stop, userPromptSubmit, type HookContext, type HookInput, type HookResult } from "./hook.ts";
import { dueForRefresh, fetchIssue, ISSUE_KEY, issueCommandFor, markFetched } from "./issues.ts";
import { commitsIn, landings, mainBranch, notOnMain } from "./landed.ts";
import { DailiesServer } from "./server.ts";
import { optionKey, postIdFrom, Store, type AmendEvent, type Catalog, type CommitRef, type DevlogChange, type IssueEvent, type Item, type Post, type PostView, type Question, type QuestionOption, type RetractEvent } from "./store.ts";
import { detectWhere, gitInfo, issueFromBranch } from "./where.ts";

class UsageError extends Error {}

const env = process.env;
const store = () => new Store(storeHome(env), machineName(env));

function fail(message: string): never {
	throw new UsageError(message);
}

/** Splits arguments into positionals and options; `values` take one argument, `lists` may repeat. */
function parse(argv: string[], spec: { flags?: string[]; values?: string[]; lists?: string[] }) {
	const flags = new Set<string>();
	const values = new Map<string, string>();
	const lists = new Map<string, string[]>();
	const positional: string[] = [];
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (arg === "--") {
			positional.push(...argv.slice(index + 1));
			break;
		}
		if (!arg.startsWith("-") || arg === "-") {
			positional.push(arg);
			continue;
		}
		const [name, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
		if (spec.flags?.includes(name)) {
			flags.add(name);
			continue;
		}
		if (spec.values?.includes(name) || spec.lists?.includes(name)) {
			const value = inline ?? argv[++index];
			if (value === undefined) fail(`${name} needs a value`);
			if (spec.lists?.includes(name)) lists.set(name, [...(lists.get(name) ?? []), value]);
			else values.set(name, value);
			continue;
		}
		fail(`unknown option ${name}`);
	}
	return { flags, values, lists, positional };
}

function readStdin(): string {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

/** `-` reads standard input. */
function textArg(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	return value === "-" ? readStdin() : value;
}

function durationMs(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value.trim());
	if (!match) fail(`cannot read the duration ${value} (try 90s, 30m, 2h)`);
	const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(match[2] ?? "s") as "s"];
	return Number(match[1]) * unit;
}

function print(text: string): void {
	process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function json(value: unknown): void {
	print(JSON.stringify(value, null, 2));
}

function size(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function addFiles(target: Store, paths: string[], base = process.cwd()): Promise<Item[]> {
	const items: Item[] = [];
	for (const path of paths) {
		const full = isAbsolute(path) ? path : resolve(base, path);
		if (!existsSync(full)) fail(`no such file: ${path}`);
		if (statSync(full).isDirectory()) fail(`${path} is a folder; show the files in it`);
		items.push(await target.addFile(full));
	}
	return items;
}

/** A file path, or the id (`i_…`) of a file already shown: a fresh item for the same stored file. */
async function fileOrItem(target: Store, catalog: Catalog, value: string): Promise<Item> {
	if (/^i_[a-z0-9]+$/.test(value) && !existsSync(value)) {
		const known = catalog.item(value);
		if (!known) fail(`no stored file ${value}`);
		const fresh = await target.addFile(target.blobPath(known.sha256, known.ext), known.name);
		return { ...fresh, source: known.source };
	}
	return (await addFiles(target, [value]))[0]!;
}

/** Fetches the issue in the background when a command is configured and it is due. */
function refreshIssueSoon(target: Store, key: string | undefined, project: string): void {
	if (!key || !issueCommandFor(project, env) || !dueForRefresh(target, key)) return;
	markFetched(target, key);
	try {
		const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "issue", key, "--refresh", "--quiet"], { detached: true, stdio: "ignore", env });
		child.unref();
	} catch {
		// the issue card can wait
	}
}

interface Posted {
	post: PostView;
	viewers: number;
	url: string;
}

async function publish(target: Store, body: unknown, noOpen: boolean): Promise<{ result: Posted; opened: boolean; offline: boolean }> {
	const base = await ensureViewer(target, env);
	const result = await write<Posted>(target, base, "/api/posts", body);
	let opened = false;
	if (base && !result.viewers && !noOpen) opened = openBrowser(result.url, env);
	return { result, opened, offline: !base };
}

function viewerLine(viewers: number, opened: boolean, offline: boolean): string {
	if (offline) return `The viewer could not start (see ${join(storeHome(env), "server.log")}); the post is kept and will show once it runs.`;
	if (viewers) return `The viewer is open in ${viewers} tab${viewers === 1 ? "" : "s"}; it updated in place. No need to open anything.`;
	if (opened) return "Opened the viewer in the browser.";
	return `No viewer tab is open; the user can open ${viewerUrl(env)}/ (kustomad open).`;
}

// show ------------------------------------------------------------------------

async function show(argv: string[]): Promise<void> {
	const args = parse(argv, { flags: ["--no-open", "--json"], values: ["--title", "--note", "--issue", "--lane"], lists: ["--tag"] });
	if (!args.positional.length) fail("show what? kustomad show <file>… --title \"…\"");
	const target = store();
	const items = await addFiles(target, args.positional);
	const where = detectWhere(process.cwd(), env);
	const issue = args.values.get("--issue")?.toUpperCase() ?? where.issue;
	const { result, opened, offline } = await publish(
		target,
		{ ...where, lane: args.values.get("--lane") ?? where.lane, issue, title: args.values.get("--title"), note: args.values.get("--note"), tags: args.lists.get("--tag") ?? [], items },
		args.flags.has("--no-open"),
	);
	refreshIssueSoon(target, issue, where.project);
	if (args.flags.has("--json")) return json(result);
	const lines = [`Shown ${items.length} file${items.length === 1 ? "" : "s"} in the viewer: ${result.url}`];
	result.post.items.forEach((item, index) => lines.push(`  ${index + 1}. ${item.name}  (${item.id})`));
	lines.push(viewerLine(result.viewers, opened, offline));
	print(lines.join("\n"));
}

// ask -------------------------------------------------------------------------

interface Sheet {
	title?: string;
	note?: string;
	questions: {
		text: string;
		why?: string;
		files?: string[];
		multi?: boolean;
		options: (string | { label?: string; body?: string; files?: string[] })[];
	}[];
}

async function questionsFromSheet(target: Store, file: string): Promise<{ title?: string; note?: string; items: Item[]; questions: Question[] }> {
	let sheet: Sheet;
	try {
		sheet = JSON.parse(readFileSync(file, "utf8")) as Sheet;
	} catch (error) {
		fail(`cannot read ${file}: ${(error as Error).message}`);
	}
	if (!Array.isArray(sheet.questions) || !sheet.questions.length) fail(`${file} has no "questions"`);
	const base = dirname(resolve(file));
	const items: Item[] = [];
	const add = async (paths: string[] | undefined) => {
		const added = await addFiles(target, paths ?? [], base);
		items.push(...added);
		return added.map((item) => item.id);
	};
	const questions: Question[] = [];
	for (const [index, raw] of sheet.questions.entries()) {
		if (!raw.text) fail(`question ${index + 1} has no "text"`);
		if (!Array.isArray(raw.options) || raw.options.length < 2) fail(`question ${index + 1} needs at least two options`);
		const options: QuestionOption[] = [];
		for (const [at, option] of raw.options.entries()) {
			const data = typeof option === "string" ? { label: option } : option;
			options.push({ id: `o${at + 1}`, key: optionKey(at), label: data.label, body: data.body, items: await add(data.files) });
		}
		questions.push({ id: `q${index + 1}`, text: raw.text, why: raw.why, items: await add(raw.files), options, multi: raw.multi || undefined });
	}
	return { title: sheet.title, note: sheet.note, items, questions };
}

async function ask(argv: string[]): Promise<void> {
	let text: string | undefined;
	let why: string | undefined;
	let title: string | undefined;
	let note: string | undefined;
	let sheet: string | undefined;
	let multi = false;
	let wait = false;
	let asJson = false;
	let noOpen = false;
	let anyway = false;
	const about: string[] = [];
	type Choice = { kind: "file"; path: string } | { kind: "pattern"; label: string; paths: string[] } | { kind: "text"; label: string };
	const choices: Choice[] = [];
	const value = (index: number, name: string) => {
		const next = argv[index + 1];
		if (next === undefined) fail(`${name} needs a value`);
		return next;
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		switch (arg) {
			case "--why":
				why = value(index++, arg);
				break;
			case "--title":
				title = value(index++, arg);
				break;
			case "--note":
				note = value(index++, arg);
				break;
			case "--file":
				sheet = value(index++, arg);
				break;
			case "--option":
				choices.push({ kind: "text", label: value(index++, arg) });
				break;
			case "--about":
				about.push(value(index++, arg));
				break;
			case "--pattern": {
				const label = value(index++, arg);
				const paths: string[] = [];
				while (index + 1 < argv.length && !argv[index + 1]!.startsWith("--")) paths.push(argv[++index]!);
				if (!paths.length) fail(`--pattern "${label}" needs the files that show it`);
				choices.push({ kind: "pattern", label, paths });
				break;
			}
			case "--multi":
				multi = true;
				break;
			case "--wait":
				wait = true;
				break;
			case "--json":
				asJson = true;
				break;
			case "--no-open":
				noOpen = true;
				break;
			case "--anyway":
				anyway = true;
				break;
			default:
				if (arg.startsWith("--")) fail(`unknown option ${arg}`);
				if (text === undefined && !sheet) text = arg;
				else choices.push({ kind: "file", path: arg });
		}
	}

	const target = store();
	let items: Item[] = [];
	let questions: Question[];
	if (sheet) {
		if (text !== undefined || choices.length) fail("--file takes the whole sheet; put the questions in it");
		const read = await questionsFromSheet(target, sheet);
		items = read.items;
		questions = read.questions;
		title ??= read.title;
		note ??= read.note;
	} else {
		if (!text) fail('ask what? kustomad ask "<question>" a.png b.png [--option "…"]');
		const files = choices.filter((choice) => choice.kind === "file");
		const patterns = choices.filter((choice) => choice.kind === "pattern");
		const sentences = choices.filter((choice) => choice.kind === "text");
		if (files.length === 1 && !patterns.length && sentences.length) {
			const path = (files[0] as { path: string }).path;
			fail(`one file next to sentences would make the file itself option A. To sign off on it, show it above the options: --about ${path}`);
		}
		if (choices.length < 2) {
			if (files.length === 1) fail(`one file alone is not a choice. To sign off on it: kustomad ask "${text}" --about ${(files[0] as { path: string }).path} --option "OK" --option "Redo it"`);
			fail("a question needs at least two options (files, --pattern groups or --option texts)");
		}
		if (!files.length && !patterns.length && !about.length && !anyway) {
			fail("nothing to look at: a question answered from words alone belongs in the terminal. (Add files or --about, or --anyway.)");
		}
		const aboutItems = await addFiles(target, about);
		items.push(...aboutItems);
		const options: QuestionOption[] = [];
		for (const [index, choice] of choices.entries()) {
			const option: QuestionOption = { id: `o${index + 1}`, key: optionKey(index), items: [] };
			if (choice.kind === "text") option.label = choice.label;
			else {
				const added = await addFiles(target, choice.kind === "file" ? [choice.path] : choice.paths);
				items.push(...added);
				option.items = added.map((item) => item.id);
				if (choice.kind === "pattern") option.label = choice.label;
			}
			options.push(option);
		}
		questions = [{ id: "q1", text, why, items: aboutItems.map((item) => item.id), options, multi: multi || undefined }];
		title ??= text;
	}

	const where = detectWhere(process.cwd(), env);
	const { result, opened, offline } = await publish(target, { ...where, title, note, tags: [], items, questions }, noOpen);
	refreshIssueSoon(target, where.issue, where.project);
	if (wait) return waitFor(result.post.id, 110 * 60_000, asJson);
	if (asJson) return json(result);
	const lines = [`Asked in the viewer: ${result.url}`];
	for (const question of result.post.questions ?? []) {
		lines.push(`  ${question.text}`);
		for (const id of question.items) lines.push(`    about: ${result.post.items.find((item) => item.id === id)?.name ?? id}`);
		for (const option of question.options) {
			const files = option.items.map((id) => result.post.items.find((item) => item.id === id)?.name ?? id);
			lines.push(`    ${option.key}. ${[option.label, files.join(", ")].filter(Boolean).join(" — ")}`);
		}
	}
	lines.push(viewerLine(result.viewers, opened, offline));
	lines.push(`Now start the wait in the background (Bash run_in_background, timeout 7200000): kustomad wait ${result.post.id}`);
	print(lines.join("\n"));
}

// wait / watch -------------------------------------------------------------------

function describePost(catalog: Catalog, post: Post): string {
	const lines = [`${post.title ? `"${post.title}"` : post.id} (${post.id})`];
	const answers = catalog.answersTo(post.id);
	for (const question of post.questions ?? []) {
		if ((post.questions?.length ?? 0) > 1 || question.text !== post.title) lines.push(`  ${question.text}`);
		for (const id of question.items) lines.push(`  about: ${catalog.item(id)?.name ?? id}`);
		const answer = answers[question.id];
		if (answer) lines.push(`  answered: ${describeChoices(post, answer, catalog)}${answer.text ? ` — "${answer.text}"` : ""}`);
		else lines.push("  not answered yet");
	}
	for (const comment of catalog.commentsOn(post.id)) {
		if (comment.by !== "human") continue;
		const file = comment.item ? ` on ${catalog.item(comment.item)?.name ?? comment.item}` : "";
		lines.push(`  comment${file}: "${comment.text}"`);
	}
	return lines.join("\n");
}

async function waitFor(postId: string, timeoutMs: number, asJson = false): Promise<void> {
	const target = store();
	const id = postIdFrom(postId);
	const startCount = target.load().commentsOn(id).filter((comment) => comment.by === "human").length;
	const done = () => {
		const catalog = target.load();
		const post = catalog.post(id);
		if (!post) fail(`no post ${id}`);
		const comments = catalog.commentsOn(id).filter((comment) => comment.by === "human").length;
		return !catalog.openQuestions(post).length || comments > startCount;
	};
	if (!target.load().post(id)) fail(`no post ${id}`);
	const finished = done() || (await follow(target, `/api/watch?post=${encodeURIComponent(id)}`, (type) => type === "feedback" && done(), { timeoutMs, env, onConnect: done }));
	const catalog = target.load();
	const post = catalog.post(id)!;
	if (post.session) markDelivered(target, post.session, catalog.history.filter((event) => event.post === id && event.by === "human"));
	if (asJson) {
		json({ post: catalog.view(post), finished });
	} else {
		print(describePost(catalog, post));
		if (!finished) print(`Still waiting. Run kustomad wait ${id} again (in the background) to keep waiting.`);
	}
	if (!finished) process.exitCode = 3;
}

async function waitCommand(argv: string[]): Promise<void> {
	const args = parse(argv, { flags: ["--json"], values: ["--timeout"] });
	const id = args.positional[0];
	if (!id) fail("wait for which post? kustomad wait <post-id>");
	return waitFor(id, durationMs(args.values.get("--timeout"), 110 * 60_000), args.flags.has("--json"));
}

async function watch(argv: string[]): Promise<void> {
	const args = parse(argv, { flags: ["--json"], values: ["--session", "--timeout"] });
	const session = args.values.get("--session") ?? env.CLAUDE_CODE_SESSION_ID ?? env.KUSTOMAD_SESSION;
	if (!session) fail("watch needs the agent session (CLAUDE_CODE_SESSION_ID or --session)");
	const target = store();
	const ready = () => {
		const catalog = target.load();
		return pendingFor(catalog, target, session).some((event) => event.type !== "verdict");
	};
	const finished = ready() || (await follow(target, `/api/watch?session=${encodeURIComponent(session)}`, (type) => type === "feedback" && ready(), { timeoutMs: durationMs(args.values.get("--timeout"), 110 * 60_000), env, onConnect: ready }));
	if (!finished) {
		print("No feedback yet. Start kustomad watch again (in the background) only while you still expect a reply.");
		process.exitCode = 3;
		return;
	}
	const catalog = target.load();
	const pending = pendingFor(catalog, target, session);
	markDelivered(target, session, pending);
	if (args.flags.has("--json")) return json(pending);
	print(`The user replied in the viewer:\n${describeFeedback(catalog, pending).map((line) => `- ${line}`).join("\n")}`);
}

// context / feedback / list / get --------------------------------------------------

function postText(target: Store, catalog: Catalog, post: PostView, selectedItem?: string): string {
	const lines = [`${post.kind === "devlog" ? "Devlog entry" : "Post"} ${post.id}${post.title ? `: "${post.title}"` : ""}`, `  ${post.at.slice(0, 16).replace("T", " ")} · ${post.project} · ${post.issue ?? post.lane}${post.session ? ` · session ${post.session}` : ""}`];
	if (post.note) lines.push(`  note: ${post.note}`);
	lines.push("  files:");
	for (const item of post.items) {
		const mark = item.id === selectedItem ? "  ← selected" : "";
		lines.push(`    ${item.name} (${item.kind}, ${size(item.size)}) ${item.id}${item.verdict ? ` [${item.verdict}]` : ""}${mark}\n      ${target.blobPath(item.sha256, item.ext)}`);
	}
	const answers = post.answers;
	for (const question of post.questions ?? []) {
		const answer = answers[question.id];
		lines.push(`  question: ${question.text}`);
		lines.push(answer ? `    answered: ${describeChoices(catalog.post(post.id), answer, catalog)}${answer.text ? ` — "${answer.text}"` : ""}` : "    not answered yet");
	}
	for (const comment of post.comments) {
		const file = comment.item ? ` on ${catalog.item(comment.item)?.name ?? comment.item}` : "";
		lines.push(`  ${comment.by === "human" ? "user" : "agent"}${file}: "${comment.text}"`);
	}
	return lines.join("\n");
}

async function context(argv: string[]): Promise<void> {
	const args = parse(argv, { flags: ["--json"] });
	const target = store();
	const base = viewerUrl(env);
	type Context = { selected: boolean; post: PostView | null; item: Item | null; selection: unknown };
	let result: Context | undefined;
	if (await health(base)) result = await api<Context>(base, "/api/context").catch(() => undefined);
	result ??= new DailiesServer(target).context();
	if (args.flags.has("--json")) return json(result);
	if (!result?.post) return print("Nothing has been shown yet.");
	const catalog = target.load();
	print(`${result.selected ? "Selected in the viewer" : "Nothing is selected; the newest post"}:\n${postText(target, catalog, result.post, result.item?.id)}`);
}

async function feedback(argv: string[]): Promise<void> {
	const args = parse(argv, { flags: ["--all", "--json"], values: ["--since"] });
	const target = store();
	const catalog = target.load();
	const since = parseSince(args.values.get("--since") ?? "24h");
	const where = detectWhere(process.cwd(), env);
	const events = catalog.history.filter((event) => {
		if (event.by !== "human" || event.at < since) return false;
		if (args.flags.has("--all")) return true;
		const post = catalog.post(event.post);
		return post?.project === where.project && post.lane === where.lane;
	});
	if (args.flags.has("--json")) return json(events);
	if (!events.length) return print(`No feedback since ${since.slice(0, 16).replace("T", " ")}${args.flags.has("--all") ? "" : " in this worktree (--all for everywhere)"}.`);
	const lines = describeFeedback(catalog, events);
	print(events.map((event, index) => `${event.at.slice(0, 16).replace("T", " ")} ${lines[index]}`).join("\n"));
}

async function list(argv: string[]): Promise<void> {
	const args = parse(argv, { flags: ["--all", "--json"], values: ["--limit"] });
	const catalog = store().load();
	const where = detectWhere(process.cwd(), env);
	const posts = catalog.list({ limit: Number(args.values.get("--limit")) || 20, kind: "review", ...(args.flags.has("--all") ? {} : { project: where.project, lane: where.lane }) });
	if (args.flags.has("--json")) return json(posts);
	if (!posts.length) return print("Nothing shown yet here (--all for everywhere).");
	const lines: string[] = [];
	for (const post of posts) {
		const open = catalog.openQuestions(post).length;
		lines.push(`${post.at.slice(0, 16).replace("T", " ")} ${post.id} ${post.title ?? post.items[0]?.name ?? ""}${open ? ` [${open} open]` : ""}${post.comments.length ? ` [${post.comments.length} comments]` : ""}`);
		for (const item of post.items) lines.push(`    ${item.id} ${item.name}`);
	}
	print(lines.join("\n"));
}

async function get(argv: string[]): Promise<void> {
	const args = parse(argv, { values: ["--to"] });
	const ref = args.positional[0];
	if (!ref) fail("get which file? kustomad get <item-id|post-id:n>");
	const target = store();
	const catalog = target.load();
	let item: Item | undefined;
	const indexed = /^(p_[a-z0-9]+):(\d+)$/.exec(ref);
	if (indexed) item = catalog.post(indexed[1]!)?.items[Number(indexed[2]) - 1];
	else item = catalog.item(ref);
	if (!item) fail(`no stored file ${ref}`);
	const path = target.blobPath(item.sha256, item.ext);
	const to = args.values.get("--to");
	if (!to) return print(path);
	const destination = existsSync(to) && statSync(to).isDirectory() ? join(to, item.name) : to;
	mkdirSync(dirname(resolve(destination)), { recursive: true });
	copyFileSync(path, destination);
	print(resolve(destination));
}

// issue ---------------------------------------------------------------------------

function issueText(issue: Partial<IssueEvent> & { key: string }): string {
	const lines = [`${issue.key}${issue.title ? ` ${issue.title}` : ""}`];
	const meta = [issue.status, issue.url].filter(Boolean).join(" · ");
	if (meta) lines.push(meta);
	if (issue.details?.length) lines.push(issue.details.join(" · "));
	if (issue.description) lines.push("", issue.description);
	return lines.join("\n");
}

async function issue(argv: string[]): Promise<void> {
	const args = parse(argv, { flags: ["--refresh", "--json", "--quiet"], values: ["--title", "--description", "--status", "--url"] });
	const where = detectWhere(process.cwd(), env);
	const key = (args.positional[0] ?? where.issue)?.toUpperCase();
	if (!key) fail("which issue? kustomad issue <KEY> (no issue key in this branch name)");
	if (!ISSUE_KEY.test(key)) fail(`${key} is not an issue key`);
	const target = store();
	const quiet = args.flags.has("--quiet");
	const setting = ["--title", "--description", "--status", "--url"].some((name) => args.values.has(name));
	let event: IssueEvent | undefined;
	if (args.flags.has("--refresh")) {
		const command = issueCommandFor(where.project, env);
		if (!command) fail(`no issue command configured: set "issueCommand" in ${join("~/.config/kustomad", "config.json")} or KUSTOMAD_ISSUE_COMMAND`);
		markFetched(target, key);
		const fields = await fetchIssue(command, key, process.cwd());
		const base = await ensureViewer(target, env);
		event = await write<IssueEvent>(target, base, "/api/issues", { key, ...fields, details: fields.details ?? [], by: "agent" });
	}
	if (setting) {
		const base = await ensureViewer(target, env);
		event = await write<IssueEvent>(target, base, "/api/issues", {
			key,
			title: args.values.get("--title"),
			description: textArg(args.values.get("--description")),
			status: args.values.get("--status"),
			url: args.values.get("--url"),
			merge: true,
			by: "agent",
		});
	}
	if (quiet) return;
	const current = event ?? target.load().issueEvent(key);
	if (args.flags.has("--json")) return json(current ?? null);
	if (!current) return print(`${key}: nothing recorded yet. Describe it with --title/--description, or --refresh with an issue command.`);
	print(issueText(current));
}

// devlog --------------------------------------------------------------------------

/** Files and ids after an option, up to the next option. */
function takeFiles(argv: string[], index: number): string[] {
	const out: string[] = [];
	while (index + 1 < argv.length && !argv[index + 1]!.startsWith("--")) out.push(argv[++index]!);
	return out;
}

interface DevlogArgs {
	positional: string[];
	values: Map<string, string>;
	flags: Set<string>;
	before?: string[];
	after?: string[];
}

function parseDevlog(argv: string[], values: string[], flags: string[]): DevlogArgs {
	const out: DevlogArgs = { positional: [], values: new Map(), flags: new Set() };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (arg === "--before" || arg === "--after") {
			const files = takeFiles(argv, index);
			index += files.length;
			if (!files.length) fail(`${arg} needs files (or i_… ids of files already shown)`);
			out[arg === "--before" ? "before" : "after"] = [...(out[arg === "--before" ? "before" : "after"] ?? []), ...files];
		} else if (values.includes(arg)) {
			const value = argv[++index];
			if (value === undefined) fail(`${arg} needs a value`);
			out.values.set(arg, value);
		} else if (flags.includes(arg)) out.flags.add(arg);
		else if (arg.startsWith("--")) fail(`unknown option ${arg}`);
		else out.positional.push(arg);
	}
	return out;
}

/** Sections from --summary (Markdown with ## 工夫 / ## 苦労 / ## 決めたこと) and the explicit options. */
function sectionsFrom(args: DevlogArgs): Sections {
	const summary = textArg(args.values.get("--summary"));
	const split = summary === undefined ? {} : splitSections(summary);
	const out: Sections = { ...split };
	for (const name of ["craft", "struggle", "decided"] as const) {
		const value = textArg(args.values.get(`--${name}`));
		if (value !== undefined) out[name] = value.trim();
	}
	return out;
}

const ONLY_MERGED = "only work merged into the main branch goes in the devlog: record it after the merge has landed";

async function devlogAdd(argv: string[]): Promise<void> {
	const args = parseDevlog(argv, ["--title", "--summary", "--craft", "--struggle", "--decided", "--issue", "--commits"], ["--json", "--no-open"]);
	if (args.positional.length) fail("files go after --before or --after");
	const title = args.values.get("--title");
	const sections = sectionsFrom(args);
	if (!title?.trim() && !sections.summary) fail('a devlog entry needs a title or a summary: --title "…" --summary -');
	const target = store();
	const catalog = target.load();
	const cwd = process.cwd();
	const where = detectWhere(cwd, env);
	const session = where.session;
	const recorded = catalog.recordedCommits();
	let commits: CommitRef[] = [];
	let issueKey = args.values.get("--issue")?.toUpperCase();
	const range = args.values.get("--commits");
	const info = gitInfo(cwd);
	const main = info ? mainBranch(cwd) : undefined;
	if (range === "none") {
		commits = [];
	} else if (range) {
		if (!info || !main) fail("--commits needs a git repository with a main branch");
		commits = commitsIn(cwd, range.includes("..") ? range : `${range}^!`);
		if (!commits.length) fail(`no commits in ${range}`);
		const missing = notOnMain(cwd, commits.map((commit) => commit.sha), main);
		if (missing.length) fail(`${missing.length} of these commits are not on ${main} yet; ${ONLY_MERGED}`);
		const already = commits.filter((commit) => recorded.has(commit.sha));
		if (already.length === commits.length) fail(`these commits are already in a devlog entry; correct that entry with kustomad devlog edit`);
		commits = commits.filter((commit) => !recorded.has(commit.sha));
	} else {
		const state = session ? target.readSession(session) : undefined;
		const landed = state ? landings(state, recorded) : [];
		if (landed.length) {
			commits = landed.flatMap((landing) => landing.commits.map((commit) => (landing.root === info?.root ? commit : { ...commit, repo: landing.project })));
			issueKey ??= landed.map((landing) => issueFromBranch(landing.from)).find(Boolean);
		} else if (state?.landing?.length && landings(state).length) {
			fail("the merged work of this session is already in a devlog entry; correct that entry with kustomad devlog edit <p_…>, or pass --commits A..B for other work");
		} else if (info && main && info.branch && info.branch !== main) {
			const ahead = commitsIn(cwd, `${main}..HEAD`);
			if (ahead.length) fail(`work on ${info.branch} is not on ${main} yet; ${ONLY_MERGED} (or --commits none for work without commits)`);
		}
	}
	issueKey ??= where.issue;

	const before: Item[] = [];
	const after: Item[] = [];
	for (const value of args.before ?? []) before.push(await fileOrItem(target, catalog, value));
	for (const value of args.after ?? []) after.push(await fileOrItem(target, catalog, value));
	const lane = info && main ? main : where.lane;
	const body = {
		...where,
		lane,
		branch: info && main ? main : where.branch,
		issue: issueKey,
		title,
		tags: [],
		items: [...before, ...after],
		kind: "devlog",
		devlog: { ...sections, before: before.map((item) => item.id), after: after.map((item) => item.id), commits },
	};
	const base = await ensureViewer(target, env);
	const result = await write<Posted>(target, base, "/api/posts", body);
	refreshIssueSoon(target, issueKey, where.project);
	if (args.flags.has("--json")) return json(result);
	const id = result.post.id;
	const lines = [`Recorded the devlog entry ${id} ("${result.post.title ?? sections.summary?.split("\n")[0]}"): ${result.url}`];
	lines.push(`  before ${before.length} · after ${after.length} · ${commits.length} commit${commits.length === 1 ? "" : "s"}${issueKey ? ` · ${issueKey}` : ""}`);
	if (!sections.craft && !sections.struggle) lines.push("No craft (工夫) or struggle (苦労) written: those are what devlog posts and videos are made of. Add them if there is anything to tell.");
	if (!before.length && !after.length) lines.push(`No before/after pair. If the change can be seen or heard, add both: kustomad devlog edit ${id} --before <file|i_…> --after <file|i_…>`);
	else if (!before.length || !after.length) lines.push(`Only ${before.length ? "a before" : "an after"}: add the other if it can be captured: kustomad devlog edit ${id} --${before.length ? "after" : "before"} <file|i_…>`);
	lines.push(`To correct it later: kustomad devlog edit ${id} --title/--summary/--before/--after … --reason "…"`);
	print(lines.join("\n"));
}

async function devlogEdit(argv: string[]): Promise<void> {
	const args = parseDevlog(argv, ["--title", "--summary", "--craft", "--struggle", "--decided", "--issue", "--reason"], ["--no-before", "--no-after", "--json"]);
	const [id, ...stray] = args.positional;
	if (!id) fail("which entry? kustomad devlog edit <p_…> (devlog list shows the ids)");
	if (stray.length) fail("files go after --before or --after");
	if (args.before && args.flags.has("--no-before")) fail("--before and --no-before cannot go together");
	if (args.after && args.flags.has("--no-after")) fail("--after and --no-after cannot go together");
	const target = store();
	const catalog = target.load();
	const entry = catalog.post(postIdFrom(id));
	if (!entry || entry.kind !== "devlog") fail(`no devlog entry ${postIdFrom(id)}`);
	if (entry.retracted) fail(`${entry.id} is retracted; bring it back first (kustomad devlog retract ${entry.id} --undo)`);
	const sections = sectionsFrom(args);
	const change: DevlogChange = {};
	for (const name of ["summary", "craft", "struggle", "decided"] as const) if (sections[name] !== undefined) change[name] = sections[name];
	const items: Item[] = [];
	for (const side of ["before", "after"] as const) {
		if (args.flags.has(`--no-${side}`)) change[side] = [];
		const values = args[side];
		if (!values) continue;
		const added: Item[] = [];
		for (const value of values) added.push(await fileOrItem(target, catalog, value));
		items.push(...added);
		change[side] = added.map((item) => item.id);
	}
	const body = {
		post: entry.id,
		title: args.values.get("--title"),
		issue: args.values.get("--issue"),
		devlog: Object.keys(change).length ? change : undefined,
		items,
		reason: args.values.get("--reason"),
		session: env.CLAUDE_CODE_SESSION_ID,
		by: "agent",
	};
	if (body.title === undefined && body.issue === undefined && !body.devlog) fail("nothing to change: give --title, --summary, --craft, --struggle, --decided, --before, --after, --no-before, --no-after or --issue");
	const base = await ensureViewer(target, env);
	const result = await write<{ post: PostView; amend: AmendEvent; url: string }>(target, base, "/api/amend", body);
	if (args.flags.has("--json")) return json(result);
	const fields = result.post.amended?.[result.post.amended.length - 1]?.fields ?? [];
	const devlog = result.post.devlog;
	const lines = [`Corrected the devlog entry ${result.post.id} ("${result.post.title ?? ""}"): ${fields.join(", ")}.`];
	lines.push(`  before ${devlog?.before.length ?? 0} · after ${devlog?.after.length ?? 0} · corrected ${result.post.amended?.length ?? 1}×. The entry as first recorded is kept.`);
	if (devlog && !devlog.before.length && devlog.after.length) lines.push("  It has only an after now.");
	else if (devlog && devlog.before.length && !devlog.after.length) lines.push("  It has only a before now.");
	print(lines.join("\n"));
}

async function devlogRetract(argv: string[]): Promise<void> {
	const args = parse(argv, { flags: ["--undo", "--json"], values: ["--reason"] });
	const id = args.positional[0];
	if (!id) fail("which entry? kustomad devlog retract <p_…>");
	const target = store();
	const base = await ensureViewer(target, env);
	const undo = args.flags.has("--undo");
	const result = await write<{ post: PostView; retract: RetractEvent }>(target, base, "/api/retract", { post: id, reason: args.values.get("--reason"), undo, session: env.CLAUDE_CODE_SESSION_ID, by: "agent" });
	if (args.flags.has("--json")) return json(result);
	print(undo ? `Brought back the devlog entry ${result.post.id} ("${result.post.title ?? ""}").` : `Retracted the devlog entry ${result.post.id} ("${result.post.title ?? ""}"). It stays in the store; kustomad devlog retract ${result.post.id} --undo brings it back.`);
}

async function devlogList(argv: string[]): Promise<void> {
	const args = parse(argv, { flags: ["--all", "--json"], values: ["--limit"] });
	const catalog = store().load();
	const posts = catalog.list({ kind: "devlog", limit: Number(args.values.get("--limit")) || 30, retracted: args.flags.has("--all") });
	if (args.flags.has("--json")) return json(posts);
	if (!posts.length) return print("No devlog entries yet.");
	print(posts.map((post) => entryLine(catalog, catalog.post(post.id)!)).join("\n"));
}

async function devlogSummary(argv: string[]): Promise<void> {
	const args = parse(argv, { flags: ["--json"], values: ["--since", "--until"] });
	const target = store();
	const catalog = target.load();
	const since = parseSince(args.values.get("--since") ?? "7d");
	const until = args.values.get("--until") ? parseSince(args.values.get("--until")!) : undefined;
	const summary = collect(catalog, target, { since, until });
	if (args.flags.has("--json")) return json(summary);
	print(summaryMarkdown(catalog, target, summary));
}

async function devlogSweep(): Promise<void> {
	const cwd = process.cwd();
	const info = gitInfo(cwd);
	const where = detectWhere(cwd, env);
	const [present, copied] = sweepTranscripts(store(), where.project, info?.root ?? cwd, env);
	print(`Kept ${present} transcript${present === 1 ? "" : "s"} of ${where.project} (${copied} new or grown) in ${join(storeHome(env), "transcripts", where.project)}.`);
}

async function devlog(argv: string[]): Promise<void> {
	const [sub, ...rest] = argv;
	switch (sub) {
		case "add":
			return devlogAdd(rest);
		case "edit":
			return devlogEdit(rest);
		case "retract":
			return devlogRetract(rest);
		case "list":
			return devlogList(rest);
		case "summary":
			return devlogSummary(rest);
		case "sweep":
			return devlogSweep();
		default:
			fail("kustomad devlog <add|edit|retract|list|summary|sweep> …");
	}
}

// viewer --------------------------------------------------------------------------

async function serve(argv: string[]): Promise<void> {
	const args = parse(argv, { values: ["--port", "--host"] });
	const target = store();
	const server = new DailiesServer(target, { host: args.values.get("--host") ?? viewerHost(env), onShutdown: () => process.exit(0) });
	await server.listen(Number(args.values.get("--port")) || viewerPort(env));
	console.log(`${new Date().toISOString()} kustomad ${version()} serving ${target.home} at ${server.url}`);
	const quit = () => void server.close().then(() => process.exit(0));
	process.on("SIGTERM", quit);
	process.on("SIGINT", quit);
}

async function open(): Promise<void> {
	const target = store();
	const base = await ensureViewer(target, env);
	if (!base) fail(`the viewer could not start; see ${join(target.home, "server.log")}`);
	const url = `${base}/`;
	if (!openBrowser(url, { ...env, KUSTOMAD_NO_OPEN: undefined })) print(`Open ${url}`);
	else print(`Opened ${url}`);
}

async function status(argv: string[]): Promise<void> {
	const args = parse(argv, { flags: ["--json"] });
	const base = viewerUrl(env);
	const running = await health(base);
	const info = { running: Boolean(running), url: `${base}/`, version: running?.version, cli: version(), viewers: running?.viewers ?? 0, pid: running?.pid, home: storeHome(env), machine: machineName(env) };
	if (args.flags.has("--json")) return json(info);
	print(
		running
			? `The viewer ${running.version} runs at ${info.url} (pid ${running.pid}), open in ${running.viewers} tab${running.viewers === 1 ? "" : "s"}.\nStore: ${info.home}`
			: `The viewer is not running (it starts with the next show). Store: ${info.home}`,
	);
}

async function stopViewer(): Promise<void> {
	const base = viewerUrl(env);
	if (!(await health(base))) return print("The viewer is not running.");
	await api(base, "/api/shutdown", { force: true });
	for (let tries = 0; tries < 30 && (await health(base, 300)); tries++) await new Promise((resolve) => setTimeout(resolve, 100));
	print("Stopped the viewer.");
}

// hooks ---------------------------------------------------------------------------

async function hook(argv: string[]): Promise<void> {
	const event = argv[0];
	let input: HookInput | undefined;
	try {
		const text = readStdin();
		input = text.trim() ? (JSON.parse(text) as HookInput) : undefined;
	} catch {
		input = undefined;
	}
	const target = store();
	const base = viewerUrl(env);
	const context: HookContext = {
		store: target,
		env,
		waiters: async (post) => {
			if (!(await health(base, 400))) return 0;
			const result = await api<{ watching: number }>(base, `/api/watchers?session=&post=${encodeURIComponent(post)}`);
			return result.watching;
		},
	};
	let result: HookResult;
	try {
		switch (event) {
			case "pre-tool-use":
				result = preToolUseHook(input, context);
				break;
			case "session-start":
				result = sessionStart(input, context);
				break;
			case "user-prompt-submit":
				result = userPromptSubmit(input, context);
				break;
			case "stop":
				result = await stop(input, context);
				break;
			case "session-end":
				result = sessionEnd(input, context);
				break;
			default:
				fail("kustomad hook <pre-tool-use|session-start|user-prompt-submit|stop|session-end>");
		}
	} catch (error) {
		if (error instanceof UsageError) throw error;
		// A hook must never get in the agent's way.
		return;
	}
	if (result.block && result.message) {
		process.stderr.write(`${result.message}\n`);
		process.exitCode = 2;
		return;
	}
	if (result.context) print(result.context);
}

const HELP = `KustomAD ${version()} — a live review page for what your coding agent makes

Usage:
  kustomad show <file>… [--title T] [--note N] [--tag X]… [--issue KEY] [--lane L] [--no-open] [--json]
      Put files at the top of the viewer (images, videos, audio, GLB, PDF, HTML, Markdown, text).
      Starts the viewer if needed; opens the browser only when no viewer tab is open.
  kustomad ask "<question>" [file…] [--pattern LABEL file…]… [--option TEXT]… [--about file]…
                    [--why TEXT] [--multi] [--wait] [--json]
  kustomad ask --file sheet.json [--wait] [--json]
      Ask the user to decide between things to look at: files, patterns and sentences become
      options A, B, C…; --about shows a file above the options (to sign off on one thing).
  kustomad wait <post-id> [--timeout 110m]   Block until the post's questions are answered
  kustomad watch [--session ID] [--timeout 110m]
                                      Block until the user comments on this session's posts
  kustomad context [--json]     What the user selected in the viewer (or the newest post)
  kustomad feedback [--since 24h] [--all] [--json]
  kustomad list [--limit N] [--all] [--json]
  kustomad get <item-id|post-id:n> [--to PATH]
  kustomad issue [KEY] [--refresh] [--title T] [--description TEXT|-] [--status S] [--url U] [--json]
  kustomad devlog add --title T --summary - [--before file|i_…] [--after file|i_…] [--commits A..B|none] [--issue KEY]
  kustomad devlog edit <p_…> [--title|--summary|--craft|--struggle|--decided|--before|--after|--no-before|--no-after|--issue] [--reason R]
  kustomad devlog retract <p_…> [--reason R] [--undo]
  kustomad devlog list [--all] | summary [--since 7d|ISO] [--until …] | sweep
  kustomad open | status | stop | serve [--port P] [--host H]
  kustomad guide                Instructions to give a coding agent (CLAUDE.md / AGENTS.md)
  kustomad hook <pre-tool-use|session-start|user-prompt-submit|stop|session-end>

Environment:
  KUSTOMAD_HOME      store (default $XDG_DATA_HOME/kustomad)
  KUSTOMAD_PORT      viewer port (default 4778)
  KUSTOMAD_HOST      address to listen on (default 127.0.0.1)
  KUSTOMAD_NO_OPEN=1 never open a browser from show
  KUSTOMAD_BROWSER   command to open URLs with
  KUSTOMAD_AUTO_WATCH=0  no Stop-hook reminder to wait on an unanswered question
  KUSTOMAD_DEVLOG=0      no Stop-hook devlog suggestion after a merge
  KUSTOMAD_ISSUE_COMMAND command printing an issue as JSON ({key} is replaced)
  KUSTOMAD_CONFIG        config file (default $XDG_CONFIG_HOME/kustomad/config.json)
`;

async function main(argv: string[]): Promise<void> {
	const [command, ...rest] = argv;
	switch (command) {
		case "show":
			return show(rest);
		case "ask":
			return ask(rest);
		case "wait":
			return waitCommand(rest);
		case "watch":
			return watch(rest);
		case "context":
			return context(rest);
		case "feedback":
			return feedback(rest);
		case "list":
			return list(rest);
		case "get":
			return get(rest);
		case "issue":
			return issue(rest);
		case "devlog":
			return devlog(rest);
		case "serve":
			return serve(rest);
		case "open":
			return open();
		case "status":
			return status(rest);
		case "stop":
			return stopViewer();
		case "guide":
			return print(guide());
		case "hook":
			return hook(rest);
		case "--version":
		case "-v":
		case "version":
			return print(version());
		case undefined:
		case "help":
		case "--help":
		case "-h":
			return print(HELP);
		default:
			fail(`unknown command ${command}; kustomad --help`);
	}
}

main(process.argv.slice(2)).catch((error: unknown) => {
	if (error instanceof UsageError || error instanceof ApiError) {
		process.stderr.write(`kustomad: ${error.message}\n`);
	} else {
		process.stderr.write(`kustomad: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	}
	process.exitCode = 1;
});
