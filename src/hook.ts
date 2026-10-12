import { basename } from "node:path";
import { flagOff } from "./config.ts";
import { keepTranscript, sweepTranscripts } from "./devlog.ts";
import { describeFeedback, hasMessage, markDelivered, orphanedIn, pendingFor } from "./feedback.ts";
import { landings, noteSteps } from "./landed.ts";
import { describe } from "./media.ts";
import { shellQuote, simpleCommands } from "./shell.ts";
import type { Store } from "./store.ts";
import { detectWhere, gitInfo } from "./where.ts";

export { simpleCommands } from "./shell.ts";

export interface HookInput {
	session_id?: string;
	cwd?: string;
	transcript_path?: string;
	tool_name?: string;
	tool_input?: { command?: string; [key: string]: unknown };
	stop_hook_active?: boolean;
	prompt?: string;
	source?: string;
	[key: string]: unknown;
}

export interface HookResult {
	/** Exit 2: stderr goes to the agent (blocks the tool, or keeps the agent from stopping). */
	block: boolean;
	message?: string;
	/** Printed on stdout with exit 0 (context for SessionStart / UserPromptSubmit). */
	context?: string;
}

const PASS: HookResult = { block: false };

/** Programs that open files in a window of their own. */
const OPENERS = new Set([
	"xdg-open", "open", "eog", "eom", "feh", "sxiv", "nsxiv", "imv", "loupe", "gwenview", "ristretto", "display", "gthumb", "shotwell", "qimgv", "nomacs",
	"mpv", "vlc", "cvlc", "totem", "celluloid", "ffplay", "mplayer", "smplayer", "haruna", "parole", "qlmanage",
	"f3d", "evince", "okular", "zathura",
	"firefox", "chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome", "brave", "brave-browser", "microsoft-edge", "safari",
]);
/** Words that run the next word as the command. */
const WRAPPERS = new Set(["nohup", "setsid", "env", "exec", "command", "sudo", "nice", "timeout", "time"]);
const MEDIA = new Set(["image", "video", "audio", "model", "pdf"]);

/** The media files a shell command would open in a window, if any. */
export function openedMedia(command: string): string[] {
	const found: string[] = [];
	for (const words of simpleCommands(command)) {
		let index = 0;
		while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index++;
		while (index < words.length && WRAPPERS.has(basename(words[index]!))) {
			index++;
			while (index < words.length && (words[index]!.startsWith("-") || /^\d+[smh]?$/.test(words[index]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!))) index++;
		}
		const program = words[index];
		if (!program) continue;
		const name = basename(program);
		if (!OPENERS.has(name)) continue;
		let args = words.slice(index + 1);
		if (name === "open" && args[0] === "-a") args = args.slice(2);
		for (const arg of args) {
			if (arg.startsWith("-") || arg.includes("://")) continue;
			if (MEDIA.has(describe(arg).kind)) found.push(arg);
		}
	}
	// `gio open <file>`: the opener is a subcommand.
	for (const words of simpleCommands(command)) {
		const at = words.findIndex((word) => basename(word) === "gio");
		if (at < 0 || words[at + 1] !== "open") continue;
		for (const arg of words.slice(at + 2)) if (!arg.startsWith("-") && !arg.includes("://") && MEDIA.has(describe(arg).kind)) found.push(arg);
	}
	return found;
}

/** PreToolUse on Bash: stop opening media in windows, in favour of the viewer. */
export function preToolUse(input: HookInput | undefined): HookResult {
	if (!input || input.tool_name !== "Bash") return PASS;
	const command = String(input.tool_input?.command ?? "");
	if (!command || /\bKUSTOMAD_ALLOW_OPEN=1\b/.test(command)) return PASS;
	const files = openedMedia(command);
	if (!files.length) return PASS;
	const show = `kustomad show ${files.map(shellQuote).join(" ")} --title "<what to look at>"`;
	return {
		block: true,
		message: [
			"Do not open media in a window: the user reviews it in the KustomAD viewer (one browser tab they keep open). Run instead:",
			`  ${show}`,
			"It shows the files at the top of the viewer, live; the browser opens only if no viewer tab is open.",
			"(If the user explicitly asked for a window, prefix the command with KUSTOMAD_ALLOW_OPEN=1.)",
		].join("\n"),
	};
}

