import assert from "node:assert/strict";
import { test } from "node:test";
import { openedMedia, preToolUse, simpleCommands } from "../src/hook.ts";

test("commands are split on shell separators, respecting quotes", () => {
	assert.deepEqual(simpleCommands(`cd "a b" && xdg-open 'c d.png'; echo "x;y" | cat`), [
		["cd", "a b"],
		["xdg-open", "c d.png"],
		["echo", "x;y"],
		["cat"],
	]);
	assert.deepEqual(simpleCommands("echo $(xdg-open a.png)"), [["echo"], ["xdg-open", "a.png"]]);
});

test("opening media in a window is caught", () => {
	assert.deepEqual(openedMedia("xdg-open preview/shot.png"), ["preview/shot.png"]);
	assert.deepEqual(openedMedia("cd /tmp && xdg-open a.mp4 b.gif &"), ["a.mp4", "b.gif"]);
	assert.deepEqual(openedMedia("nohup mpv --loop clip.webm >/dev/null 2>&1 &"), ["clip.webm"]);
	assert.deepEqual(openedMedia("DISPLAY=:0 eog '/tmp/my shot.jpg'"), ["/tmp/my shot.jpg"]);
	assert.deepEqual(openedMedia("gio open model.glb"), ["model.glb"]);
	assert.deepEqual(openedMedia("/usr/bin/xdg-open render.webp"), ["render.webp"]);
});

test("everything else passes", () => {
	assert.deepEqual(openedMedia("xdg-open ~/Videos"), []);
	assert.deepEqual(openedMedia("xdg-open https://example.com"), []);
	assert.deepEqual(openedMedia("xdg-open notes.md"), []);
	assert.deepEqual(openedMedia("cp a.png b.png"), []);
	assert.deepEqual(openedMedia("ffmpeg -i in.mp4 out.gif"), []);
	assert.deepEqual(openedMedia("echo xdg-open a.png"), []);
	assert.deepEqual(openedMedia("kustomad show a.png"), []);
});

test("the hook blocks with the show command to use instead", () => {
	const decision = preToolUse({ tool_name: "Bash", tool_input: { command: "xdg-open 'out/a b.png' out/c.mp4" } });
	assert.equal(decision.block, true);
	assert.match(decision.message ?? "", /kustomad show 'out\/a b\.png' out\/c\.mp4 --title/);
});

test("the hook lets other tools, other commands and explicit requests through", () => {
	assert.equal(preToolUse({ tool_name: "Read", tool_input: { file_path: "a.png" } }).block, false);
	assert.equal(preToolUse({ tool_name: "Bash", tool_input: { command: "ls" } }).block, false);
	assert.equal(preToolUse({ tool_name: "Bash", tool_input: { command: "KUSTOMAD_ALLOW_OPEN=1 xdg-open a.png" } }).block, false);
	assert.equal(preToolUse(undefined).block, false);
});
