import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempDir(prefix = "agents-dailies-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

export function writeFile(dir: string, name: string, content: string | Buffer): string {
	const path = join(dir, name);
	writeFileSync(path, content);
	return path;
}

// A 1×1 PNG, so tests store a real image without fixtures.
export const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);