export function guide(): string {
	return `KustomAD is installed: the user reviews what you make in one browser tab (the
viewer), replies there (OK, or a note) and answers your questions there. Use it for
work in progress instead of opening files in windows, leaving the user file paths,
or publishing an Artifact.

Show — whenever you want the user to look at an image, video, GIF, audio clip, 3D
model (GLB/glTF), PDF, HTML, Markdown or text file:
- \`kustomad show <file>… --title "<what to look at>" [--note "<what changed>"]\`
  Put alternatives in one call so they sit side by side. The browser opens only when
  no viewer tab is open; do not open anything else.

Ask — only when the user must look at something to answer (pick between renders,
clips, models or pages you made; sign off on how something looks):
- \`kustomad ask "<question>" a.png b.png --option "Neither — redo it" --why "<your pick and why>"\`
  Files and --option texts become options A, B, C… (--multi: pick several).
- Sign off on one thing: \`kustomad ask "Ship this cut?" --about cut.mp4 --option "OK" --option "Fix something"\`
  (a single file next to sentences is refused as option A — use --about).
- A pattern made of several files: \`--pattern "Current" a1.png a2.png --pattern "Warmer" b1.png b2.png\`.
- Several decisions at once: \`kustomad ask --file sheet.json\` with
  {"title": "…", "questions": [{"text": "…", "why": "…", "files": [...], "options": ["OK", {"label": "…", "body": "…", "files": [...]}, "Let's discuss"]}]}.
- Then start \`kustomad wait <post-id>\` in the background (Bash run_in_background,
  timeout 7200000). It exits with the answers (or a comment), which wakes you.
- Questions answered from words alone (which approach, yes/no, a name) stay in the terminal.

Hear back:
- \`kustomad context\` — what the user selected ("this one", "これ") or the newest post.
- \`kustomad watch\` in the background — exits when the user comments on this session's posts.
- \`kustomad feedback [--since 2h]\`, \`kustomad list\`, \`kustomad get <item-id>\`.

Devlog — only merged work: after work lands on the main branch, if it changed something
a person using the product would notice, record it:
\`kustomad devlog add --title "<what changed>" --before <file|i_…> --after <file|i_…> --summary -\`
with stdin: what changed and why, then "## 工夫" (what worked), "## 苦労" (what was hard),
"## 決めたこと" (decisions). Before/after are required when the change can be seen or
heard (short videos for motion, timing or sound). Fix a wrong entry with
\`kustomad devlog edit <p_…> … --reason "…"\` or \`kustomad devlog retract <p_…>\`.
For an update since the last one: \`kustomad devlog summary --since "<when it ended>"\`.
`;
}

function sessionOf(input: HookInput | undefined, env: Record<string, string | undefined>): string | undefined {
	return input?.session_id || env.CLAUDE_CODE_SESSION_ID || env.KUSTOMAD_SESSION || undefined;
}

export interface HookContext {
	store: Store;
	env: Record<string, string | undefined>;
	/** How many wait on a post now (asks the viewer); 0 when it does not run. */
	waiters?: (post: string) => Promise<number>;
}

export function sessionStart(input: HookInput | undefined, context: HookContext): HookResult {
	const { store, env } = context;
	const cwd = input?.cwd || process.cwd();
	const session = sessionOf(input, env);
	const where = detectWhere(cwd, { ...env, CLAUDE_CODE_SESSION_ID: session });
	const parts = [guide()];
	try {
		const catalog = store.load();
		const left = orphanedIn(catalog, store, where.project, where.lane, session).filter((event) => event.type !== "verdict");
		const mine = session ? pendingFor(catalog, store, session) : [];
		const events = [...left, ...mine];
		if (events.length) {
			parts.push(`Feedback the user left in the viewer for this worktree that no session has read yet:\n${describeFeedback(catalog, events).map((line) => `- ${line}`).join("\n")}`);
			if (session) markDelivered(store, session, events);
		}
	} catch {
		// The store may not exist yet.
	}
	if (session) {
		store.updateSession(session, (state) => {
			state.began ??= { at: new Date().toISOString(), cwd };
		});
		try {
			if (input?.transcript_path) keepTranscript(store, where.project, input.transcript_path, session);
			const info = gitInfo(cwd);
			if (info) sweepTranscripts(store, where.project, info.root, env);
		} catch {
			// best effort
		}
	}
	return { block: false, context: parts.join("\n") };
}

export function userPromptSubmit(input: HookInput | undefined, context: HookContext): HookResult {
	const session = sessionOf(input, context.env);
	if (!session) return PASS;
	const catalog = context.store.load();
	const pending = pendingFor(catalog, context.store, session);
	if (!pending.length) return PASS;
	markDelivered(context.store, session, pending);
	return { block: false, context: `From the kustomad viewer since you last heard:\n${describeFeedback(catalog, pending).map((line) => `- ${line}`).join("\n")}` };
}

