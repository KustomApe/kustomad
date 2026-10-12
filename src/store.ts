import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFileSync, copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { describe, type Kind } from "./media.ts";

export type { Kind } from "./media.ts";
export type Verdict = "adopted" | "rejected";
export type Author = "human" | "agent";

export interface Item {
	id: string;
	sha256: string;
	ext: string;
	name: string;
	mime: string;
	kind: Kind;
	size: number;
	/** The absolute path the file was taken from. */
	source?: string;
}

/** Where a post was made: repository, worktree lane, branch, issue, agent session. */
export interface Where {
	project: string;
	lane: string;
	branch?: string;
	issue?: string;
	session?: string;
	cwd?: string;
}

export interface QuestionOption {
	id: string;
	/** A, B, C… */
	key: string;
	label?: string;
	/** Markdown under the label. */
	body?: string;
	/** Files that show this option. */
	items: string[];
}

export interface Question {
	id: string;
	text: string;
	/** Markdown: the agent's recommendation and why. */
	why?: string;
	/** Files the question is about, shown above the options. */
	items: string[];
	options: QuestionOption[];
	/** Several options may be chosen. */
	multi?: boolean;
}

export interface CommitRef {
	sha: string;
	subject: string;
	at?: string;
	/** The repository it landed in, when it is not the post's own. */
	repo?: string;
}

export interface DevlogInfo {
	summary?: string;
	craft?: string;
	struggle?: string;
	decided?: string;
	before: string[];
	after: string[];
	commits: CommitRef[];
}

export interface PostEvent extends Where {
	type: "post";
	id: string;
	at: string;
	machine: string;
	title?: string;
	note?: string;
	tags: string[];
	items: Item[];
	questions?: Question[];
	kind?: "devlog";
	devlog?: DevlogInfo;
}

export interface VerdictEvent {
	type: "verdict";
	id: string;
	at: string;
	machine: string;
	post: string;
	item: string;
	verdict: Verdict | null;
	by: Author;
}

export interface CommentEvent {
	type: "comment";
	id: string;
	at: string;
	machine: string;
	post: string;
	/** Set when the note is about one file of the post. */
	item?: string;
	text: string;
	by: Author;
}

export interface AnswerEvent {
	type: "answer";
	id: string;
	at: string;
	machine: string;
	post: string;
	question: string;
	/** Option ids. */
	choices: string[];
	text?: string;
	by: Author;
}

export interface IssueEvent {
	type: "issue";
	id: string;
	at: string;
	machine: string;
	/** Upper case, e.g. SUMM-239. */
	key: string;
	title?: string;
	description?: string;
	status?: string;
	url?: string;
	/** Project, milestone, labels… */
	details?: string[];
	by: Author;
}

/** What a correction changes in a devlog entry; an empty text clears that section. */
export interface DevlogChange {
	summary?: string;
	craft?: string;
	struggle?: string;
	decided?: string;
	before?: string[];
	after?: string[];
}

export interface AmendEvent {
	type: "amend";
	id: string;
	at: string;
	machine: string;
	post: string;
	title?: string;
	issue?: string;
	devlog?: DevlogChange;
	/** Files this correction brings in. */
	items?: Item[];
	reason?: string;
	session?: string;
	by: Author;
}

export interface RetractEvent {
	type: "retract";
	id: string;
	at: string;
	machine: string;
	post: string;
	reason?: string;
	/** Brings a retracted entry back. */
	undo?: boolean;
	session?: string;
	by: Author;
}

/** Where an idea stands, from a loose thought to done (or dropped). */
export type IdeaStatus = "idea" | "candidate" | "doing" | "done" | "dropped";
export const IDEA_STATUSES: readonly IdeaStatus[] = ["idea", "candidate", "doing", "done", "dropped"];

/** A note in the idea board: an idea or something to implement. */
export interface IdeaEvent {
	type: "idea";
	id: string;
	at: string;
	machine: string;
	title: string;
	/** Markdown. */
	body?: string;
	status: IdeaStatus;
	/** The repository it is for; none for ideas about everything. */
	project?: string;
	session?: string;
	by: Author;
}

/** A change to an idea; an empty text clears that field. */
export interface IdeaChangeEvent {
	type: "idea-change";
	id: string;
	at: string;
	machine: string;
	idea: string;
	title?: string;
	body?: string;
	status?: IdeaStatus;
	project?: string;
	session?: string;
	by: Author;
}

export type DailiesEvent = PostEvent | VerdictEvent | CommentEvent | AnswerEvent | IssueEvent | AmendEvent | RetractEvent | IdeaEvent | IdeaChangeEvent;
export type FeedbackEvent = VerdictEvent | CommentEvent | AnswerEvent;

