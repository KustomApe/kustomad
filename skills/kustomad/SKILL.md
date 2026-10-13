---
name: kustomad
description: Show the user your work in progress (images, videos, GIFs, audio, 3D models, PDFs, HTML, Markdown, text) in the KustomAD viewer — one live browser tab — and ask them to choose there between things to look at (pick a render, sign off on how something looks), instead of opening windows, printing paths or publishing an Artifact. Questions answered from words alone stay in the terminal. Use whenever you want the user to look at something you made ("show me", "let me see", "open it", "見せて", "開いて", "比べたい"), need them to choose between things you made ("which one looks better", "どっちがいい", "見比べて選んで", "見た目をレビューして"), look back on merged work or summarize a period ("devlog", "制作記録", "ふりかえり", "前回からの変更", "アップデートのまとめ"), or they refer to something on that page ("this one", "the left one", "これ", "左の", "今見てるやつ", "採用したやつ").
---

# KustomAD

The user keeps one browser tab open: the viewer. Whatever you show or ask appears at
its top, live, grouped by repository → issue (or branch) → session. They reply to what
you show (OK, or a note — on the whole post or on one file) and answer your questions
(pick, press Send, a note is optional). All of it comes back to you.

## Which tool when

| Situation | Use |
| --- | --- |
| Work in progress to look at | `kustomad show` |
| A choice between things to look at: which render, how it looks, what to keep | `kustomad ask` |
| A page other people read, or that outlives this work (report, shared doc) | an Artifact |
| Any question answered from words alone — approach, yes/no, a name, what next | the terminal |
| An idea or something to build later — the user's, or one you noticed out of scope | `kustomad idea add` |

A post with nothing to look at is noise on the page; keep word-only questions in the terminal.

## Show

```sh
kustomad show <file>… --title "<what to look at>" [--note "<what changed>"] [--tag before|after]
```

- Put alternatives in one call so they sit side by side.
- The browser opens only when no viewer tab is open. Do not also run `xdg-open`/`open`
  or an image viewer (a hook stops that), and do not leave the user only a file path.

## Ask

Files and sentences become options A, B, C… in the order given:

```sh
kustomad ask "Which front view do we keep?" a.png b.png --option "Neither — redraw it" \
  --why "B matches the back view best; A loses the cape."
```

`--multi` lets them pick several. To sign off on one thing, show it above the options
with `--about` (a single file next to sentences is refused — it would become option A):

```sh
kustomad ask "Ship this cut?" --about cut.mp4 --option "OK as it is" --option "Fix something (note it)"
```

An option shown by several files is a pattern:

```sh
kustomad ask "Which palette do we keep?" \
  --pattern "Current" current_front.png current_back.png \
  --pattern "Warmer" warm_front.png warm_back.png \
  --option "Neither — try again"
```

Several decisions at once (a review sheet), files relative to the sheet:

```json
{
  "title": "SUMM-123 contract screen: decisions",
  "note": "Pick per item; choose Let's discuss where you are unsure.",
  "questions": [
    {
      "text": "Grey out species you lack materials for",
      "why": "**Why**: shows what to collect next.",
      "files": ["mock_greyed.png"],
      "options": [
        "OK as proposed",
        { "label": "Only list the ones you can contract", "body": "A shorter list.", "files": ["mock_short.png"] },
        "Let's discuss"
      ]
    }
  ]
}
```

```sh
kustomad ask --file sheet.json
```

Write sheets in the user's language and do not prefix labels with "A:" — letters are added.

Then wait in the background (Bash `run_in_background`, timeout 7200000):

```sh
kustomad wait <post-id>
```

It exits with every answer (or as soon as the user comments on the post), which wakes
you. Act on the answers; for the next round, ask again in a new post.

## Hear back

- `kustomad context` — what they selected (or the newest post): files with readable
  paths, answers, replies. Run it first when they say "this one" / "これ".
- `kustomad watch` in the background — exits when they comment on anything you
  showed this session. Restart it only while you still expect a reply.
- `kustomad feedback [--since 2h] [--all]`, `kustomad list [--all]`,
  `kustomad get <item-id> [--to PATH]`.
- `--json` on `show`, `ask`, `context`, `feedback`, `list` gives exact fields.

## Ideas

The viewer's Ideas tab is a board of ideas and things to implement, in columns
idea → candidate (to build) → doing → done (or dropped). The user writes and moves
them there; you do the same from the CLI:

```sh
kustomad idea add "<title>" [--body - <<'EOF' … EOF] [--status candidate] [--global]
kustomad idea list [--status S] [--all] [--everywhere]
kustomad idea set <n_…> --status doing      # when you start on one; done when it lands
kustomad idea show <n_…>
```

Note an idea when the user mentions something for later, or when you notice something
worth doing that is outside the current task — instead of doing it unasked. Ideas
belong to this repository unless `--global`. When the user asks what to work on next,
read `kustomad idea list`. Move an idea to `doing` when you start it and to `done` once
it has landed.

## Insights

`kustomad stats [--days 30] [--project P|--here] [--json]` gives what the viewer's Insights
tab charts: reviews, the user's replies, time to first reply, marks, devlog entries and
ideas over a period, compared with the period before. Read it when the user asks how
work has been going or wants a period summarised in numbers.

## Devlog

A record of how the product changed, written from merged work, so updates and devlog
posts can be written later from it.

**Only merged work.** After work has landed on the main branch (the user approved the
merge and it went through — not at each branch commit), look back over the session. If
it changed something a person using the product would notice, record it:

```sh
kustomad devlog add --title "Thief's cape reads at game size" \
  --before i_mupkr1c5fdf43e --after shots/cape_after.png shots/cape_run.mp4 --summary - <<'EOF'
The cape was a flat plate from the back; it is now thick and follows the run.
## 工夫
Pushed the cloth out along its normals instead of remodelling it, so the animation
and texture stayed as they were.
## 苦労
The first try thickened the hood too and it clipped the horns; the user spotted it in
the viewer, so the hood is now left out by vertex group.
## 決めたこと
Keep the darker hem (option B in the viewer).
EOF
```

- **Summary**: what changed for the people using it, and why.
- **## 工夫 / Craft**: the idea that made it work. **## 苦労 / Struggle**: what failed
  first, what was tried, what the user had redone. **## 決めたこと / Decided**: decisions.
  (`--craft`, `--struggle`, `--decided` work too.)
- **Before/after are required when the change can be seen or heard**: images for how it
  looks, short videos for motion, timing, feel or sound. Reuse `i_…` ids of files you
  showed, or capture the before from the commit before the merge in a temporary worktree.
- The session's merged commits and the merged branch's issue are attached; `devlog add`
  refuses work not yet on the main branch (`--commits A..B` must be on it; `none` for
  work without commits). The Stop hook reminds you once after a merge lands.

Correct an entry instead of adding another (only what you give is replaced; the first
record is kept):

```sh
kustomad devlog edit p_mupkr0a1b2c3 --before shots/cape_before.png --reason "the before was from the wrong commit"
kustomad devlog edit p_mupkr0a1b2c3 --summary - <<'EOF'    # only the sections present are replaced
## 苦労
The hood clipped the horns until it was left out by vertex group.
EOF
kustomad devlog retract p_mupkr0a1b2c3 --reason "recorded twice"   # --undo brings it back
```

To write an update since the previous one, take the period from that update itself:

```sh
kustomad devlog summary --since "2026-10-01 18:00"   # entries, decisions, commits, transcripts
```

`kustomad devlog list [--all]` shows entries. The viewer keeps the devlog on its
own tab (Devlog), apart from review posts (Dailies).
