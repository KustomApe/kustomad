import type { AnswerEvent, Catalog, CommentEvent, FeedbackEvent, Post, Store } from "./store.ts";

/** Posts an agent session made, optionally only those of the last `withinMs`. */
export function postedBy(catalog: Catalog, session: string, withinMs?: number): Post[] {
	const since = withinMs === undefined ? "" : new Date(Date.now() - withinMs).toISOString();
	return catalog.posts.filter((post) => post.session === session && post.at >= since);
}

/** The user's feedback on a session's posts that the session has not been handed yet. */
export function pendingFor(catalog: Catalog, store: Store, session: string): FeedbackEvent[] {
	const delivered = new Set(store.readSession(session).delivered);
	return catalog.history.filter((event) => {
		if (event.by !== "human" || delivered.has(event.id)) return false;
		return catalog.post(event.post)?.session === session;
	});
}

export function markDelivered(store: Store, session: string, events: FeedbackEvent[]): void {
	if (!events.length) return;
	store.updateSession(session, (state) => {
		const known = new Set(state.delivered);
		for (const event of events) if (!known.has(event.id)) state.delivered.push(event.id);
		state.heard = new Date().toISOString();
	});
}

/** Comments and answers are messages; marks alone are not worth waking anyone for. */
export function hasMessage(events: FeedbackEvent[]): boolean {
	return events.some((event) => event.type === "comment" || event.type === "answer");
}

/** Feedback left in this worktree on other sessions' posts that no session took. */
export function orphanedIn(catalog: Catalog, store: Store, project: string, lane: string, session?: string): FeedbackEvent[] {
	const delivered = new Set<string>();
	for (const state of store.sessions().values()) for (const id of state.delivered) delivered.add(id);
	return catalog.history.filter((event) => {
		if (event.by !== "human" || delivered.has(event.id)) return false;
		const post = catalog.post(event.post);
		if (!post || post.project !== project || post.lane !== lane) return false;
		return post.session !== session;
	});
}

function postName(post: Post | undefined): string {
	if (!post) return "a post";
	return post.title ? `"${post.title}"` : (post.items[0]?.name ?? post.id);
}

/** `A (front.png)`, `B (Redraw)`. */
export function describeChoices(post: Post | undefined, answer: AnswerEvent, catalog: Catalog): string {
	const question = post?.questions?.find((candidate) => candidate.id === answer.question);
	if (!question) return answer.choices.join(", ");
	return answer.choices
		.map((choice) => {
			const option = question.options.find((candidate) => candidate.id === choice);
			if (!option) return choice;
			const files = option.items.map((id) => catalog.item(id)?.name).filter(Boolean);
			const what = option.label ?? files.join(", ");
			return what ? `${option.key} (${what})` : option.key;
		})
		.join(", ");
}

export function describeEvent(catalog: Catalog, event: FeedbackEvent): string {
	const post = catalog.post(event.post);
	switch (event.type) {
		case "answer": {
			const question = post?.questions?.find((candidate) => candidate.id === event.question);
			const note = event.text ? ` — "${event.text}"` : "";
			return `"${question?.text ?? event.question}" → ${describeChoices(post, event, catalog)}${note}  [${event.post}]`;
		}
		case "comment": {
			const file = event.item ? catalog.item(event.item)?.name : undefined;
			const where = file ? `${postName(post)} / ${file}` : postName(post);
			return `${where}: "${event.text}"  [${event.post}]`;
		}
		case "verdict": {
			const file = catalog.item(event.item)?.name ?? event.item;
			return `${postName(post)} / ${file}: ${event.verdict ?? "mark cleared"}  [${event.post}]`;
		}
	}
}

/** One line per event, for the agent to read. */
export function describeFeedback(catalog: Catalog, events: FeedbackEvent[]): string[] {
	return events.map((event) => describeEvent(catalog, event));
}

export function isComment(event: FeedbackEvent): event is CommentEvent {
	return event.type === "comment";
}