export interface AmendNote {
	id: string;
	at: string;
	reason?: string;
	fields: string[];
}

/** A post as it reads now: corrections applied. */
export interface Post extends PostEvent {
	amended?: AmendNote[];
	retracted?: { at: string; reason?: string };
}

export interface ItemView extends Item {
	verdict: Verdict | null;
}

export interface PostView extends Omit<Post, "items"> {
	items: ItemView[];
	comments: CommentEvent[];
	/** The latest answer to each question, by question id. */
	answers: Record<string, AnswerEvent>;
	/** The entry as first recorded, when it has been corrected since. */
	original?: PostEvent;
}

export interface IssueInfo {
	key: string;
	title?: string;
	description?: string;
	status?: string;
	url?: string;
	details?: string[];
	at: string;
}

export interface ListFilter {
	limit?: number;
	/** Only posts older than this post. */
	before?: string;
	project?: string;
	lane?: string;
	issue?: string;
	session?: string;
	q?: string;
	/** Only posts with a question still open. */
	open?: boolean;
	kind?: "devlog" | "review";
	since?: string;
	until?: string;
	/** Include retracted entries. */
	retracted?: boolean;
}

export interface SessionNode {
	session: string;
	first: string;
	last: string;
	count: number;
	title: string;
	open: number;
}

export interface GroupNode {
	id: string;
	project: string;
	issue?: string;
	lane: string;
	branch?: string;
	title: string;
	status?: string;
	count: number;
	last: string;
	open: number;
	sessions: SessionNode[];
}

export interface ProjectNode {
	project: string;
	last: string;
	groups: GroupNode[];
}

