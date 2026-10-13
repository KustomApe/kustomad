import { IDEA_STATUSES, type Catalog, type IdeaStatus, type Kind, type Post } from "./store.ts";

/** What the dashboard reads: activity over a period, what kinds of things were shown, how fast
 * the user answered, and where ideas stand. Days and hours are in the viewer's time zone. */
export interface StatsView {
	range: { from: string; to: string; days: number; tz: number };
	project?: string;
	totals: StatsTotals;
	/** The same counts for the period just before, for the change. */
	previous: StatsTotals;
	daily: DayStats[];
	kinds: { kind: Kind; count: number }[];
	verdicts: { adopted: number; rejected: number; unmarked: number };
	/** Time from a post to the user's first reply, mark or answer. */
	response: { median: number | null; samples: number; buckets: { key: ResponseBucket; count: number }[] };
	/** Posts and replies by weekday (0 = Sunday) and hour. */
	hours: number[][];
	projects: ProjectStats[];
	/** Ideas as they stand now (done and dropped included), whatever the period. */
	ideas: Record<IdeaStatus, number>;
}

export interface StatsTotals {
	reviews: number;
	files: number;
	devlog: number;
	questions: number;
	answered: number;
	/** The user's comments, answers and marks. */
	replies: number;
	ideasAdded: number;
	ideasDone: number;
}

export interface DayStats {
	/** YYYY-MM-DD in the viewer's time zone. */
	day: string;
	reviews: number;
	devlog: number;
	replies: number;
	ideasAdded: number;
	ideasDone: number;
}

export interface ProjectStats {
	project: string;
	reviews: number;
	devlog: number;
	replies: number;
	last: string;
}

export type ResponseBucket = "5m" | "30m" | "2h" | "1d" | "more";
const BUCKETS: [ResponseBucket, number][] = [
	["5m", 5 * 60_000],
	["30m", 30 * 60_000],
	["2h", 2 * 3_600_000],
	["1d", 24 * 3_600_000],
	["more", Infinity],
];

export interface StatsOptions {
	project?: string;
	/** How many days back from `now`, today included. */
	days?: number;
	/** Minutes the viewer's clock is ahead of UTC (Japan: 540). */
	tz?: number;
	now?: Date;
}

const DAY = 86_400_000;

function emptyTotals(): StatsTotals {
	return { reviews: 0, files: 0, devlog: 0, questions: 0, answered: 0, replies: 0, ideasAdded: 0, ideasDone: 0 };
}

