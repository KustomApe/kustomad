import { exec } from "node:child_process";
import { join } from "node:path";
import { readConfig } from "./config.ts";
import { readJson, writeJsonAtomic, type Store } from "./store.ts";

export const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9]{0,14}-\d{1,7}$/;
const REFRESH_MS = 30 * 60 * 1000;

export interface IssueFields {
	title?: string;
	description?: string;
	status?: string;
	url?: string;
	details?: string[];
}

type Env = Record<string, string | undefined>;

/** The command that prints an issue as JSON, from the environment or the user's own config. */
export function issueCommandFor(project: string | undefined, env: Env = process.env): string | undefined {
	if (env.AGENTS_DAILIES_ISSUE_COMMAND) return env.AGENTS_DAILIES_ISSUE_COMMAND;
	const config = readConfig(env);
	return (project && config.projects?.[project]?.issueCommand) || config.issueCommand || undefined;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);
const named = (value: unknown): string | undefined => text(value) ?? (value && typeof value === "object" ? text((value as { name?: unknown }).name) : undefined);

/** Reads Linear (linear-tui), GitHub (gh) and Jira-like JSON the same way. */
export function normalizeIssue(raw: unknown): IssueFields {
	const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const data = (source.issue && typeof source.issue === "object" ? source.issue : source) as Record<string, unknown>;
	const fields = (data.fields && typeof data.fields === "object" ? data.fields : {}) as Record<string, unknown>;
	const title = text(data.title) ?? text(fields.summary) ?? text(data.summary);
	const description = text(data.description) ?? text(data.body) ?? text(fields.description);
	const status = named(data.state) ?? named(data.status) ?? named(fields.status);
	const url = text(data.url) ?? text(data.html_url) ?? text(data.self_url);
	const details: string[] = [];
	for (const value of [data.project, data.milestone, data.cycle, fields.project]) {
		const name = named(value);
		if (name) details.push(name);
	}
	const labels = data.labels ?? fields.labels;
	const list = Array.isArray(labels) ? labels : labels && typeof labels === "object" && Array.isArray((labels as { nodes?: unknown }).nodes) ? (labels as { nodes: unknown[] }).nodes : [];
	for (const label of list) {
		const name = named(label);
		if (name) details.push(name);
	}
	return { title, description, status, url, details: details.length ? details : undefined };
}

/** Runs the command with `{key}` replaced and reads the JSON it prints. */
export function fetchIssue(command: string, key: string, cwd?: string): Promise<IssueFields> {
	if (!ISSUE_KEY.test(key)) return Promise.reject(new Error(`${JSON.stringify(key)} is not an issue key`));
	const line = command.includes("{key}") ? command.replaceAll("{key}", key) : `${command} ${key}`;
	return new Promise((done, fail) => {
		exec(line, { cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) return fail(new Error(`${line} failed: ${(stderr || error.message).trim().split("\n")[0]}`));
			try {
				done(normalizeIssue(JSON.parse(stdout)));
			} catch {
				fail(new Error(`${line} did not print JSON`));
			}
		});
	});
}

function fetchedPath(store: Store): string {
	return join(store.home, "issues-fetched.json");
}

/** Whether the issue was last fetched long enough ago (30 minutes) to fetch it again. */
export function dueForRefresh(store: Store, key: string, now: number = Date.now()): boolean {
	const fetched = readJson<Record<string, string>>(fetchedPath(store)) ?? {};
	const last = fetched[key.toUpperCase()];
	return !last || now - Date.parse(last) >= REFRESH_MS;
}

export function markFetched(store: Store, key: string, at: Date = new Date()): void {
	const path = fetchedPath(store);
	const fetched = readJson<Record<string, string>>(path) ?? {};
	fetched[key.toUpperCase()] = at.toISOString();
	writeJsonAtomic(path, fetched);
}