export function preToolUseHook(input: HookInput | undefined, context: HookContext): HookResult {
	const session = sessionOf(input, context.env);
	if (session && input?.tool_name === "Bash") {
		const command = String(input.tool_input?.command ?? "");
		if (/\bgit\b/.test(command) && /\b(merge|commit|pull)\b/.test(command)) {
			try {
				const state = context.store.readSession(session);
				if (noteSteps(state, command, input.cwd || process.cwd())) context.store.writeSession(session, state);
			} catch {
				// never get in the way of the command
			}
		}
	}
	return preToolUse(input);
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export async function stop(input: HookInput | undefined, context: HookContext): Promise<HookResult> {
	const { store, env } = context;
	const session = sessionOf(input, env);
	if (!session) return PASS;
	const catalog = store.load();
	const parts: string[] = [];

	const pending = pendingFor(catalog, store, session);
	if (pending.length) {
		markDelivered(store, session, pending);
		if (hasMessage(pending)) parts.push(`The user replied in the KustomAD viewer:\n${describeFeedback(catalog, pending).map((line) => `- ${line}`).join("\n")}\nAct on it before you stop.`);
	}

	const state = store.readSession(session);
	let changed = false;
	if (!flagOff(env.KUSTOMAD_AUTO_WATCH)) {
		const reminded = new Set(state.reminded);
		const waiting: string[] = [];
		for (const post of catalog.posts) {
			if (post.session !== session || post.retracted) continue;
			const open = catalog.openQuestions(post).filter((question) => !reminded.has(`${post.id}/${question.id}`));
			if (!open.length) continue;
			const waiters = context.waiters ? await context.waiters(post.id).catch(() => 0) : 0;
			for (const question of open) state.reminded.push(`${post.id}/${question.id}`);
			changed = true;
			if (waiters) continue;
			waiting.push(`- "${open[0]!.text}"${open.length > 1 ? ` (+${open.length - 1} more)` : ""}: kustomad wait ${post.id}`);
		}
		if (waiting.length) {
			parts.push(
				`You asked in the viewer and the answer has not come yet. Start the wait in the background (Bash run_in_background, timeout 7200000) so the answer wakes you:\n${waiting.join("\n")}`,
			);
		}
	}

	if (!flagOff(env.KUSTOMAD_DEVLOG)) {
		const suggested = new Set(state.suggested ?? []);
		const found = landings(state, catalog.recordedCommits()).filter((landing) => landing.keys.some((key) => !suggested.has(key)));
		if (found.length) {
			state.suggested = [...suggested, ...found.flatMap((landing) => landing.keys)];
			changed = true;
			const lines = found.map((landing) => {
				const latest = landing.commits[0]?.subject;
				const from = landing.from && landing.from !== "FETCH_HEAD" ? ` from ${landing.from}` : "";
				return `- ${landing.project}: ${plural(landing.commits.length, "commit")} on ${landing.main}${from}${latest ? ` (latest: ${latest})` : ""}`;
			});
			parts.push(
				[
					"Work from this session has landed on the main branch:",
					...lines,
					"If it changed something a person using the product would notice, record a devlog entry now (skip refactors nobody notices):",
					'  kustomad devlog add --title "<what changed>" --before <file|i_…> --after <file|i_…> --summary - <<\'EOF\'',
					"  What changed for the people using it, and why.",
					"  ## 工夫",
					"  What worked — the idea that made it work.",
					"  ## 苦労",
					"  What was hard: what failed first, what was tried, what the user had redone.",
					"  ## 決めたこと",
					"  What was decided.",
					"  EOF",
					"Before/after are required when the change can be seen or heard: images for how it looks, short videos when the change is in motion, timing, feel or sound. Reuse i_… ids you showed, or capture the before from the commit before the merge in a temporary worktree.",
				].join("\n"),
			);
		}
	}
	if (changed) store.writeSession(session, state);
	if (!parts.length) return PASS;
	return { block: true, message: parts.join("\n\n") };
}

export function sessionEnd(input: HookInput | undefined, context: HookContext): HookResult {
	const session = sessionOf(input, context.env);
	const cwd = input?.cwd || process.cwd();
	const where = detectWhere(cwd, {});
	try {
		if (input?.transcript_path) keepTranscript(context.store, where.project, input.transcript_path, session);
	} catch {
		// best effort
	}
	return PASS;
}