export interface Selection {
	post: string | null;
	item?: string;
	at: string;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function optionKey(index: number): string {
	return index < LETTERS.length ? LETTERS[index]! : `${LETTERS[Math.floor(index / LETTERS.length) - 1]}${LETTERS[index % LETTERS.length]}`;
}

/** A sortable, unique id: prefix, time in base 36, random tail. */
export function newId(prefix: string, at: Date = new Date()): string {
	return `${prefix}_${at.getTime().toString(36)}${randomBytes(4).toString("hex").slice(0, 6)}`;
}

/** `me/summ-239-familiar-recolor` with SUMM-239 → `familiar recolor`. */
export function titleFromBranch(branch: string | undefined, issue: string | undefined): string | undefined {
	if (!branch || !issue) return undefined;
	const lower = branch.toLowerCase();
	const at = lower.indexOf(issue.toLowerCase());
	if (at < 0) return undefined;
	const rest = branch
		.slice(at + issue.length)
		.replace(/^[-_/.\s]+/, "")
		.replace(/[-_]+/g, " ")
		.trim();
	return rest || undefined;
}

/** The post id in an id or in a viewer URL (`http://…/#p_…`). */
export function postIdFrom(value: string): string {
	const match = /(p_[a-z0-9]+)\s*$/.exec(value.trim());
	return match ? match[1]! : value.trim();
}

export interface PostInput extends Where {
	title?: string;
	note?: string;
	tags?: string[];
	items: Item[];
	questions?: Question[];
	kind?: "devlog";
	devlog?: Partial<DevlogInfo>;
}

export function buildPost(input: PostInput, machine: string, at: Date = new Date()): PostEvent {
	const items = input.items ?? [];
	const questions = input.questions?.length ? input.questions : undefined;
	const isDevlog = input.kind === "devlog";
	if (!items.length && !questions && !isDevlog) throw new Error("a post needs at least one item");
	if (!input.project || !input.lane) throw new Error("a post needs a project and a lane");
	const known = new Set(items.map((item) => item.id));
	const check = (ids: string[] | undefined) => {
		for (const id of ids ?? []) if (!known.has(id)) throw new Error(`unknown item ${id}`);
	};
	if (questions) {
		const seen = new Set<string>();
		for (const question of questions) {
			if (seen.has(question.id)) throw new Error(`each question needs its own id (${question.id} twice)`);
			seen.add(question.id);
			if (!question.text?.trim()) throw new Error("a question needs text");
			if (!question.options?.length) throw new Error(`question ${question.id} has no options`);
			check(question.items);
			const optionIds = new Set<string>();
			for (const option of question.options) {
				if (optionIds.has(option.id)) throw new Error(`each option needs its own id (${option.id} twice)`);
				optionIds.add(option.id);
				check(option.items);
			}
		}
	}
	let devlog: DevlogInfo | undefined;
	if (isDevlog) {
		devlog = {
			summary: input.devlog?.summary || undefined,
			craft: input.devlog?.craft || undefined,
			struggle: input.devlog?.struggle || undefined,
			decided: input.devlog?.decided || undefined,
			before: input.devlog?.before ?? [],
			after: input.devlog?.after ?? [],
			commits: input.devlog?.commits ?? [],
		};
		check(devlog.before);
		check(devlog.after);
		if (!input.title?.trim() && !devlog.summary) throw new Error("a devlog entry needs a title or a summary");
	}
	const post: PostEvent = {
		type: "post",
		id: newId("p", at),
		at: at.toISOString(),
		machine,
		project: input.project,
		lane: input.lane,
		branch: input.branch || undefined,
		issue: input.issue ? input.issue.toUpperCase() : undefined,
		session: input.session || undefined,
		cwd: input.cwd || undefined,
		title: input.title?.trim() || undefined,
		note: input.note?.trim() || undefined,
		tags: input.tags ?? [],
		items,
		questions: questions?.map((question) => ({
			id: question.id,
			text: question.text.trim(),
			why: question.why?.trim() || undefined,
			items: question.items ?? [],
			options: question.options.map((option) => ({
				id: option.id,
				key: option.key,
				label: option.label?.trim() || undefined,
				body: option.body?.trim() || undefined,
				items: option.items ?? [],
			})),
			multi: question.multi || undefined,
		})),
		kind: isDevlog ? "devlog" : undefined,
		devlog,
	};
	return JSON.parse(JSON.stringify(post)) as PostEvent;
}

export interface AmendInput {
	post: string;
	title?: string;
	issue?: string;
	devlog?: DevlogChange;
	items?: Item[];
	reason?: string;
	session?: string;
	by?: Author;
}

const DEVLOG_TEXT = ["summary", "craft", "struggle", "decided"] as const;

/** The devlog entry a correction or retraction is for, checked. */
function entryFor(catalog: Catalog, value: string): Post {
	const id = postIdFrom(value);
	const post = catalog.post(id);
	if (!post) throw new Error(`no devlog entry ${id}`);
	if (post.kind !== "devlog") throw new Error(`${id} is not a devlog entry`);
	return post;
}

export function buildAmend(input: AmendInput, catalog: Catalog, machine: string, at: Date = new Date()): AmendEvent {
	const post = entryFor(catalog, input.post);
	if (post.retracted) throw new Error(`${post.id} is retracted; bring it back first (devlog retract ${post.id} --undo)`);
	const change: DevlogChange = {};
	for (const field of DEVLOG_TEXT) if (input.devlog?.[field] !== undefined) change[field] = input.devlog[field]!.trim();
	const items = input.items ?? [];
	const usable = new Set([...items.map((item) => item.id), ...post.items.map((item) => item.id)]);
	for (const side of ["before", "after"] as const) {
		const ids = input.devlog?.[side];
		if (ids === undefined) continue;
		for (const id of ids) if (!usable.has(id)) throw new Error(`${id} is not a file of this correction or of the entry`);
		change[side] = ids;
	}
	const title = input.title === undefined ? undefined : input.title.trim();
	const issue = input.issue === undefined ? undefined : input.issue.trim().toUpperCase();
	if (title === undefined && issue === undefined && !Object.keys(change).length) throw new Error("nothing to change: give a title, sections, before/after or an issue");
	const nextTitle = title ?? post.title;
	const nextSummary = change.summary ?? post.devlog?.summary;
	if (!nextTitle && !nextSummary) throw new Error("a devlog entry needs a title or a summary");
	const event: AmendEvent = {
		type: "amend",
		id: newId("e", at),
		at: at.toISOString(),
		machine,
		post: post.id,
		title,
		issue,
		devlog: Object.keys(change).length ? change : undefined,
		items: items.length ? items : undefined,
		reason: input.reason?.trim() || undefined,
		session: input.session || undefined,
		by: input.by ?? "agent",
	};
	return JSON.parse(JSON.stringify(event)) as AmendEvent;
}

export interface RetractInput {
	post: string;
	reason?: string;
	undo?: boolean;
	session?: string;
	by?: Author;
}

export function buildRetract(input: RetractInput, catalog: Catalog, machine: string, at: Date = new Date()): RetractEvent {
	const post = entryFor(catalog, input.post);
	if (input.undo && !post.retracted) throw new Error(`${post.id} is not retracted`);
	if (!input.undo && post.retracted) throw new Error(`${post.id} is already retracted`);
	const event: RetractEvent = {
		type: "retract",
		id: newId("r", at),
		at: at.toISOString(),
		machine,
		post: post.id,
		reason: input.reason?.trim() || undefined,
		undo: input.undo || undefined,
		session: input.session || undefined,
		by: input.by ?? "agent",
	};
	return JSON.parse(JSON.stringify(event)) as RetractEvent;
}

/** An idea as it reads now: every change applied. */
export interface IdeaView {
	id: string;
	at: string;
	/** When it last changed (`at` when never). */
	updated: string;
	title: string;
	body?: string;
	status: IdeaStatus;
	project?: string;
	by: Author;
	changes: number;
}

export interface IdeaFilter {
	/** This project's ideas and the ones for everything. */
	project?: string;
	status?: IdeaStatus;
	q?: string;
	/** Include done and dropped ideas. */
	all?: boolean;
}

export function isIdeaStatus(value: unknown): value is IdeaStatus {
	return typeof value === "string" && (IDEA_STATUSES as readonly string[]).includes(value);
}

/** The idea id in an id or in a viewer URL (`http://…/#n_…`). */
export function ideaIdFrom(value: string): string {
	const match = /(n_[a-z0-9]+)\s*$/.exec(value.trim());
	return match ? match[1]! : value.trim();
}

export interface IdeaInput {
	title: string;
	body?: string;
	status?: IdeaStatus;
	project?: string;
	session?: string;
	by?: Author;
}

export function buildIdea(input: IdeaInput, machine: string, at: Date = new Date()): IdeaEvent {
	const title = String(input.title ?? "").trim();
	if (!title) throw new Error("an idea needs a title");
	if (input.status !== undefined && !isIdeaStatus(input.status)) throw new Error(`status is one of ${IDEA_STATUSES.join(", ")}`);
	const event: IdeaEvent = {
		type: "idea",
		id: newId("n", at),
		at: at.toISOString(),
		machine,
		title,
		body: input.body?.trim() || undefined,
		status: input.status ?? "idea",
		project: input.project?.trim() || undefined,
		session: input.session || undefined,
		by: input.by ?? "agent",
	};
	return JSON.parse(JSON.stringify(event)) as IdeaEvent;
}

export interface IdeaChangeInput {
	idea: string;
	title?: string;
	body?: string;
	status?: IdeaStatus;
	project?: string;
	session?: string;
	by?: Author;
}

export function buildIdeaChange(input: IdeaChangeInput, catalog: Catalog, machine: string, at: Date = new Date()): IdeaChangeEvent {
	const current = catalog.idea(input.idea);
	if (!current) throw new Error(`no idea ${ideaIdFrom(input.idea)}`);
	if (input.status !== undefined && !isIdeaStatus(input.status)) throw new Error(`status is one of ${IDEA_STATUSES.join(", ")}`);
	const title = input.title === undefined ? undefined : input.title.trim();
	if (title === "") throw new Error("an idea needs a title");
	const change = {
		title: title !== undefined && title !== current.title ? title : undefined,
		body: input.body !== undefined && input.body.trim() !== (current.body ?? "") ? input.body.trim() : undefined,
		status: input.status !== undefined && input.status !== current.status ? input.status : undefined,
		project: input.project !== undefined && input.project.trim() !== (current.project ?? "") ? input.project.trim() : undefined,
	};
	if (Object.values(change).every((value) => value === undefined)) throw new Error("nothing to change");
	const event: IdeaChangeEvent = {
		type: "idea-change",
		id: newId("u", at),
		at: at.toISOString(),
		machine,
		idea: current.id,
		...change,
		session: input.session || undefined,
		by: input.by ?? "agent",
	};
	return JSON.parse(JSON.stringify(event)) as IdeaChangeEvent;
}

const byTime = <T extends { at: string; id: string }>(a: T, b: T) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The state the events add up to. Events may arrive in any order (several machines' logs). */
export class Catalog {
	/** Every post as it reads now, in the order they arrived. */
	readonly posts: Post[] = [];
	/** Comments, answers and marks, oldest first. */
	readonly history: FeedbackEvent[] = [];
	private readonly postsById = new Map<string, Post>();
	private readonly originals = new Map<string, PostEvent>();
	private readonly amends = new Map<string, AmendEvent[]>();
	private readonly retracts = new Map<string, RetractEvent[]>();
	private readonly itemsById = new Map<string, Item>();
	private readonly itemPost = new Map<string, string>();
	private readonly verdicts = new Map<string, VerdictEvent>();
	private readonly comments = new Map<string, CommentEvent[]>();
	private readonly answers = new Map<string, Map<string, AnswerEvent>>();
	private readonly issues = new Map<string, IssueEvent>();
	private readonly ideaEvents = new Map<string, IdeaEvent>();
	private readonly ideaChanges = new Map<string, IdeaChangeEvent[]>();
	private readonly ideasById = new Map<string, IdeaView>();
	private readonly seen = new Set<string>();

	apply(event: DailiesEvent): void {
		if (this.seen.has(event.id)) return;
		this.seen.add(event.id);
		switch (event.type) {
			case "post": {
				this.originals.set(event.id, event);
				for (const item of event.items) this.noteItem(item, event.id);
				const post: Post = { ...event };
				this.posts.push(post);
				this.postsById.set(event.id, post);
				if (this.amends.has(event.id) || this.retracts.has(event.id)) this.rebuild(event.id);
				break;
			}
			case "amend": {
				const list = this.amends.get(event.post) ?? [];
				list.push(event);
				list.sort(byTime);
				this.amends.set(event.post, list);
				for (const item of event.items ?? []) this.noteItem(item, event.post);
				this.rebuild(event.post);
				break;
			}
			case "retract": {
				const list = this.retracts.get(event.post) ?? [];
				list.push(event);
				list.sort(byTime);
				this.retracts.set(event.post, list);
				this.rebuild(event.post);
				break;
			}
			case "verdict": {
				const current = this.verdicts.get(event.item);
				if (!current || byTime(current, event) < 0) this.verdicts.set(event.item, event);
				this.addHistory(event);
				break;
			}
			case "comment": {
				const list = this.comments.get(event.post) ?? [];
				list.push(event);
				list.sort(byTime);
				this.comments.set(event.post, list);
				this.addHistory(event);
				break;
			}
			case "answer": {
				const map = this.answers.get(event.post) ?? new Map<string, AnswerEvent>();
				const current = map.get(event.question);
				if (!current || byTime(current, event) < 0) map.set(event.question, event);
				this.answers.set(event.post, map);
				this.addHistory(event);
				break;
			}
			case "issue": {
				const key = event.key.toUpperCase();
				const current = this.issues.get(key);
				if (!current || byTime(current, event) < 0) this.issues.set(key, { ...event, key });
				break;
			}
			case "idea": {
				this.ideaEvents.set(event.id, event);
				this.rebuildIdea(event.id);
				break;
			}
			case "idea-change": {
				const list = this.ideaChanges.get(event.idea) ?? [];
				list.push(event);
				list.sort(byTime);
				this.ideaChanges.set(event.idea, list);
				this.rebuildIdea(event.idea);
				break;
			}
		}
	}

	/** Re-reads an idea from its first record and every change, in time order. */
	private rebuildIdea(id: string): void {
		const first = this.ideaEvents.get(id);
		if (!first) return;
		const changes = this.ideaChanges.get(id) ?? [];
		const view: IdeaView = { id, at: first.at, updated: first.at, title: first.title, body: first.body, status: first.status, project: first.project, by: first.by, changes: changes.length };
		for (const change of changes) {
			if (change.title) view.title = change.title;
			if (change.body !== undefined) view.body = change.body || undefined;
			if (isIdeaStatus(change.status)) view.status = change.status;
			if (change.project !== undefined) view.project = change.project || undefined;
			if (change.at > view.updated) view.updated = change.at;
		}
		this.ideasById.set(id, JSON.parse(JSON.stringify(view)) as IdeaView);
	}

	idea(id: string): IdeaView | undefined {
		return this.ideasById.get(ideaIdFrom(id));
	}

	/** Ideas as they read now, most recently changed first; done and dropped only with `all` or `status`. */
	ideas(filter: IdeaFilter = {}): IdeaView[] {
		const words = (filter.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
		return [...this.ideasById.values()]
			.filter((idea) => {
				if (filter.status ? idea.status !== filter.status : !filter.all && (idea.status === "done" || idea.status === "dropped")) return false;
				// Ideas for everything (no project) belong to every project.
				if (filter.project && idea.project && idea.project !== filter.project) return false;
				if (!words.length) return true;
				const haystack = [idea.title, idea.body, idea.project].filter(Boolean).join("\n").toLowerCase();
				return words.every((word) => haystack.includes(word));
			})
			.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : a.id < b.id ? 1 : -1));
	}

	private addHistory(event: FeedbackEvent): void {
		this.history.push(event);
		if (this.history.length > 1 && byTime(this.history[this.history.length - 2]!, event) > 0) this.history.sort(byTime);
	}

	private noteItem(item: Item, post: string): void {
		if (!this.itemsById.has(item.id)) this.itemsById.set(item.id, item);
		if (!this.itemPost.has(item.id)) this.itemPost.set(item.id, post);
	}

	/** Re-reads an entry from its first record and every correction, in log order. */
	private rebuild(id: string): void {
		const original = this.originals.get(id);
		const current = this.postsById.get(id);
		if (!original || !current) return;
		const next: Post = JSON.parse(JSON.stringify(original)) as Post;
		const originalSides = new Set([...(original.devlog?.before ?? []), ...(original.devlog?.after ?? [])]);
		const loose = original.items.filter((item) => !originalSides.has(item.id));
		const notes: AmendNote[] = [];
		for (const amend of this.amends.get(id) ?? []) {
			const fields: string[] = [];
			if (amend.title !== undefined) {
				next.title = amend.title || undefined;
				fields.push("title");
			}
			if (amend.issue !== undefined) {
				next.issue = amend.issue || undefined;
				fields.push("issue");
			}
			if (amend.devlog && next.devlog) {
				for (const field of DEVLOG_TEXT) {
					if (amend.devlog[field] === undefined) continue;
					next.devlog[field] = amend.devlog[field] || undefined;
					fields.push(field);
				}
				for (const side of ["before", "after"] as const) {
					if (amend.devlog[side] === undefined) continue;
					next.devlog[side] = amend.devlog[side]!;
					fields.push(side);
				}
			}
			notes.push({ id: amend.id, at: amend.at, reason: amend.reason, fields });
		}
		if (notes.length) {
			next.amended = notes;
			const sides = [...(next.devlog?.before ?? []), ...(next.devlog?.after ?? [])];
			const items: Item[] = [];
			for (const itemId of sides) {
				const item = this.itemsById.get(itemId);
				if (item && !items.some((known) => known.id === itemId)) items.push(item);
			}
			for (const item of loose) if (!items.some((known) => known.id === item.id)) items.push(item);
			next.items = items;
			for (const item of items) if (!this.itemPost.has(item.id)) this.itemPost.set(item.id, id);
		}
		const retracts = this.retracts.get(id) ?? [];
		const last = retracts[retracts.length - 1];
		if (last && !last.undo) next.retracted = { at: last.at, reason: last.reason };
		Object.keys(current).forEach((key) => delete (current as unknown as Record<string, unknown>)[key]);
		Object.assign(current, next);
	}

	post(id: string): Post | undefined {
		return this.postsById.get(postIdFrom(id));
	}

	item(id: string): Item | undefined {
		return this.itemsById.get(id);
	}

	/** The post a file was first shown in. */
	postOfItem(id: string): Post | undefined {
		const postId = this.itemPost.get(id);
		return postId ? this.postsById.get(postId) : undefined;
	}

	original(id: string): PostEvent | undefined {
		return this.originals.get(id);
	}

	verdictOf(itemId: string): Verdict | null {
		return this.verdicts.get(itemId)?.verdict ?? null;
	}

	commentsOn(postId: string): CommentEvent[] {
		return this.comments.get(postId) ?? [];
	}

	answersTo(postId: string): Record<string, AnswerEvent> {
		return Object.fromEntries(this.answers.get(postId) ?? []);
	}

	openQuestions(post: PostEvent): Question[] {
		const answered = this.answers.get(post.id);
		return (post.questions ?? []).filter((question) => !answered?.has(question.id));
	}

	issue(key: string | undefined): IssueInfo | undefined {
		if (!key) return undefined;
		const event = this.issues.get(key.toUpperCase());
		if (!event) return undefined;
		return { key: event.key, title: event.title, description: event.description, status: event.status, url: event.url, details: event.details, at: event.at };
	}

	issueEvent(key: string): IssueEvent | undefined {
		return this.issues.get(key.toUpperCase());
	}

	view(post: Post): PostView {
		const view: PostView = {
			...post,
			items: post.items.map((item) => ({ ...item, verdict: this.verdictOf(item.id) })),
			comments: this.commentsOn(post.id),
			answers: this.answersTo(post.id),
		};
		if (post.amended?.length) view.original = this.originals.get(post.id);
		return view;
	}

	/** Shas of commits already in a (not retracted) devlog entry. */
	recordedCommits(): Set<string> {
		const shas = new Set<string>();
		for (const post of this.posts) {
			if (post.kind !== "devlog" || post.retracted) continue;
			for (const commit of post.devlog?.commits ?? []) shas.add(commit.sha);
		}
		return shas;
	}

	private matches(post: Post, words: string[]): boolean {
		const issue = post.issue ? this.issues.get(post.issue.toUpperCase()) : undefined;
		const haystack = [
			post.title,
			post.note,
			post.lane,
			post.branch,
			post.issue,
			issue?.title,
			...post.tags,
			...post.items.map((item) => item.name),
			...(post.questions ?? []).flatMap((question) => [question.text, ...question.options.map((option) => option.label)]),
			post.devlog?.summary,
			post.devlog?.craft,
			post.devlog?.struggle,
			post.devlog?.decided,
			...(post.devlog?.commits ?? []).map((commit) => commit.subject),
		]
			.filter(Boolean)
			.join("\n")
			.toLowerCase();
		return words.every((word) => haystack.includes(word));
	}

	/** Posts as they read now, newest first. */
	list(filter: ListFilter = {}): PostView[] {
		const words = (filter.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
		const issue = filter.issue?.toUpperCase();
		const sorted = [...this.posts].sort((a, b) => byTime(b, a));
		let start = 0;
		if (filter.before) {
			const index = sorted.findIndex((post) => post.id === filter.before);
			start = index >= 0 ? index + 1 : sorted.length;
		}
		const out: PostView[] = [];
		const limit = filter.limit ?? Infinity;
		for (let index = start; index < sorted.length && out.length < limit; index++) {
			const post = sorted[index]!;
			if (post.retracted && !filter.retracted) continue;
			if (filter.kind === "devlog" && post.kind !== "devlog") continue;
			if (filter.kind === "review" && post.kind === "devlog") continue;
			if (filter.project && post.project !== filter.project) continue;
			if (filter.lane && post.lane !== filter.lane) continue;
			if (issue && post.issue?.toUpperCase() !== issue) continue;
			if (filter.session && post.session !== filter.session) continue;
			if (filter.since && post.at < filter.since) continue;
			if (filter.until && post.at >= filter.until) continue;
			if (filter.open && !this.openQuestions(post).length) continue;
			if (words.length && !this.matches(post, words)) continue;
			out.push(this.view(post));
		}
		return out;
	}

	/** Repositories → issues (or lanes) → sessions, newest activity first at each level. */
	tree(kind?: "devlog" | "review"): ProjectNode[] {
		const projects = new Map<string, ProjectNode>();
		const groups = new Map<string, GroupNode>();
		const sessions = new Map<string, SessionNode>();
		for (const post of [...this.posts].sort(byTime)) {
			if (post.retracted) continue;
			if (kind === "devlog" && post.kind !== "devlog") continue;
			if (kind === "review" && post.kind === "devlog") continue;
			const open = this.openQuestions(post).length;
			let project = projects.get(post.project);
			if (!project) {
				project = { project: post.project, last: post.at, groups: [] };
				projects.set(post.project, project);
			}
			project.last = post.at;
			const issueKey = post.issue?.toUpperCase();
			const groupId = issueKey ? `${post.project}\u0000issue:${issueKey}` : `${post.project}\u0000lane:${post.lane}`;
			let group = groups.get(groupId);
			if (!group) {
				group = { id: groupId, project: post.project, issue: issueKey, lane: post.lane, title: post.lane, count: 0, last: post.at, open: 0, sessions: [] };
				groups.set(groupId, group);
				project.groups.push(group);
			}
			group.count += 1;
			group.last = post.at;
			group.open += open;
			if (post.branch) group.branch = post.branch;
			if (post.session) {
				const sessionId = `${groupId}\u0000${post.session}`;
				let session = sessions.get(sessionId);
				if (!session) {
					session = { session: post.session, first: post.at, last: post.at, count: 0, title: post.title ?? post.items[0]?.name ?? post.session, open: 0 };
					sessions.set(sessionId, session);
					group.sessions.push(session);
				}
				session.count += 1;
				session.last = post.at;
				session.open += open;
			}
		}
		for (const group of groups.values()) {
			if (group.issue) {
				const issue = this.issues.get(group.issue);
				group.title = issue?.title ?? titleFromBranch(group.branch, group.issue) ?? group.lane;
				group.status = issue?.status;
			}
			group.sessions.sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
		}
		const out = [...projects.values()];
		for (const project of out) project.groups.sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
		return out.sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
	}

	counts(): { dailies: number; devlog: number; open: number; ideas: number } {
		let ideas = 0;
		for (const idea of this.ideasById.values()) if (idea.status !== "done" && idea.status !== "dropped") ideas += 1;
		let dailies = 0;
		let devlog = 0;
		let open = 0;
		for (const post of this.posts) {
			if (post.retracted) continue;
			if (post.kind === "devlog") devlog += 1;
			else dailies += 1;
			open += this.openQuestions(post).length;
		}
		return { dailies, devlog, open, ideas };
	}
}

export interface SessionState {
	/** Feedback events already handed to this session. */
	delivered: string[];
	/** Questions the Stop hook already reminded the session to wait on. */
	reminded: string[];
	/** When and where the session began. */
	began?: { at: string; cwd?: string; heads?: Record<string, string> };
	/** Git work the session ran (merges, commits on main), noted by the PreToolUse hook. */
	landing?: { cwd: string; kind: "merge" | "commit"; ref?: string; base?: string; at: string }[];
	/** Merges and main-branch commits already suggested for a devlog entry. */
	suggested?: string[];
	/** When the session last heard the user's feedback. */
	heard?: string;
	transcript?: string;
	[key: string]: unknown;
}

/** Files by content hash, and the append-only event log of this machine. */
export class Store {
	readonly home: string;
	readonly machine: string;
	readonly blobDir: string;
	readonly logDir: string;
	readonly logPath: string;

	constructor(home: string, machine: string) {
		this.home = resolve(home);
		this.machine = machine;
		this.blobDir = join(this.home, "blobs");
		this.logDir = join(this.home, "log");
		this.logPath = join(this.logDir, `${machine}.jsonl`);
	}

	blobPath(sha256: string, ext: string): string {
		return join(this.blobDir, sha256.slice(0, 2), `${sha256}${ext}`);
	}

	async addFile(path: string, name: string = basename(path)): Promise<Item> {
		const source = resolve(path);
		const hash = createHash("sha256");
		let size = 0;
		await new Promise<void>((done, fail) => {
			createReadStream(source)
				.on("data", (chunk) => {
					hash.update(chunk);
					size += chunk.length;
				})
				.on("error", fail)
				.on("end", () => done());
		});
		const sha256 = hash.digest("hex");
		const { ext, mime, kind } = describe(name);
		const target = this.blobPath(sha256, ext);
		if (!existsSync(target)) {
			mkdirSync(join(this.blobDir, sha256.slice(0, 2)), { recursive: true });
			const temporary = `${target}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
			copyFileSync(source, temporary);
			renameSync(temporary, target);
		}
		return { id: newId("i"), sha256, ext, name, mime, kind, size, source };
	}

	append(event: DailiesEvent): void {
		mkdirSync(this.logDir, { recursive: true });
		appendFileSync(this.logPath, `${JSON.stringify(event)}\n`);
	}

	/** Every event of every machine; torn or foreign lines are skipped. */
	readEvents(): DailiesEvent[] {
		if (!existsSync(this.logDir)) return [];
		const events: DailiesEvent[] = [];
		const files = readdirSync(this.logDir)
			.filter((file) => file.endsWith(".jsonl"))
			.sort();
		for (const file of files) {
			const text = readFileSync(join(this.logDir, file), "utf8");
			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line) as DailiesEvent;
					if (event && typeof event === "object" && typeof event.type === "string" && typeof event.id === "string") events.push(event);
				} catch {
					// A line torn by a crash; the rest of the log still counts.
				}
			}
		}
		return events;
	}

	load(): Catalog {
		const catalog = new Catalog();
		for (const event of this.readEvents()) catalog.apply(event);
		return catalog;
	}

	/** A hard link to the stored file under its original name, for upload dialogs and drags. */
	namedPath(item: Item): string {
		const dir = join(this.home, "named", item.id);
		const target = join(dir, safeName(item.name));
		if (existsSync(target)) return target;
		mkdirSync(dir, { recursive: true });
		const blob = this.blobPath(item.sha256, item.ext);
		try {
			linkSync(blob, target);
		} catch {
			copyFileSync(blob, target);
		}
		return target;
	}

	readSelection(): Selection | undefined {
		return readJson<Selection>(join(this.home, "selection.json"));
	}

	writeSelection(selection: Selection): void {
		writeJsonAtomic(join(this.home, "selection.json"), selection);
	}

	sessionPath(session: string): string {
		return join(this.home, "sessions", `${session.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
	}

	readSession(session: string): SessionState {
		const state = readJson<SessionState>(this.sessionPath(session));
		return { ...state, delivered: state?.delivered ?? [], reminded: state?.reminded ?? [] };
	}

	writeSession(session: string, state: SessionState): void {
		writeJsonAtomic(this.sessionPath(session), state);
	}

	updateSession(session: string, change: (state: SessionState) => void): SessionState {
		const state = this.readSession(session);
		change(state);
		this.writeSession(session, state);
		return state;
	}

	/** Every session's state (to find feedback no session took). */
	sessions(): Map<string, SessionState> {
		const dir = join(this.home, "sessions");
		const out = new Map<string, SessionState>();
		if (!existsSync(dir)) return out;
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".json")) continue;
			const state = readJson<SessionState>(join(dir, file));
			if (state) out.set(file.slice(0, -5), { ...state, delivered: state.delivered ?? [], reminded: state.reminded ?? [] });
		}
		return out;
	}
}

/** A file name safe to put in a path and a header. */
export function safeName(name: string): string {
	const cleaned = name.replace(/[/\\\u0000-\u001f]/g, "_").replace(/^\.+/, "_");
	return cleaned || "file";
}

export function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, "\t")}\n`);
	try {
		renameSync(temporary, path);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {
			// already gone
		}
		throw error;
	}
}