export function stats(catalog: Catalog, options: StatsOptions = {}): StatsView {
	const days = Math.max(1, Math.min(Math.floor(options.days ?? 30), 366));
	const tz = Math.max(-840, Math.min(Math.round(options.tz ?? 0), 840)) * 60_000;
	const now = (options.now ?? new Date()).getTime();
	// Local midnight that starts the first day, as a UTC instant.
	const today = Math.floor((now + tz) / DAY) * DAY - tz;
	const from = today - (days - 1) * DAY;
	const to = today + DAY;
	const before = from - days * DAY;
	const dayOf = (at: string) => Math.floor((Date.parse(at) - from) / DAY);
	const label = (start: number) => new Date(start + tz).toISOString().slice(0, 10);

	const project = options.project;
	const posts = catalog.posts.filter((post) => !post.retracted && (!project || post.project === project));
	const postsById = new Map<string, Post>(posts.map((post) => [post.id, post]));
	const inRange = (at: string) => {
		const time = Date.parse(at);
		return time >= from && time < to;
	};
	const inBefore = (at: string) => {
		const time = Date.parse(at);
		return time >= before && time < from;
	};

	const totals = emptyTotals();
	const previous = emptyTotals();
	const daily: DayStats[] = Array.from({ length: days }, (_, index) => ({ day: label(from + index * DAY), reviews: 0, devlog: 0, replies: 0, ideasAdded: 0, ideasDone: 0 }));
	const kinds = new Map<Kind, number>();
	const verdicts = { adopted: 0, rejected: 0, unmarked: 0 };
	const hours = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
	const projects = new Map<string, ProjectStats>();
	const byProject = (name: string, at: string) => {
		let entry = projects.get(name);
		if (!entry) projects.set(name, (entry = { project: name, reviews: 0, devlog: 0, replies: 0, last: at }));
		if (at > entry.last) entry.last = at;
		return entry;
	};
	const hour = (at: string) => {
		const local = new Date(Date.parse(at) + tz);
		hours[local.getUTCDay()]![local.getUTCHours()]! += 1;
	};

	for (const post of posts) {
		const bucket = inRange(post.at) ? totals : inBefore(post.at) ? previous : undefined;
		if (!bucket) continue;
		const devlog = post.kind === "devlog";
		const questions = post.questions?.length ?? 0;
		const answered = questions - catalog.openQuestions(post).length;
		if (devlog) bucket.devlog += 1;
		else bucket.reviews += 1;
		bucket.files += post.items.length;
		bucket.questions += questions;
		bucket.answered += answered;
		if (bucket !== totals) continue;
		const day = daily[dayOf(post.at)];
		if (day) day[devlog ? "devlog" : "reviews"] += 1;
		byProject(post.project, post.at)[devlog ? "devlog" : "reviews"] += 1;
		hour(post.at);
		if (devlog) continue;
		for (const item of post.items) {
			kinds.set(item.kind, (kinds.get(item.kind) ?? 0) + 1);
			const verdict = catalog.verdictOf(item.id);
			if (verdict) verdicts[verdict] += 1;
			else verdicts.unmarked += 1;
		}
	}

	// The user's replies, and how long each post waited for the first one.
	const firstReply = new Map<string, number>();
	for (const event of catalog.history) {
		if (event.by !== "human") continue;
		const post = postsById.get(event.post);
		if (!post) continue;
		const time = Date.parse(event.at);
		if (!firstReply.has(post.id)) firstReply.set(post.id, time - Date.parse(post.at));
		if (inBefore(event.at)) previous.replies += 1;
		if (!inRange(event.at)) continue;
		totals.replies += 1;
		const day = daily[dayOf(event.at)];
		if (day) day.replies += 1;
		byProject(post.project, event.at).replies += 1;
		hour(event.at);
	}
	const waits = posts
		.filter((post) => post.kind !== "devlog" && inRange(post.at) && firstReply.has(post.id))
		.map((post) => Math.max(0, firstReply.get(post.id)!))
		.sort((a, b) => a - b);
	const buckets = BUCKETS.map(([key]) => ({ key, count: 0 }));
	for (const wait of waits) buckets[BUCKETS.findIndex(([, limit]) => wait < limit)]!.count += 1;
	const middle = waits.length >> 1;
	const median = !waits.length ? null : waits.length % 2 ? waits[middle]! : Math.round((waits[middle - 1]! + waits[middle]!) / 2);

	// Ideas: added in the period, finished in it (when they last became done), and where all stand now.
	const ideas = Object.fromEntries(IDEA_STATUSES.map((status) => [status, 0])) as Record<IdeaStatus, number>;
	for (const idea of catalog.ideas({ all: true, project })) {
		if (project && !idea.project) continue;
		ideas[idea.status] += 1;
		if (inRange(idea.at)) {
			totals.ideasAdded += 1;
			const day = daily[dayOf(idea.at)];
			if (day) day.ideasAdded += 1;
		} else if (inBefore(idea.at)) previous.ideasAdded += 1;
		if (idea.status !== "done") continue;
		const done = catalog.ideaDoneAt(idea.id);
		if (!done) continue;
		if (inRange(done)) {
			totals.ideasDone += 1;
			const day = daily[dayOf(done)];
			if (day) day.ideasDone += 1;
		} else if (inBefore(done)) previous.ideasDone += 1;
	}

	return {
		range: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), days, tz: tz / 60_000 },
		project,
		totals,
		previous,
		daily,
		kinds: [...kinds].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : 1)),
		verdicts,
		response: { median, samples: waits.length, buckets },
		hours,
		projects: [...projects.values()].sort((a, b) => b.reviews + b.devlog + b.replies - (a.reviews + a.devlog + a.replies) || (a.last < b.last ? 1 : -1)),
		ideas,
	};
}
