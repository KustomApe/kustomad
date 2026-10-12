# KustomAD — viewer API

The viewer (`src/server.ts`) serves the page from `web/` and a JSON API. Everything below is
what the page (`web/app.js`) and the CLI (`src/client.ts`) rely on.

## Data

```ts
type Kind = "image" | "video" | "audio" | "model" | "pdf" | "html" | "markdown" | "text" | "other";
type Author = "human" | "agent";

interface Item {            // one stored file
  id: string;               // i_<base36 time><random>
  sha256: string;
  ext: string;              // ".png" (lowercase, with the dot; "" when none)
  name: string;             // original file name
  mime: string;
  kind: Kind;
  size: number;
  source?: string;          // absolute path it was taken from
}

interface QuestionOption { id: string; key: string /* "A" */; label?: string; body?: string /* Markdown */; items: string[] /* item ids */ }
interface Question { id: string; text: string; why?: string /* Markdown */; items: string[] /* shown above the options (--about) */; options: QuestionOption[]; multi?: boolean }
interface CommitRef { sha: string; subject: string; at?: string; repo?: string }
interface DevlogInfo { summary?: string; craft?: string; struggle?: string; decided?: string; before: string[]; after: string[]; commits: CommitRef[] }

interface PostView {
  type: "post"; id: string /* p_… */; at: string /* ISO */; machine: string;
  project: string; lane: string; branch?: string; issue?: string; session?: string; cwd?: string;
  title?: string; note?: string; tags: string[];
  kind?: "devlog"; devlog?: DevlogInfo;
  questions?: Question[];
  items: (Item & { verdict: "adopted" | "rejected" | null })[];
  comments: CommentEvent[];                    // oldest first; `item` set when it is a note on one file
  answers: Record<string, AnswerEvent>;        // latest answer per question id
  amended?: { id: string; at: string; reason?: string; fields: string[] }[];
  original?: PostView-like;                    // the entry as first recorded (only when amended)
  retracted?: { at: string; reason?: string };
}
interface CommentEvent { type: "comment"; id: string; at: string; machine: string; post: string; item?: string; text: string; by: Author }
interface AnswerEvent  { type: "answer";  id: string; at: string; machine: string; post: string; question: string; choices: string[] /* option ids */; text?: string; by: Author }
interface IssueInfo    { key: string; title?: string; description?: string /* Markdown */; status?: string; url?: string; details?: string[]; at: string }

type IdeaStatus = "idea" | "candidate" | "doing" | "done" | "dropped";
interface IdeaView {        // an idea on the board, every change applied
  id: string /* n_… */; at: string; updated: string /* last change, or at */;
  title: string; body?: string /* Markdown */; status: IdeaStatus;
  project?: string /* none: for everything */; by: Author; changes: number;
}

interface SessionNode { session: string; first: string; last: string; count: number; title: string; open: number }
interface GroupNode   { id: string; project: string; issue?: string; lane: string; branch?: string; title: string; status?: string; count: number; last: string; open: number; sessions: SessionNode[] }
interface ProjectNode { project: string; last: string; groups: GroupNode[] }   // newest activity first at every level
```

## GET

| Path | Returns |
| --- | --- |
| `/api/health` | `{ ok, version, pid, viewers, home }` |
| `/api/state?mode=dailies\|devlog&limit=40&before=<post id>&project&lane&issue&session&q&open=1` | `{ posts: PostView[] (newest first), tree: ProjectNode[], counts: { dailies, devlog, open, ideas }, issue: IssueInfo\|null, selection, machine }` |
| `/api/ideas?project&status&q&all=1` | `{ ideas: IdeaView[] (last changed first), projects: { project, open }[], counts }` — done and dropped only with `all=1` or `status`; `project` also lists ideas for everything |
| `/api/tree?mode=` | `{ tree, counts }` |
| `/api/issue?key=` | `{ issue }` |
| `/api/context` | `{ selected: boolean, selection, post: PostView\|null, item?: Item }` |
| `/api/events` | Server-sent events, see below. Each open stream counts as one viewer tab. |
| `/api/watch?session=…` or `?post=…` | SSE used by `watch`/`wait`; sends `feedback` events |
| `/api/watchers?session=&post=` | `{ session, watching }` |
| `/blob/<sha256><ext>` | the stored file (immutable cache, Range supported) |
| `/files/<item id>/<name>[?download]` | the file under its own name; `inline` or `attachment` disposition |
| `/play/<item id>` | a playable video: 302 to `/files/…`, or a WebM converted once with ffmpeg |
| `/vendor/model-viewer.js` | the vendored `<model-viewer>` |
| `/`, `/app.js`, `/style.css`, `/i18n.js`, `/icon.svg` | the page |

`mode=dailies` lists review posts (shown/asked); `mode=devlog` lists devlog entries. `q` searches
titles, notes, file names, issue keys and titles, branches, and devlog text, case-insensitively.

## POST (JSON only; `Origin`, if sent, must be the viewer's own)

| Path | Body | Returns |
| --- | --- | --- |
| `/api/posts` | post input (project, lane, items, questions, kind, devlog…) | 201 `{ post, viewers, url }` |
| `/api/comments` | `{ post, item?, text, by }` — the page's **OK** is a comment with text `"OK"` | 201 the comment |
| `/api/answers` | `{ post, question, choices: string[], text?, by }` | 201 the answer |
| `/api/verdicts` | `{ item, verdict: "adopted"\|"rejected"\|null, by }` (legacy per-file marks) | 201 |
| `/api/issues` | `{ key, title?, description?, status?, url?, details?, merge?, by }` | 201 the issue event |
| `/api/amend` | `{ post, title?, issue?, devlog?: { summary?, craft?, struggle?, decided?, before?, after? }, items?, reason?, by }` | 201 `{ post, amend, url }` |
| `/api/retract` | `{ post, reason?, undo?, by }` | 201 `{ post, retract }` |
| `/api/ideas` | `{ title, body?, status?, project?, session?, by }` | 201 `{ idea, url }` |
| `/api/ideas/change` | `{ idea, title?, body?, status?, project?, session?, by }` — an empty `body`/`project` clears it; 400 when nothing changes | 201 `{ idea, url }` |
| `/api/path` | `{ item }` | `{ item, path }` — absolute path under `named/` for upload dialogs |
| `/api/select` | `{ post, item? }` | the selection |
| `/api/shutdown` | `{ version, force? }` | 200, or 409 unless the caller is newer (or `force`) |

## Server-sent events on `/api/events`

| Event | Data |
| --- | --- |
| `hello` | `{ version, viewers }` |
| `post` | `PostView` |
| `comment` | `CommentEvent` |
| `answer` | `AnswerEvent` |
| `verdict` | `VerdictEvent` |
| `issue` | `IssueInfo` |
| `amend` | `{ amend, post: PostView }` |
| `retract` | `{ retract, post: PostView }` |
| `idea` | `IdeaView` (added or changed) |
| `select` | selection |
| `ping` | `{}` every 25 s |
