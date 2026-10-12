# KustomAD

**A live review page for what your coding agent makes.** [日本語](README.ja.md)

When an agent renders an image, records a clip, generates a sound or exports a 3D
model, it tends to pop open a window or leave you a path deep inside a worktree.
KustomAD gives it one place to put things instead: a browser tab you keep open,
where every result appears at the top as it is made, side by side with the
alternatives, and stays.

You reply right there — **OK**, or a note on the post or on one file — and answer the
agent's questions ("which of these three?", "ship this cut?", a whole review sheet) by
picking and pressing **Send**. Replies and answers go back to the agent, even while
it is idle.

Named after *dailies*: the daily session where a film or game team reviews yesterday's
renders and decides what to keep.

- **One live tab** — posts arrive over server-sent events; nothing steals focus. The
  browser is opened only when no viewer tab is.
- **Every medium** — images and GIFs, video (looping, muted, plays in view; old formats
  such as Ogg Theora are converted once with [ffmpeg](https://ffmpeg.org/) when it is
  installed), audio, GLB/glTF (orbit with [model-viewer](https://modelviewer.dev/)),
  PDF, HTML (sandboxed), Markdown and text.
- **History by repository → issue → session** — the sidebar groups posts, newest
  activity first, with counts, unread dots and waiting questions; search titles, files,
  issues and devlog text. Issue keys come from branch names (`me/summ-239-x` → `SUMM-239`).
- **Questions about what you see** — files, multi-file patterns and sentences become
  options A, B, C…; `--about` shows the thing to sign off on above the options; review
  sheets carry many questions. Answers wake the agent.
- **Notes per file** — on a post with several files, each file takes its own notes.
- **Feedback reaches the agent** — `watch`/`wait` exit (waking it) when you reply;
  hooks hand comments over before the agent stops and with your next message.
- **Devlog** — on its own tab. When work has been merged (never before), the agent
  records what changed, what worked (工夫), what was hard (苦労) and what was decided,
  with before/after images or videos. `devlog summary` gathers a period's entries,
  decisions, commits and Claude Code transcripts (kept before Claude Code deletes them).
- **Idea board** — on its own tab (Ideas): ideas and things to build in columns
  **Ideas → To build → Doing → Done** (and Dropped). Write them in the page, drag cards
  or change their status; agents add and move them with `kustomad idea`. Per repository,
  or for everything.
- **The issue on screen** — above an issue's posts: title, status, description,
  fetched by a command you configure (Linear, GitHub, Jira…) or written by the agent.
- **Take files with you** — copy an image to the clipboard, copy any file's path for an
  upload dialog, download one file or the whole post under the original names, or drag.
- **Kept** — files are stored once by content hash outside your repository; the event
  log is append-only, one file per machine.
- **Keyboard first** — `j`/`k` posts, `h`/`l` files, `o` OK, `c` note on the file (`C` on
  the post), `f` full screen, `1`–`9` choose, `Enter` send, `y` copy (`Y` path),
  `d` download, `[`/`]` sidebar, `/` search.

## Install

Needs [Node.js](https://nodejs.org/) 22.6+ on `PATH`. No npm install, no build.

### From a clone (any shell or agent)

```sh
git clone https://github.com/KustomApe/kustomad.git ~/.local/share/kustomad-src
mkdir -p ~/.local/bin
ln -s ~/.local/share/kustomad-src/bin/kustomad ~/.local/bin/   # ~/.local/bin must be on PATH
kustomad --version
kustomad guide   # instructions to paste into your agent's CLAUDE.md / AGENTS.md
```

`bin/kustomad` runs the TypeScript sources with Node directly, so a plain clone
works. To update, `git pull` in the clone (a running viewer is replaced by a newer
version automatically).

`kustomad hook <pre-tool-use|session-start|user-prompt-submit|stop|session-end>`
reads a Claude Code style hook event on stdin, for agents with hooks.

### As a Claude Code plugin (optional)

The repository is also a Claude Code plugin. Installing it is optional; everything
above works without it. In Claude Code:

```text
/plugin marketplace add KustomApe/kustomad     # or a local path to the clone
/plugin install kustomad@kustomad
```

Start a new session afterwards. The plugin then:

- puts `bin/` on the agent's `PATH` at session start (via `$CLAUDE_ENV_FILE`), so the
  agent can type `kustomad show …` with no symlink;
- adds a skill telling the agent when to `show`, `ask`, read `context` and write the devlog;
- adds hooks: SessionStart (guide + unread replies, keeps transcripts), PreToolUse on
  Bash (stops `xdg-open`/`open`/image viewers/video players on media files in favour of
  `kustomad show`; notes merges and commits for the devlog), Stop (hands over
  replies, reminds once to `wait` on an unanswered question, suggests a devlog entry
  once after a merge lands), UserPromptSubmit (replies since you last heard) and
  SessionEnd (keeps the transcript).

It installs nothing with npm and runs no server until the first `show`. Remove it with
`/plugin uninstall kustomad@kustomad`.

## Getting started

### Start the viewer

You do not need to start anything: the first `show` or `ask` starts the viewer in the
background and opens the browser if no viewer tab is open.

```sh
kustomad show screenshot.png --title "First look"   # starts the viewer, opens http://127.0.0.1:4778/
```

To control it yourself:

| Command | What it does |
| --- | --- |
| `kustomad open` | Start the viewer if needed and open it in the browser |
| `kustomad status` | Whether it runs, its address, version, open tabs and the store location |
| `kustomad serve [--port P] [--host H]` | Run it in the foreground (logs to the terminal; Ctrl-C stops it) |
| `kustomad stop` | Stop the background viewer |

The background viewer logs to `~/.local/share/kustomad/server.log`. Another port:
`KUSTOMAD_PORT=4800 kustomad open`. To see the viewer from another machine
(e.g. over Tailscale): `KUSTOMAD_HOST=0.0.0.0 kustomad serve` — only on a
network you trust.

### Tell your agent about it

Without the plugin, give the agent the instructions once:

```sh
kustomad guide >> CLAUDE.md     # or AGENTS.md, or your agent's instructions file
```

From then on, ask it things like "show me the renders", "which of these looks better?"
or "record the devlog for this merge", and keep the viewer tab open. Reply on the page:
**OK**, a note on the post or on one file, or pick an option and press **Send**.

### Try it with a scratch store

```sh
export KUSTOMAD_HOME=$(mktemp -d) KUSTOMAD_PORT=47901
kustomad show a.png b.png --title "A / B"
kustomad ask "Which one?" a.png b.png --option "Neither"
kustomad wait <post-id>        # answer in the page; this prints your answer
kustomad stop
```

## Use

```sh
kustomad show render_a.png render_b.png --title "Lighting: A / B" --note "B lowers the fill light"
```

```text
Shown 2 files in the viewer: http://127.0.0.1:4778/#p_muvw9p9sf3cb5c
  1. render_a.png  (i_muvw9p2t304cf7)
  2. render_b.png  (i_muvw9p2v54a24c)
The viewer is open in 1 tab; it updated in place. No need to open anything.
```

When it needs a decision:

```sh
kustomad ask "Which front view do we keep?" a.png b.png --option "Neither — redraw it" --why "B matches the back view."
kustomad ask "Which palette?" --pattern "Current" c1.png c2.png --pattern "Warmer" w1.png w2.png
kustomad ask "Ship this cut?" --about cut.mp4 --option "OK" --option "Fix something"
kustomad ask --file review.json     # several questions (format: skills/kustomad/SKILL.md)
kustomad wait <post-id>             # in the background: exits with the answers
```

| Command | What it gives the agent |
| --- | --- |
| `context` | What you selected (or the newest post): files with readable paths, answers, replies |
| `wait <post-id>` | Blocks until every question of the post is answered (or you comment), prints the answers |
| `watch` | Blocks until you comment on this session's posts, prints it — run in the background |
| `feedback [--since 2h] [--all]` | Your replies and answers for this worktree |
| `list [--all]` | Recent posts |
| `get <item-id> [--to PATH]` | A stored file |

For you: `open`, `status`, `stop`, `serve`.

### When to use it

| Situation | Use |
| --- | --- |
| Work in progress to look at | `show` |
| A choice between things to look at | `ask` |
| A page others read, or that outlives the work | your agent's documents / Artifacts |
| A question answered from words alone | the terminal |

### How replies get back to the agent

Every post remembers the session that made it (`CLAUDE_CODE_SESSION_ID`). A reply is
pending for that session until it has been handed over once:

1. **While idle** — `kustomad watch` (or `wait`) runs in the background; Claude
   Code wakes the agent when it exits with your reply.
2. **Before it stops** — the Stop hook hands over unread replies and, once per
   unanswered question, reminds the agent to start `wait`.
3. **With your next message** — the UserPromptSubmit hook adds what came in since.
4. **In a new session** — the SessionStart hook passes on replies in this worktree that
   no session read.

### Devlog

```sh
kustomad devlog add --title "What changed" --before old.png --after new.png --summary - <<'EOF'
What changed for the people using it, and why.
## 工夫
What worked.
## 苦労
What was hard: what failed first, what was tried.
## 決めたこと
What was decided.
EOF
kustomad devlog edit <p_…> --before right.png --reason "wrong commit"   # corrections are new events
kustomad devlog retract <p_…> [--undo]
kustomad devlog summary --since "2026-10-01 18:00"
```

The PreToolUse hook notes merges a session runs (and commits made straight on the main
branch); once they have landed, their commits and the merged branch's issue are
attached, and `devlog add` refuses work still on a branch. The Stop hook suggests an
entry once after a merge lands. Transcripts are kept at session start and end
(`devlog sweep` by hand).

### Idea board

Write ideas and things to implement on the Ideas tab, or let the agent note them:

```sh
kustomad idea add "Frame stepping with , and ." --body "For checking timing" --status candidate
kustomad idea add "Notify Slack when a question waits" --global   # not tied to this repository
kustomad idea list [--status doing] [--all] [--everywhere]          # this repository's open ideas
kustomad idea set <n_…> --status doing                              # idea, candidate, doing, done, dropped
kustomad idea show <n_…>
```

Ideas belong to the repository the command runs in, unless `--global`; a repository's
list includes the global ones. Changes are new events, like everything else in the log.

### Issue summaries

kustomad talks to no tracker itself. Name a command that prints an issue as JSON
in `$XDG_CONFIG_HOME/kustomad/config.json` (`{key}` is replaced):

```json
{
  "issueCommand": "gh issue view {key} --json title,body,state,url,labels",
  "projects": { "game-lab": { "issueCommand": "linear-tui issue show {key} --json" } }
}
```

It runs in the background at most every 30 minutes per issue. Linear, GitHub and
Jira-like JSON are understood. Only your own config is read — a repository cannot make
KustomAD run commands. Without one: `kustomad issue KEY --title … --description -`.

## Where things are kept

```text
$XDG_DATA_HOME/kustomad/           (~/.local/share/kustomad)
  blobs/<ab>/<sha256><ext>               each file once per content
  log/<machine>.jsonl                    append-only events: post, comment, answer, verdict, issue, amend, retract
  named/<item>/<original name>           hard links under the original names (copy path / drag)
  derived/<sha256>.webm                  videos converted for the browser
  transcripts/<project>/<session>.jsonl  Claude Code transcripts, kept
  sessions/<session>.json                what each session was handed, merges it ran
  selection.json                         what is selected in the viewer
  server.log
```

KustomAD used to be called agents-dailies: while `kustomad/` does not exist yet, an existing
`agents-dailies/` data or config folder is used as is.

| Variable | Default |
| --- | --- |
| `KUSTOMAD_HOME` | `$XDG_DATA_HOME/kustomad` |
| `KUSTOMAD_PORT` | `4778` |
| `KUSTOMAD_HOST` | `127.0.0.1` (`0.0.0.0` to reach it from other machines on a trusted network) |
| `KUSTOMAD_NO_OPEN=1` | never open a browser from `show` |
| `KUSTOMAD_BROWSER` | command to open URLs with |
| `KUSTOMAD_AUTO_WATCH=0` | no Stop-hook reminder to `wait` on an unanswered question |
| `KUSTOMAD_DEVLOG=0` | no Stop-hook devlog suggestion |
| `KUSTOMAD_ISSUE_COMMAND` | the issue command, overriding the config file |
| `KUSTOMAD_CONFIG` | another config file |
| `KUSTOMAD_MACHINE` | this machine's log name (default: host name) |

## Security

The viewer listens on `127.0.0.1` with no login. It refuses requests whose `Host` is not
its own address (DNS rebinding), accepts only JSON for writes (no cross-site forms) and
rejects cross-origin writes. Agent-made HTML and SVG are served with a sandboxing CSP.
Listening on `0.0.0.0` turns the `Host` check off — only on a network you trust.

## Develop

```sh
npm run setup     # TypeScript and types into dev/; the tool itself has no dependencies
npm test          # node --test; Node runs the TypeScript directly
npm run verify    # typecheck + test + build
bin/kustomad show some.png
```

See [AGENTS.md](AGENTS.md) for the layout and invariants, and [docs/API.md](docs/API.md)
for the viewer's HTTP API. model-viewer (with three.js and Lit) is vendored in
`web/vendor/` with its licenses so the page works offline.

## License

MIT
