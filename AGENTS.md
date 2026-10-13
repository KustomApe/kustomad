# KustomAD — notes for coding agents

## Commands

```sh
npm run setup      # dev tooling into dev/ (the tool itself needs nothing)
npm test           # node --test over test/**/*.test.ts (Node runs the TypeScript directly)
npm run typecheck
npm run verify     # typecheck + test + build; run before every commit
bin/kustomad …   # the CLI from source (what the plugin runs)
claude plugin validate .
```

Point manual runs at a scratch store so they never touch the real one:
`KUSTOMAD_HOME=$(mktemp -d) KUSTOMAD_PORT=47901 KUSTOMAD_NO_OPEN=1 bin/kustomad show x.png`.

## Layout

- `src/cli.ts` — commands. `src/server.ts` — the viewer (HTTP, server-sent events, JSON API;
  contract in `docs/API.md`). `src/client.ts` — talking to it, starting it in the background, and
  the in-process fallback when it cannot run. `src/store.ts` — files by hash, the event log
  (posts, feedback, devlog corrections, ideas) and the `Catalog` the events add up to.
  `src/stats.ts` — what the Insights tab charts. `src/feedback.ts` — handing replies to agent sessions.
  `src/hook.ts` — agent hooks and the guide text. `src/shell.ts` — splitting command lines.
  `src/landed.ts` — merges/commits a session ran and whether they landed. `src/devlog.ts` —
  sections, period summaries, transcripts. `src/issues.ts` — issue commands. `src/where.ts` —
  repository/worktree/issue/session. `src/media.ts` — kinds and mime types.
- `web/` — the page: plain HTML, CSS and JavaScript, no build. Strings in `web/i18n.js` (English
  and Japanese). `web/vendor/` — model-viewer, vendored with its licenses.
- The repository root is the Claude Code plugin: `.claude-plugin/`, `hooks/` (`hooks.json`,
  `run.sh`), `skills/kustomad/SKILL.md`. `bin/kustomad` runs `src/cli.ts` with Node.

## Invariants

- The store is append-only. Each machine writes only `log/<machine>.jsonl`; nothing rewrites or
  deletes events (corrections are `amend`/`retract` events). Blobs are named by content hash. This
  is what lets stores sync by union.
- The `Catalog` must give the same state whatever order events arrive in (several machines' logs,
  clocks that disagree): latest by `at` wins; corrections apply in `at` order onto the first record.
- While the viewer runs it is the only writer of this machine's log; the CLI copies files into the
  store and posts events to it. The CLI writes the log itself only when the viewer cannot start.
- TypeScript stays erasable (`erasableSyntaxOnly`): no enums, namespaces or parameter properties.
  Relative imports use `.ts`.
- No runtime dependencies. The plugin is a git checkout with no `npm install`.
- Hooks are quick and quiet: exit 0 with no output unless they have something to say; exit 2
  (stderr to the agent) only on purpose. `hooks/run.sh` skips Node for unrelated Bash commands.
- The viewer binds to 127.0.0.1 by default and checks `Host`, `Origin` and the JSON content type
  on writes. Keep those checks for new endpoints.
- Every user-visible string in the page has English and Japanese.

## Commits

Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`); each passes `npm run verify`.
