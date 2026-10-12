// KustomAD — the viewer page. Plain JavaScript, no build step.
// Talks to the viewer's JSON API (docs/API.md) and follows it live over server-sent events.
(function () {
	"use strict";

	const t = window.I18N.t;
	const LANG = window.I18N.lang;
	const PAGE = 30;

	// ── State ────────────────────────────────────────────────────────────────

	const state = {
		mode: "dailies",
		scope: {}, // { project, issue, lane, session }
		q: "",
		onlyOpen: false,
		posts: new Map(), // id → PostView
		order: [], // ids shown in the feed, newest first
		hasMore: false,
		tree: [],
		counts: { dailies: 0, devlog: 0, open: 0, ideas: 0 },
		ideas: new Map(), // id → IdeaView (the idea board)
		ideaProjects: [], // [{ project, open }]
		issue: null,
		focused: null, // post id
		tileIndex: 0,
		pending: [], // posts that arrived while scrolled down
		connected: false,
		viewers: 0,
		showingOriginal: new Set(),
		loading: false,
	};

	// What the user is typing or choosing, kept across re-renders of a post.
	const drafts = new Map(); // post id → { note, fileNotes: Map(item → text|null), answers: Map(question → { choices:Set, text }) }

	function draftOf(postId) {
		let draft = drafts.get(postId);
		if (!draft) {
			draft = { note: "", fileNotes: new Map(), answers: new Map() };
			drafts.set(postId, draft);
		}
		return draft;
	}

	// ── Small helpers ────────────────────────────────────────────────────────

	const $ = (selector, root = document) => root.querySelector(selector);
	const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
	const PROPS = new Set(["value", "checked", "muted", "loop", "autoplay", "playsInline", "disabled", "hidden", "draggable", "controls", "indeterminate"]);

	function h(tag, props, ...kids) {
		const el = document.createElement(tag);
		if (props) {
			for (const [key, value] of Object.entries(props)) {
				if (value === undefined || value === null || value === false) continue;
				if (key === "class") el.className = value;
				else if (key === "text") el.textContent = value;
				else if (key === "dataset") Object.assign(el.dataset, value);
				else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
				else if (PROPS.has(key)) el[key] = value;
				else el.setAttribute(key, value === true ? "" : String(value));
			}
		}
		for (const kid of kids.flat(Infinity)) {
			if (kid === undefined || kid === null || kid === false) continue;
			el.append(kid instanceof Node ? kid : String(kid));
		}
		return el;
	}

	function escapeHtml(text) {
		return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
	}

	// Inline Markdown on text that is already escaped, so only our own tags are added.
	function inlineMd(escaped) {
		return escaped
			.split(/(`[^`]+`)/)
			.map((part) => {
				if (part.length > 1 && part.startsWith("`") && part.endsWith("`")) return `<code>${part.slice(1, -1)}</code>`;
				return part
					.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
					.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
					.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
					.replace(/__([^_]+)__/g, "<strong>$1</strong>")
					.replace(/(^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*/g, "$1<em>$2</em>")
					.replace(/~~([^~]+)~~/g, "<del>$1</del>");
			})
			.join("");
	}

	// A small, safe Markdown: headings, lists, quotes, code blocks, paragraphs.
	function markdown(text, className = "md") {
		const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
		let html = "";
		let para = [];
		let list = null;
		let quote = [];
		let code = null;
		const flushPara = () => {
			if (para.length) html += `<p>${para.map((line) => inlineMd(escapeHtml(line))).join("<br>")}</p>`;
			para = [];
		};
		const flushList = () => {
			if (list) html += `<${list.type}>${list.items.map((item) => `<li>${inlineMd(escapeHtml(item))}</li>`).join("")}</${list.type}>`;
			list = null;
		};
		const flushQuote = () => {
			if (quote.length) html += `<blockquote>${quote.map((line) => inlineMd(escapeHtml(line))).join("<br>")}</blockquote>`;
			quote = [];
		};
		const flushAll = () => {
			flushPara();
			flushList();
			flushQuote();
		};
		for (const line of lines) {
			if (code) {
				if (/^\s*```/.test(line)) {
					html += `<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`;
					code = null;
				} else code.push(line);
				continue;
			}
			if (/^\s*```/.test(line)) {
				flushAll();
				code = [];
				continue;
			}
			const heading = /^(#{1,6})\s+(.*)$/.exec(line);
			if (heading) {
				flushAll();
				const level = Math.min(6, heading[1].length + 2);
				html += `<h${level}>${inlineMd(escapeHtml(heading[2]))}</h${level}>`;
				continue;
			}
			const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
			const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
			if (bullet || numbered) {
				flushPara();
				flushQuote();
				const type = bullet ? "ul" : "ol";
				if (!list || list.type !== type) {
					flushList();
					list = { type, items: [] };
				}
				list.items.push((bullet || numbered)[1]);
				continue;
			}
			const quoted = /^>\s?(.*)$/.exec(line);
			if (quoted) {
				flushPara();
				flushList();
				quote.push(quoted[1]);
				continue;
			}
			if (!line.trim()) {
				flushAll();
				continue;
			}
			if (list && /^\s{2,}\S/.test(line)) {
				list.items[list.items.length - 1] += " " + line.trim();
				continue;
			}
			flushList();
			flushQuote();
			para.push(line);
		}
		if (code) html += `<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`;
		flushAll();
		const el = document.createElement("div");
		el.className = className;
		el.innerHTML = html;
		return el;
	}

	function formatSize(bytes) {
		if (!Number.isFinite(bytes)) return "";
		if (bytes < 1024) return `${bytes} B`;
		const units = ["KB", "MB", "GB"];
		let value = bytes / 1024;
		let unit = 0;
		while (value >= 1024 && unit < units.length - 1) {
			value /= 1024;
			unit++;
		}
		return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
	}

	const absoluteFormat = new Intl.DateTimeFormat(LANG === "ja" ? "ja-JP" : undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
	const fullFormat = new Intl.DateTimeFormat(LANG === "ja" ? "ja-JP" : undefined, { dateStyle: "medium", timeStyle: "short" });

	function relativeTime(iso) {
		const then = Date.parse(iso);
		if (!Number.isFinite(then)) return "";
		const seconds = (Date.now() - then) / 1000;
		if (seconds < 45) return t("justNow");
		if (seconds < 3600) return t("minutesAgo", { n: Math.max(1, Math.round(seconds / 60)) });
		if (seconds < 86400) return t("hoursAgo", { n: Math.round(seconds / 3600) });
		if (seconds < 86400 * 7) return t("daysAgo", { n: Math.round(seconds / 86400) });
		return absoluteFormat.format(new Date(then));
	}

	function timeEl(iso) {
		const then = Date.parse(iso);
		return h("time", { class: "when", datetime: iso, title: Number.isFinite(then) ? fullFormat.format(new Date(then)) : "" }, relativeTime(iso));
	}

	function fileUrl(item, download = false) {
		return `/files/${item.id}/${encodeURIComponent(item.name || "file")}${download ? "?download" : ""}`;
	}

	function storageGet(key, fallback) {
		try {
			const raw = localStorage.getItem(key);
			return raw === null ? fallback : JSON.parse(raw);
		} catch {
			return fallback;
		}
	}

	function storageSet(key, value) {
		try {
			localStorage.setItem(key, JSON.stringify(value));
		} catch {
			/* storage blocked: unread dots just reset */
		}
	}

	let toastTimer = 0;
	function toast(text, error = false) {
		const el = $("#toast");
		el.textContent = text;
		el.classList.toggle("error", error);
		el.hidden = false;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (el.hidden = true), error ? 4200 : 2200);
	}

	async function api(path, body) {
		const options = body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
		const response = await fetch(path, options);
		let data = null;
		try {
			data = await response.json();
		} catch {
			/* not JSON */
		}
		if (!response.ok) throw new Error((data && data.error) || `${response.status} ${response.statusText}`);
		return data;
	}

	function debounce(fn, ms) {
		let timer = 0;
		return (...args) => {
			clearTimeout(timer);
			timer = setTimeout(() => fn(...args), ms);
		};
	}

	// ── Items ────────────────────────────────────────────────────────────────

	function itemsOf(post) {
		const map = new Map();
		for (const item of post.items || []) map.set(item.id, item);
		if (post.original) for (const item of post.original.items || []) if (!map.has(item.id)) map.set(item.id, item);
		return map;
	}

	const STILL = /^image\/(png|jpe?g|webp|bmp|avif)$/;
	const TEXTUAL = new Set(["text", "markdown", "html"]);

	let modelViewerLoading = null;
	function ensureModelViewer() {
		if (!modelViewerLoading) {
			modelViewerLoading = new Promise((resolve) => {
				const script = document.createElement("script");
				script.type = "module";
				script.src = "/vendor/model-viewer.js";
				script.onload = resolve;
				script.onerror = resolve;
				document.head.append(script);
			});
		}
		return modelViewerLoading;
	}

	const videoObserver =
		"IntersectionObserver" in window
			? new IntersectionObserver(
					(entries) => {
						for (const entry of entries) {
							const video = entry.target;
							if (entry.isIntersecting && entry.intersectionRatio >= 0.4) video.play().catch(() => {});
							else video.pause();
						}
					},
					{ threshold: [0, 0.4, 1] },
				)
			: null;

	function textPreview(item, big = false) {
		const box = h("div", { class: `text-preview ${item.kind}${big ? " big" : ""}` }, h("span", { class: "muted" }, t("loading")));
		fetch(fileUrl(item))
			.then((response) => {
				if (!response.ok) throw new Error(String(response.status));
				return response.text();
			})
			.then((text) => {
				const limit = big ? 400_000 : 60_000;
				const cut = text.length > limit;
				const shown = cut ? text.slice(0, limit) : text;
				box.replaceChildren(item.kind === "markdown" ? markdown(shown) : h("pre", null, shown));
				if (cut) box.append(h("div", { class: "muted cut" }, t("textTooLong")));
			})
			.catch(() => box.replaceChildren(h("span", { class: "muted" }, t("loadFailed"))));
		return box;
	}

	function mediaFor(item, big = false) {
		const url = fileUrl(item);
		switch (item.kind) {
			case "image":
				return h("img", { src: url, alt: item.name, loading: big ? "eager" : "lazy", decoding: "async", draggable: true });
			case "video": {
				const video = h("video", { src: `/play/${item.id}`, muted: true, loop: true, playsInline: true, preload: "metadata", controls: big });
				video.muted = true;
				if (big) video.autoplay = true;
				else if (videoObserver) videoObserver.observe(video);
				else video.autoplay = true;
				return video;
			}
			case "audio":
				return h("div", { class: "audio-box" }, h("div", { class: "audio-glyph" }, "♪"), h("audio", { src: url, controls: true, preload: "metadata" }));
			case "model": {
				ensureModelViewer();
				return h("model-viewer", { src: url, alt: item.name, "camera-controls": true, "auto-rotate": true, "interaction-prompt": "none", "shadow-intensity": "1", exposure: "1", loading: big ? "eager" : "lazy" });
			}
			case "pdf":
				return h("iframe", { src: url, title: item.name, loading: "lazy", class: "doc-frame" });
			case "html":
				return h("iframe", { src: url, title: item.name, loading: "lazy", sandbox: "allow-scripts", class: "doc-frame" });
			case "markdown":
			case "text":
				return textPreview(item, big);
			default:
				return h("a", { class: "file-only", href: fileUrl(item, true) }, h("span", { class: "file-glyph" }, (item.ext || "?").replace(".", "").toUpperCase() || "?"), h("span", null, t("cannotPreview")));
		}
	}

	async function copyItem(item, pathOnly) {
		try {
			if (!navigator.clipboard) throw new Error("no clipboard");
			if (!pathOnly && item.kind === "image" && STILL.test(item.mime) && window.ClipboardItem) {
				const png = fetch(fileUrl(item))
					.then((response) => response.blob())
					.then((blob) => toPng(blob));
				await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
				return toast(t("copiedImage"));
			}
			if (!pathOnly && TEXTUAL.has(item.kind)) {
				const text = await (await fetch(fileUrl(item))).text();
				await navigator.clipboard.writeText(text);
				return toast(t("copiedText"));
			}
			const pathPromise = api("/api/path", { item: item.id }).then((result) => result.path);
			if (window.ClipboardItem) {
				await navigator.clipboard.write([new ClipboardItem({ "text/plain": pathPromise.then((path) => new Blob([path], { type: "text/plain" })) })]);
			} else {
				await navigator.clipboard.writeText(await pathPromise);
			}
			toast(t("copiedPath"));
		} catch (error) {
			console.warn(error);
			toast(t("copyFailed"), true);
		}
	}

	async function toPng(blob) {
		if (blob.type === "image/png") return blob;
		const bitmap = await createImageBitmap(blob);
		const canvas = document.createElement("canvas");
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		canvas.getContext("2d").drawImage(bitmap, 0, 0);
		return new Promise((resolve, reject) => canvas.toBlob((png) => (png ? resolve(png) : reject(new Error("png"))), "image/png"));
	}

	function download(item) {
		const a = h("a", { href: fileUrl(item, true), download: item.name });
		document.body.append(a);
		a.click();
		a.remove();
	}

	function downloadAll(post) {
		(post.items || []).forEach((item, index) => setTimeout(() => download(item), index * 300));
	}

	function dragItem(event, item) {
		const url = new URL(fileUrl(item, true), location.href).href;
		event.dataTransfer.effectAllowed = "copy";
		event.dataTransfer.setData("DownloadURL", `${item.mime}:${item.name}:${url}`);
		event.dataTransfer.setData("text/uri-list", new URL(fileUrl(item), location.href).href);
		event.dataTransfer.setData("text/plain", new URL(fileUrl(item), location.href).href);
	}

	// One file: its preview, name, buttons, and its own notes.
	function tile(post, item, options = {}) {
		const draft = draftOf(post.id);
		const notes = (post.comments || []).filter((comment) => comment.item === item.id);
		const noteOpen = draft.fileNotes.has(item.id);
		const media = h("div", { class: `media kind-${item.kind}`, ondblclick: () => openLightbox(post.id, item.id) }, mediaFor(item));
		const mediaChild = media.firstElementChild;
		if (mediaChild && (item.kind === "image" || item.kind === "video")) {
			mediaChild.addEventListener("click", () => openLightbox(post.id, item.id));
		}
		const caption = h(
			"div",
			{ class: "tile-bar" },
			options.letter ? h("span", { class: "tile-letter" }, options.letter) : null,
			h(
				"span",
				{ class: "tile-name", draggable: true, title: item.name, ondragstart: (event) => dragItem(event, item) },
				item.name,
			),
			h("span", { class: "tile-size" }, formatSize(item.size)),
			item.verdict ? h("span", { class: `chip verdict ${item.verdict}` }, t(item.verdict === "adopted" ? "markedAdopted" : "markedRejected")) : null,
			h("span", { class: "spacer" }),
			h("button", { type: "button", class: "icon-btn small", title: t("copyTitle"), "aria-label": t("copy"), onclick: (event) => copyItem(item, event.shiftKey) }, "⧉"),
			h("button", { type: "button", class: "icon-btn small", title: t("download"), "aria-label": t("download"), onclick: () => download(item) }, "⤓"),
			h(
				"button",
				{
					type: "button",
					class: `icon-btn small note-btn${notes.length ? " has-notes" : ""}`,
					title: t("noteOnFile"),
					"aria-label": t("noteOnFile"),
					onclick: () => openFileNote(post.id, item.id),
				},
				"💬",
				notes.length ? h("span", { class: "note-count" }, String(notes.length)) : null,
			),
			h("button", { type: "button", class: "icon-btn small", title: `${t("fullscreen")} (f)`, "aria-label": t("fullscreen"), onclick: () => openLightbox(post.id, item.id) }, "⤢"),
		);
		const noteList = h("div", { class: "item-notes", dataset: { item: item.id } }, notes.map((comment) => commentEl(comment)), noteOpen ? fileNoteEditor(post, item) : null);
		const el = h("figure", { class: "tile", dataset: { item: item.id, post: post.id } }, media, caption, noteList);
		if (item.kind === "image") {
			const img = media.querySelector("img");
			img.addEventListener("dragstart", (event) => dragItem(event, item));
		}
		el.addEventListener("click", () => {
			focusPost(post.id, { tile: el, scroll: false });
		});
		return el;
	}

	function fileNoteEditor(post, item) {
		const draft = draftOf(post.id);
		const input = h("textarea", {
			class: "note-input",
			rows: 1,
			placeholder: t("fileNotePlaceholder"),
			dataset: { focusKey: `file:${post.id}:${item.id}` },
			value: draft.fileNotes.get(item.id) || "",
		});
		input.addEventListener("input", () => {
			draft.fileNotes.set(item.id, input.value);
			autosize(input);
		});
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
				event.preventDefault();
				sendComment(post.id, input.value, item.id);
			} else if (event.key === "Escape") {
				event.stopPropagation();
				draft.fileNotes.delete(item.id);
				updateNotes(post.id);
			}
		});
		const send = h("button", { type: "button", class: "btn small", onclick: () => sendComment(post.id, input.value, item.id) }, t("send"));
		return h("div", { class: "note-editor" }, input, send);
	}

	function openFileNote(postId, itemId) {
		const draft = draftOf(postId);
		if (!draft.fileNotes.has(itemId)) draft.fileNotes.set(itemId, "");
		updateNotes(postId);
		const input = $(`[data-focus-key="file:${postId}:${itemId}"]`);
		if (input) input.focus();
	}

	function autosize(textarea) {
		textarea.style.height = "auto";
		textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
	}

	function commentEl(comment) {
		const isOk = comment.text.trim() === "OK";
		return h(
			"div",
			{ class: `comment by-${comment.by}${isOk ? " ok" : ""}` },
			h("span", { class: "who" }, comment.by === "human" ? t("you") : t("agent")),
			isOk ? h("span", { class: "chip ok-chip" }, "✓ OK") : h("span", { class: "comment-text" }, comment.text),
			timeEl(comment.at),
		);
	}

	// ── Posts ────────────────────────────────────────────────────────────────

	function openQuestionsOf(post) {
		return (post.questions || []).filter((question) => !post.answers || !post.answers[question.id]);
	}

	function postTitle(post) {
		if (post.title) return post.title;
		const names = (post.items || []).map((item) => item.name);
		return names.length ? names.join(" · ") : post.id;
	}

	function shortSession(session) {
		return session ? session.slice(0, 8) : "";
	}

	function postHead(post) {
		const open = openQuestionsOf(post).length;
		const meta = h(
			"div",
			{ class: "post-meta" },
			timeEl(post.at),
			h("span", { class: "meta-project" }, post.project),
			post.issue ? h("span", { class: "chip issue-chip" }, post.issue) : post.lane && post.lane !== post.project ? h("span", { class: "meta-lane" }, post.lane) : null,
			post.branch && post.branch !== post.lane ? h("span", { class: "meta-branch", title: post.branch }, post.branch) : null,
			post.session ? h("span", { class: "meta-session", title: `${t("session")} ${post.session}` }, `◷ ${shortSession(post.session)}`) : null,
			(post.tags || []).map((tag) => h("span", { class: `chip tag tag-${tag}` }, tag)),
		);
		const badges = h(
			"div",
			{ class: "post-badges" },
			open ? h("span", { class: "chip waiting-chip" }, t("questionWaiting")) : null,
			post.amended && post.amended.length
				? h(
						"span",
						{
							class: "chip edited-chip",
							title: [t("editedTitle"), ...post.amended.map((note) => `${fullFormat.format(new Date(note.at))}${note.reason ? ` — ${note.reason}` : ""}`)].join("\n"),
						},
						t("edited", { n: post.amended.length }),
					)
				: null,
			h("a", { class: "permalink", href: `#${post.id}`, title: post.id }, "#"),
		);
		return h("header", { class: "post-head" }, h("div", { class: "post-title-row" }, h("h2", { class: "post-title" }, postTitle(post)), badges), meta);
	}

	function questionUsedItems(post) {
		const used = new Set();
		for (const question of post.questions || []) {
			for (const id of question.items || []) used.add(id);
			for (const option of question.options || []) for (const id of option.items || []) used.add(id);
		}
		return used;
	}

	function renderPost(post) {
		const view = state.showingOriginal.has(post.id) && post.original ? { ...post, ...post.original, comments: post.comments, answers: post.answers, amended: post.amended, original: post.original } : post;
		const isDevlog = post.kind === "devlog";
		const open = openQuestionsOf(post).length;
		const card = h("article", {
			class: `post${isDevlog ? " devlog" : ""}${open ? " waiting" : ""}${post.questions && post.questions.length ? " asks" : ""}`,
			id: post.id,
			dataset: { id: post.id },
			tabindex: "-1",
		});
		card.append(postHead(view));
		if (view.note) card.append(markdown(view.note, "md post-note"));
		if (isDevlog) card.append(devlogBody(post, view));
		else {
			if (post.questions && post.questions.length) card.append(questionsEl(post));
			const used = questionUsedItems(post);
			const loose = (post.items || []).filter((item) => !used.has(item.id));
			if (loose.length) card.append(h("div", { class: `grid n${Math.min(loose.length, 4)}` }, loose.map((item) => tile(post, item))));
		}
		card.append(threadEl(post));
		card.append(footerEl(post));
		card.addEventListener("focusin", () => focusPost(post.id, { scroll: false }));
		card.addEventListener("mousedown", () => focusPost(post.id, { scroll: false }));
		if (post.id === state.focused) card.classList.add("focused");
		return card;
	}

	function devlogBody(post, view) {
		const items = itemsOf(post);
		const devlog = view.devlog || { before: [], after: [], commits: [] };
		const box = h("div", { class: "devlog-body" });
		if (state.showingOriginal.has(post.id)) box.append(h("div", { class: "original-banner" }, t("asFirstRecorded")));
		if (devlog.summary) box.append(markdown(devlog.summary, "md dl-summary"));
		const before = (devlog.before || []).map((id) => items.get(id)).filter(Boolean);
		const after = (devlog.after || []).map((id) => items.get(id)).filter(Boolean);
		if (before.length || after.length) {
			box.append(
				h(
					"div",
					{ class: `before-after${before.length && after.length ? "" : " single"}` },
					before.length ? h("div", { class: "ba-col before" }, h("div", { class: "ba-label" }, t("before")), h("div", { class: "ba-tiles" }, before.map((item) => tile(post, item)))) : null,
					after.length ? h("div", { class: "ba-col after" }, h("div", { class: "ba-label" }, t("after")), h("div", { class: "ba-tiles" }, after.map((item) => tile(post, item)))) : null,
				),
			);
		}
		for (const [key, label] of [
			["craft", "craft"],
			["struggle", "struggle"],
			["decided", "decided"],
		]) {
			if (devlog[key]) box.append(h("section", { class: `dl-section dl-${key}` }, h("h3", null, t(label)), markdown(devlog[key])));
		}
		const placed = new Set([...(devlog.before || []), ...(devlog.after || [])]);
		const others = (view.items || []).filter((item) => !placed.has(item.id));
		if (others.length) box.append(h("section", { class: "dl-section" }, h("h3", null, t("otherFiles")), h("div", { class: `grid n${Math.min(others.length, 4)}` }, others.map((item) => tile(post, item)))));
		if (devlog.commits && devlog.commits.length) {
			box.append(
				h(
					"section",
					{ class: "dl-section dl-commits" },
					h("h3", null, t("commits")),
					h(
						"ul",
						{ class: "commits" },
						devlog.commits.map((commit) => h("li", null, h("code", { class: "sha" }, String(commit.sha).slice(0, 7)), h("span", null, commit.subject), commit.repo ? h("span", { class: "muted" }, ` · ${commit.repo}`) : null)),
					),
				),
			);
		}
		if (post.original && post.amended && post.amended.length) {
			box.append(
				h(
					"button",
					{
						type: "button",
						class: "btn ghost small toggle-original",
						onclick: () => {
							if (state.showingOriginal.has(post.id)) state.showingOriginal.delete(post.id);
							else state.showingOriginal.add(post.id);
							replaceCard(post.id);
						},
					},
					state.showingOriginal.has(post.id) ? t("showCurrent") : t("showOriginal"),
				),
			);
		}
		return box;
	}

	function threadEl(post) {
		const comments = (post.comments || []).filter((comment) => !comment.item);
		return h("div", { class: "thread" }, comments.map((comment) => commentEl(comment)));
	}

	function footerEl(post) {
		const draft = draftOf(post.id);
		const input = h("textarea", { class: "note-input", rows: 1, placeholder: t("notePlaceholder"), value: draft.note, dataset: { focusKey: `note:${post.id}` } });
		input.addEventListener("input", () => {
			draft.note = input.value;
			autosize(input);
		});
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
				event.preventDefault();
				sendComment(post.id, input.value.trim() ? input.value : "OK");
			} else if (event.key === "Escape") {
				event.stopPropagation();
				input.blur();
			}
		});
		const isAsk = post.questions && post.questions.length;
		return h(
			"footer",
			{ class: "post-foot" },
			input,
			h("button", { type: "button", class: "btn small", onclick: () => sendComment(post.id, input.value) }, t("send")),
			isAsk || post.kind === "devlog" ? null : h("button", { type: "button", class: "btn ok small", title: t("okTitle"), onclick: () => sendComment(post.id, "OK") }, "✓ " + t("ok")),
			(post.items || []).length > 1 ? h("button", { type: "button", class: "btn ghost small", onclick: () => downloadAll(post) }, t("downloadAll")) : null,
		);
	}

	async function sendComment(postId, text, itemId) {
		const value = String(text ?? "").trim();
		if (!value) return;
		try {
			const comment = await api("/api/comments", { post: postId, item: itemId, text: value, by: "human" });
			const draft = draftOf(postId);
			if (itemId) draft.fileNotes.delete(itemId);
			else draft.note = "";
			// The comment may already have arrived over the event stream, so redraw either way.
			const active = document.activeElement;
			if (active && active.dataset && active.dataset.focusKey === `file:${postId}:${itemId}`) active.blur();
			addComment(comment);
			updateNotes(postId);
			if (!itemId) {
				const input = $(`[data-focus-key="note:${postId}"]`);
				if (input) {
					input.value = "";
					autosize(input);
				}
			}
		} catch (error) {
			toast(t("sentFailed", { error: error.message }), true);
		}
	}

	// ── Questions ───────────────────────────────────────────────────────────

	function answerDraft(post, question) {
		const draft = draftOf(post.id);
		let answer = draft.answers.get(question.id);
		if (!answer) {
			const given = post.answers && post.answers[question.id];
			answer = { choices: new Set(given ? given.choices : []), text: given && given.text ? given.text : "", touched: false };
			draft.answers.set(question.id, answer);
		}
		return answer;
	}

	function questionsEl(post) {
		const questions = post.questions || [];
		const items = itemsOf(post);
		return h(
			"div",
			{ class: "questions" },
			questions.map((question, index) => {
				const given = post.answers && post.answers[question.id];
				const draft = answerDraft(post, question);
				const changed = draft.touched;
				const optionsEl = h(
					"div",
					{ class: `options${(question.options || []).some((option) => option.items && option.items.length) ? " visual" : ""}` },
					(question.options || []).map((option, optionIndex) => {
						const chosen = draft.choices.has(option.id);
						const wasAnswer = given && given.choices.includes(option.id);
						const optionItems = (option.items || []).map((id) => items.get(id)).filter(Boolean);
						const box = h(
							"div",
							{
								class: `option${chosen ? " chosen" : ""}${wasAnswer ? " answer" : ""}`,
								role: question.multi ? "checkbox" : "radio",
								"aria-checked": chosen ? "true" : "false",
								tabindex: "0",
								dataset: { option: option.id, question: question.id },
							},
							h("div", { class: "option-head" }, h("span", { class: "option-key" }, option.key || String.fromCharCode(65 + optionIndex)), option.label ? h("span", { class: "option-label" }, option.label) : null, h("span", { class: "option-check" }, question.multi ? (chosen ? "☑" : "☐") : chosen ? "◉" : "○")),
							option.body ? markdown(option.body, "md option-body") : null,
							optionItems.length ? h("div", { class: `grid n${Math.min(optionItems.length, 4)}` }, optionItems.map((item) => tile(post, item))) : null,
						);
						const toggle = (event) => {
							if (event.target.closest(".tile-bar, .item-notes, model-viewer, video, audio, iframe")) return;
							chooseOption(post.id, question.id, option.id);
						};
						box.addEventListener("click", toggle);
						box.addEventListener("keydown", (event) => {
							if (event.target !== box) return;
							if (event.key === " ") {
								event.preventDefault();
								chooseOption(post.id, question.id, option.id);
							}
						});
						return box;
					}),
				);
				const noteInput = h("textarea", { class: "note-input", rows: 1, placeholder: t("answerNotePlaceholder"), value: draft.text, dataset: { focusKey: `answer:${post.id}:${question.id}` } });
				noteInput.addEventListener("input", () => {
					draft.text = noteInput.value;
					draft.touched = true;
					autosize(noteInput);
					refreshSend(post.id, question.id);
				});
				noteInput.addEventListener("keydown", (event) => {
					if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
						event.preventDefault();
						sendAnswer(post.id, question.id);
					}
				});
				const sendButton = h("button", { type: "button", class: "btn primary small send-answer", dataset: { question: question.id }, onclick: () => sendAnswer(post.id, question.id) }, t("send"));
				sendButton.disabled = !draft.choices.size || (given && !changed);
				const aboutItems = (question.items || []).map((id) => items.get(id)).filter(Boolean);
				return h(
					"section",
					{ class: `question${given ? " answered" : " open"}`, dataset: { question: question.id } },
					h(
						"div",
						{ class: "q-head" },
						h("span", { class: "q-label" }, questions.length > 1 ? `${t("question")} ${index + 1}/${questions.length}` : t("question")),
						h("span", { class: "q-mode" }, question.multi ? t("pickSome") : t("pickOne")),
						h("span", { class: "spacer" }),
						given ? h("span", { class: "chip answered-chip", title: fullFormat.format(new Date(given.at)) }, `✓ ${t("answeredAt", { when: relativeTime(given.at) })}`) : h("span", { class: "chip waiting-chip" }, t("questionWaiting")),
					),
					h("div", { class: "q-text" }, question.text),
					question.why ? markdown(question.why, "md q-why") : null,
					aboutItems.length ? h("div", { class: "q-about" }, h("div", { class: "q-about-label" }, t("about")), h("div", { class: `grid n${Math.min(aboutItems.length, 4)}` }, aboutItems.map((item) => tile(post, item)))) : null,
					optionsEl,
					given && given.text && !changed ? h("div", { class: "q-given-note" }, h("span", { class: "who" }, t("you")), given.text) : null,
					h("div", { class: "q-foot" }, noteInput, sendButton),
				);
			}),
		);
	}

	function chooseOption(postId, questionId, optionId) {
		const post = state.posts.get(postId);
		if (!post) return;
		const question = (post.questions || []).find((candidate) => candidate.id === questionId);
		if (!question) return;
		const draft = answerDraft(post, question);
		if (question.multi) {
			if (draft.choices.has(optionId)) draft.choices.delete(optionId);
			else draft.choices.add(optionId);
		} else {
			draft.choices = new Set([optionId]);
		}
		draft.touched = true;
		const card = document.getElementById(postId);
		if (!card) return;
		for (const el of $$(`.option[data-question="${questionId}"]`, card)) {
			const chosen = draft.choices.has(el.dataset.option);
			el.classList.toggle("chosen", chosen);
			el.setAttribute("aria-checked", chosen ? "true" : "false");
			const check = $(".option-check", el);
			if (check) check.textContent = question.multi ? (chosen ? "☑" : "☐") : chosen ? "◉" : "○";
		}
		refreshSend(postId, questionId);
	}

	function refreshSend(postId, questionId) {
		const post = state.posts.get(postId);
		const card = document.getElementById(postId);
		if (!post || !card) return;
		const question = (post.questions || []).find((candidate) => candidate.id === questionId);
		const draft = answerDraft(post, question);
		const given = post.answers && post.answers[questionId];
		const button = $(`.send-answer[data-question="${questionId}"]`, card);
		if (button) button.disabled = !draft.choices.size || (given && !draft.touched);
	}

	async function sendAnswer(postId, questionId) {
		const post = state.posts.get(postId);
		if (!post) return;
		const question = (post.questions || []).find((candidate) => candidate.id === questionId);
		if (!question) return;
		const draft = answerDraft(post, question);
		if (!draft.choices.size) return toast(t("chooseFirst"), true);
		const order = (question.options || []).map((option) => option.id);
		const choices = [...draft.choices].sort((a, b) => order.indexOf(a) - order.indexOf(b));
		const button = $(`#${CSS.escape(postId)} .send-answer[data-question="${questionId}"]`);
		if (button) {
			button.disabled = true;
			button.textContent = t("sending");
		}
		try {
			const answer = await api("/api/answers", { post: postId, question: questionId, choices, text: draft.text.trim() || undefined, by: "human" });
			draftOf(postId).answers.delete(questionId);
			addAnswer(answer);
		} catch (error) {
			toast(t("sentFailed", { error: error.message }), true);
			if (button) {
				button.disabled = false;
				button.textContent = t("send");
			}
		}
	}

	// ── Updating posts in place ─────────────────────────────────────────────

	function cardFocusKey() {
		const active = document.activeElement;
		if (!active || !active.dataset || !active.dataset.focusKey) return null;
		return { key: active.dataset.focusKey, start: active.selectionStart, end: active.selectionEnd };
	}

	function restoreFocus(saved) {
		if (!saved) return;
		const el = $(`[data-focus-key="${CSS.escape(saved.key)}"]`);
		if (!el) return;
		el.focus();
		try {
			el.setSelectionRange(saved.start, saved.end);
		} catch {
			/* not a text field */
		}
	}

	function replaceCard(postId) {
		const post = state.posts.get(postId);
		const old = document.getElementById(postId);
		if (!post || !old) return;
		const saved = cardFocusKey();
		const tileIndex = state.focused === postId ? state.tileIndex : 0;
		const card = renderPost(post);
		old.replaceWith(card);
		restoreFocus(saved);
		if (state.focused === postId) markTile(card, tileIndex);
	}

	// Comments change only the thread, the per-file notes and the head.
	function updateNotes(postId) {
		const post = state.posts.get(postId);
		const card = document.getElementById(postId);
		if (!post || !card) return;
		const saved = cardFocusKey();
		const thread = $(".thread", card);
		if (thread) thread.replaceWith(threadEl(post));
		const draft = draftOf(postId);
		const items = itemsOf(post);
		for (const list of $$(".item-notes", card)) {
			const itemId = list.dataset.item;
			const item = items.get(itemId);
			if (!item) continue;
			const notes = (post.comments || []).filter((comment) => comment.item === itemId);
			list.replaceChildren(...notes.map((comment) => commentEl(comment)), ...(draft.fileNotes.has(itemId) ? [fileNoteEditor(post, item)] : []));
			const tileEl = list.closest(".tile");
			const button = tileEl && $(".note-btn", tileEl);
			if (button) {
				button.classList.toggle("has-notes", notes.length > 0);
				button.replaceChildren("💬", ...(notes.length ? [h("span", { class: "note-count" }, String(notes.length))] : []));
			}
		}
		restoreFocus(saved);
	}

	function updateQuestions(postId) {
		const post = state.posts.get(postId);
		const card = document.getElementById(postId);
		if (!post || !card) return;
		const saved = cardFocusKey();
		const old = $(".questions", card);
		if (old) old.replaceWith(questionsEl(post));
		const head = $(".post-head", card);
		if (head) head.replaceWith(postHead(state.showingOriginal.has(postId) && post.original ? { ...post, ...post.original, answers: post.answers, amended: post.amended } : post));
		card.classList.toggle("waiting", openQuestionsOf(post).length > 0);
		restoreFocus(saved);
	}

	function addComment(comment) {
		const post = state.posts.get(comment.post);
		if (!post) return;
		post.comments = post.comments || [];
		if (post.comments.some((existing) => existing.id === comment.id)) return;
		post.comments.push(comment);
		post.comments.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
		updateNotes(post.id);
	}

	function addAnswer(answer) {
		const post = state.posts.get(answer.post);
		if (!post) return;
		post.answers = post.answers || {};
		const current = post.answers[answer.question];
		if (current && (current.id === answer.id || current.at > answer.at)) return;
		post.answers[answer.question] = answer;
		const draft = drafts.get(post.id);
		if (draft) {
			const pending = draft.answers.get(answer.question);
			if (pending && !pending.touched) draft.answers.delete(answer.question);
		}
		updateQuestions(post.id);
		refreshTree();
	}

	// ── Feed ────────────────────────────────────────────────────────────────

	function scopeParams(extra = {}) {
		const params = new URLSearchParams();
		params.set("mode", state.mode);
		for (const key of ["project", "issue", "lane", "session"]) if (state.scope[key]) params.set(key, state.scope[key]);
		if (state.q) params.set("q", state.q);
		if (state.onlyOpen) params.set("open", "1");
		for (const [key, value] of Object.entries(extra)) if (value !== undefined) params.set(key, value);
		return params;
	}

	function syncUrl() {
		const params = new URLSearchParams();
		const lang = new URLSearchParams(location.search).get("lang");
		if (lang) params.set("lang", lang);
		if (state.mode !== "dailies") params.set("mode", state.mode);
		for (const key of ["project", "issue", "lane", "session"]) if (state.scope[key]) params.set(key, state.scope[key]);
		if (state.q) params.set("q", state.q);
		if (state.onlyOpen) params.set("open", "1");
		const query = params.toString();
		history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
	}

	function readUrl() {
		const params = new URLSearchParams(location.search);
		const mode = params.get("mode");
		state.mode = mode === "devlog" || mode === "ideas" ? mode : "dailies";
		state.scope = {};
		for (const key of ["project", "issue", "lane", "session"]) if (params.get(key)) state.scope[key] = params.get(key);
		state.q = params.get("q") || "";
		state.onlyOpen = params.get("open") === "1";
	}

	let loadToken = 0;
	async function load() {
		const token = ++loadToken;
		state.loading = true;
		syncUrl();
		renderChrome();
		renderKeys();
		try {
			if (state.mode === "ideas") return await loadIdeas(token);
			const data = await api(`/api/state?${scopeParams({ limit: PAGE })}`);
			if (token !== loadToken) return;
			applyMeta(data);
			state.posts.clear();
			state.order = [];
			state.pending = [];
			for (const post of data.posts) {
				state.posts.set(post.id, post);
				state.order.push(post.id);
			}
			state.hasMore = data.posts.length >= PAGE;
			renderFeed();
			renderTree();
			renderIssue();
			markGroupSeen();
		} catch (error) {
			console.error(error);
			toast(t("loadFailed"), true);
		} finally {
			if (token === loadToken) state.loading = false;
			renderChrome();
		}
	}

	async function loadMore() {
		if (!state.order.length) return false;
		const token = loadToken;
		const button = $("#more-btn");
		button.disabled = true;
		button.textContent = t("loading");
		try {
			const data = await api(`/api/state?${scopeParams({ limit: PAGE, before: state.order[state.order.length - 1] })}`);
			if (token !== loadToken) return false;
			const feed = $("#feed");
			for (const post of data.posts) {
				if (state.posts.has(post.id)) continue;
				state.posts.set(post.id, post);
				state.order.push(post.id);
				feed.append(renderPost(post));
			}
			state.hasMore = data.posts.length >= PAGE;
			return data.posts.length > 0;
		} catch (error) {
			console.error(error);
			return false;
		} finally {
			button.disabled = false;
			button.textContent = t("more");
			$("#more").hidden = !state.hasMore;
		}
	}

	function applyMeta(data) {
		if (data.tree) state.tree = data.tree;
		if (data.counts) state.counts = data.counts;
		if ("issue" in data) state.issue = data.issue;
	}

	function renderFeed() {
		const feed = $("#feed");
		feed.replaceChildren(...state.order.map((id) => renderPost(state.posts.get(id))));
		$("#more").hidden = !state.hasMore;
		$("#more-btn").textContent = t("more");
		renderEmpty();
		renderPill();
		if (state.focused && !state.posts.has(state.focused)) state.focused = null;
	}

	function renderEmpty() {
		const empty = $("#empty");
		if (state.order.length) {
			empty.hidden = true;
			return;
		}
		const filtered = state.q || state.onlyOpen || Object.keys(state.scope).length;
		const devlog = state.mode === "devlog";
		empty.replaceChildren(
			h("div", { class: "empty-art" }, devlog ? "✎" : "▣"),
			h("h2", null, filtered ? t("emptySearch") : t(devlog ? "emptyDevlogTitle" : "emptyDailiesTitle")),
			filtered ? null : markdown(t(devlog ? "emptyDevlog" : "emptyDailies")),
		);
		empty.hidden = false;
	}

	function matchesView(post) {
		if (state.mode === "ideas") return false;
		const isDevlog = post.kind === "devlog";
		if ((state.mode === "devlog") !== isDevlog) return false;
		if (post.retracted) return false;
		const scope = state.scope;
		if (scope.project && post.project !== scope.project) return false;
		if (scope.issue && String(post.issue || "").toUpperCase() !== scope.issue.toUpperCase()) return false;
		if (scope.lane && (post.lane !== scope.lane || (post.issue && !scope.issue))) return false;
		if (scope.session && post.session !== scope.session) return false;
		if (state.onlyOpen && !openQuestionsOf(post).length) return false;
		if (state.q) {
			const q = state.q.toLowerCase();
			const hay = [post.title, post.note, post.issue, post.branch, post.lane, post.project, ...(post.items || []).map((item) => item.name), post.devlog && [post.devlog.summary, post.devlog.craft, post.devlog.struggle, post.devlog.decided]]
				.flat()
				.filter(Boolean)
				.join("\n")
				.toLowerCase();
			if (!hay.includes(q)) return false;
		}
		return true;
	}

	function nearTop() {
		return window.scrollY < 160;
	}

	function receivePost(post) {
		const known = state.posts.has(post.id);
		state.posts.set(post.id, post);
		if (known) {
			if (document.getElementById(post.id)) replaceCard(post.id);
			return;
		}
		if (!matchesView(post)) return;
		if (nearTop() && !state.pending.length) insertTop([post]);
		else {
			state.pending.push(post);
			renderPill();
		}
	}

	function insertTop(posts) {
		const feed = $("#feed");
		const sorted = posts.slice().sort((a, b) => (a.at < b.at ? -1 : 1));
		for (const post of sorted) {
			if (state.order.includes(post.id)) continue;
			state.order.unshift(post.id);
			const card = renderPost(state.posts.get(post.id) || post);
			card.classList.add("arriving");
			feed.prepend(card);
			setTimeout(() => card.classList.remove("arriving"), 900);
		}
		renderEmpty();
	}

	function renderPill() {
		const pill = $("#new-pill");
		if (!state.pending.length) {
			pill.hidden = true;
			return;
		}
		pill.textContent = t("newPosts", { n: state.pending.length });
		pill.hidden = false;
	}

	function showPending() {
		const posts = state.pending;
		state.pending = [];
		insertTop(posts);
		renderPill();
		window.scrollTo({ top: 0, behavior: "smooth" });
		if (posts.length) focusPost(posts.reduce((a, b) => (a.at > b.at ? a : b)).id, { scroll: false });
	}

	function removePost(postId) {
		state.order = state.order.filter((id) => id !== postId);
		state.pending = state.pending.filter((post) => post.id !== postId);
		const card = document.getElementById(postId);
		if (card) card.remove();
		if (state.focused === postId) state.focused = null;
		renderEmpty();
		renderPill();
	}

	function insertByTime(post) {
		if (state.order.includes(post.id) || !matchesView(post)) return;
		const feed = $("#feed");
		const index = state.order.findIndex((id) => (state.posts.get(id)?.at || "") < post.at);
		const card = renderPost(post);
		if (index < 0) {
			if (state.hasMore) return; // older than what is loaded: it comes with the next page
			state.order.push(post.id);
			feed.append(card);
		} else {
			const before = document.getElementById(state.order[index]);
			state.order.splice(index, 0, post.id);
			if (before) before.before(card);
			else feed.append(card);
		}
		renderEmpty();
	}

	// ── Header, tabs, issue card ────────────────────────────────────────────

	function renderChrome() {
		for (const tab of $$(".tab")) {
			const mode = tab.dataset.mode;
			tab.classList.toggle("active", mode === state.mode);
			tab.setAttribute("aria-pressed", mode === state.mode ? "true" : "false");
			const count = state.counts[mode];
			$(".tab-count", tab).textContent = count ? String(count) : "";
		}
		const waiting = $("#waiting-btn");
		const open = state.counts.open || 0;
		waiting.hidden = !open && !state.onlyOpen;
		waiting.replaceChildren(h("span", { class: "full" }, state.onlyOpen ? `✕ ${t("waiting", { n: open })}` : t("waiting", { n: open })), h("span", { class: "short" }, `${state.onlyOpen ? "✕ " : ""}? ${open}`));
		waiting.title = t("waiting", { n: open });
		waiting.classList.toggle("active", state.onlyOpen);

		const scope = $("#scope");
		const parts = [];
		if (state.scope.project) parts.push(state.scope.project);
		if (state.scope.issue) parts.push(state.scope.issue);
		else if (state.scope.lane) parts.push(state.scope.lane);
		if (state.scope.session) parts.push(`◷ ${shortSession(state.scope.session)}`);
		if (state.q) parts.push(`“${state.q}”`);
		scope.hidden = !parts.length;
		$("#scope-text").textContent = parts.join(" › ");

		const conn = $("#conn");
		conn.classList.toggle("live", state.connected);
		$("#conn-text").textContent = state.connected ? (state.viewers > 1 ? t("connViewers", { n: state.viewers }) : t("connLive")) : t("connOffline");
		document.body.classList.toggle("is-loading", state.loading);
		document.body.dataset.mode = state.mode;
		const search = $("#search");
		if (document.activeElement !== search && search.value !== state.q) search.value = state.q;
		document.title = open ? `(${open}) KustomAD` : "KustomAD";
	}

	function renderIssue() {
		const card = $("#issue-card");
		const issue = state.issue;
		if (!state.scope.issue) {
			card.hidden = true;
			return;
		}
		const key = (issue && issue.key) || state.scope.issue;
		card.replaceChildren(
			h(
				"div",
				{ class: "issue-head" },
				h("span", { class: "chip issue-chip big" }, key.toUpperCase()),
				h("h2", { class: "issue-title" }, (issue && issue.title) || ""),
				issue && issue.status ? h("span", { class: "chip status-chip", title: t("issueStatus") }, issue.status) : null,
				h("span", { class: "spacer" }),
				issue && issue.url && /^https?:\/\//.test(issue.url) ? h("a", { class: "btn ghost small", href: issue.url, target: "_blank", rel: "noopener noreferrer" }, `${t("issueOpen")} ↗`) : null,
			),
			issue && issue.details && issue.details.length ? h("div", { class: "issue-details" }, issue.details.map((detail) => h("span", { class: "chip" }, detail))) : null,
			issue && issue.description ? markdown(issue.description, "md issue-desc") : issue ? h("p", { class: "muted" }, t("issueNoDescription")) : null,
		);
		card.hidden = false;
	}

	// ── Sidebar tree ────────────────────────────────────────────────────────

	const SEEN_KEY = "kustomad:seen";
	let seen = storageGet(SEEN_KEY, null);

	function groupScope(group) {
		return group.issue ? { project: group.project, issue: group.issue } : { project: group.project, lane: group.lane };
	}

	function sameScope(a, b) {
		const keys = ["project", "issue", "lane", "session"];
		return keys.every((key) => (a[key] || "").toLowerCase() === (b[key] || "").toLowerCase());
	}

	function seenKey(group) {
		return `${state.mode}|${group.id}`;
	}

	function initSeen() {
		if (seen) return;
		seen = {};
		for (const project of state.tree) for (const group of project.groups) seen[seenKey(group)] = group.last;
		storageSet(SEEN_KEY, seen);
	}

	function markGroupSeen() {
		initSeen();
		let changed = false;
		for (const project of state.tree) {
			for (const group of project.groups) {
				const inScope = state.scope.project === group.project && ((group.issue && (state.scope.issue || "").toUpperCase() === group.issue.toUpperCase()) || (!group.issue && state.scope.lane === group.lane));
				if (inScope && seen[seenKey(group)] !== group.last) {
					seen[seenKey(group)] = group.last;
					changed = true;
				}
			}
		}
		if (changed) storageSet(SEEN_KEY, seen);
	}

	function renderTree() {
		initSeen();
		const tree = $("#tree");
		const total = state.tree.reduce((sum, project) => sum + project.groups.reduce((n, group) => n + group.count, 0), 0);
		const nodes = [];
		nodes.push(
			h(
				"button",
				{ type: "button", class: `node all${Object.keys(state.scope).length ? "" : " active"}`, dataset: { scope: "{}" } },
				h("span", { class: "node-title" }, t("allProjects")),
				h("span", { class: "node-count" }, total ? String(total) : ""),
			),
		);
		for (const project of state.tree) {
			const projectActive = state.scope.project === project.project && !state.scope.issue && !state.scope.lane;
			const groups = project.groups.map((group) => {
				const scope = groupScope(group);
				const active = state.scope.project === group.project && sameScope({ ...scope }, { project: state.scope.project, issue: state.scope.issue, lane: state.scope.lane });
				const unread = !active && seen && (seen[seenKey(group)] || "") < group.last;
				const label = group.issue
					? [h("span", { class: "node-key" }, group.issue), h("span", { class: "node-title" }, group.title && group.title !== group.lane ? group.title : group.title || "")]
					: [h("span", { class: "node-title lane" }, group.lane)];
				const button = h(
					"button",
					{ type: "button", class: `node group${active && !state.scope.session ? " active" : ""}${active ? " open" : ""}`, dataset: { scope: JSON.stringify(scope) }, title: group.branch || group.title },
					h("span", { class: `unread-dot${unread ? " on" : ""}` }),
					label,
					group.status ? h("span", { class: "node-status" }, group.status) : null,
					group.open ? h("span", { class: "node-open" }, t("openBadge", { n: group.open })) : null,
					h("span", { class: "node-count" }, String(group.count)),
				);
				const sessions =
					active && group.sessions && group.sessions.length > 0
						? h(
								"div",
								{ class: "sessions" },
								group.sessions.map((session) =>
									h(
										"button",
										{
											type: "button",
											class: `node session${state.scope.session === session.session ? " active" : ""}`,
											dataset: { scope: JSON.stringify({ ...scope, session: session.session }) },
											title: `${t("session")} ${session.session}`,
										},
										h("span", { class: "node-title" }, session.title || shortSession(session.session)),
										session.open ? h("span", { class: "node-open" }, t("openBadge", { n: session.open })) : null,
										h("span", { class: "node-time" }, relativeTime(session.last)),
									),
								),
							)
						: null;
				return h("div", { class: "group-wrap" }, button, sessions);
			});
			nodes.push(
				h(
					"div",
					{ class: "project" },
					h("button", { type: "button", class: `node project-node${projectActive ? " active" : ""}`, dataset: { scope: JSON.stringify({ project: project.project }) } }, h("span", { class: "node-title" }, project.project), h("span", { class: "node-time" }, relativeTime(project.last))),
					groups,
				),
			);
		}
		tree.replaceChildren(...nodes);
	}

	const refreshTree = debounce(async () => {
		try {
			if (state.mode === "ideas") return await loadIdeas(loadToken);
			const data = await api(`/api/tree?mode=${state.mode}`);
			applyMeta(data);
			renderTree();
			renderChrome();
		} catch (error) {
			console.warn(error);
		}
	}, 250);

	function setScope(scope) {
		state.scope = scope;
		state.focused = null;
		closeDrawer();
		load().then(() => window.scrollTo({ top: 0 }));
	}

	function moveInTree(step) {
		const nodes = $$("#tree .node");
		if (!nodes.length) return;
		let index = nodes.findIndex((node) => node.classList.contains("active"));
		index = index < 0 ? 0 : Math.max(0, Math.min(nodes.length - 1, index + step));
		const node = nodes[index];
		setScope(JSON.parse(node.dataset.scope));
	}

	// ── Focus, selection, keyboard ──────────────────────────────────────────

	const sendSelection = debounce((postId, itemId) => {
		api("/api/select", { post: postId, item: itemId }).catch((error) => console.warn(error));
	}, 350);

	function cards() {
		return $$("#feed > .post");
	}

	function tilesOf(card) {
		return $$(".tile", card);
	}

	function markTile(card, index) {
		const tiles = tilesOf(card);
		for (const el of $$(".tile.focused")) el.classList.remove("focused");
		if (!tiles.length) {
			state.tileIndex = 0;
			return null;
		}
		state.tileIndex = Math.max(0, Math.min(tiles.length - 1, index));
		const el = tiles[state.tileIndex];
		el.classList.add("focused");
		return el;
	}

	function focusPost(postId, { tile: tileEl, tileIndex, scroll = true } = {}) {
		const card = document.getElementById(postId);
		if (!card) return;
		const changed = state.focused !== postId;
		if (changed) {
			for (const el of $$(".post.focused")) el.classList.remove("focused");
			card.classList.add("focused");
			state.focused = postId;
		}
		let index = tileIndex ?? (changed ? 0 : state.tileIndex);
		if (tileEl) index = tilesOf(card).indexOf(tileEl);
		const current = markTile(card, index);
		if (scroll) {
			const rect = card.getBoundingClientRect();
			if (rect.top < 70 || rect.top > window.innerHeight * 0.5) {
				window.scrollTo({ top: window.scrollY + rect.top - 72, behavior: "smooth" });
			}
		}
		sendSelection(postId, current ? current.dataset.item : undefined);
	}

	function focusedTileItem() {
		if (!state.focused) return null;
		const post = state.posts.get(state.focused);
		const card = document.getElementById(state.focused);
		if (!post || !card) return null;
		const el = tilesOf(card)[state.tileIndex];
		if (!el) return null;
		return itemsOf(post).get(el.dataset.item) || null;
	}

	function movePost(step) {
		const list = cards();
		if (!list.length) return;
		let index = list.findIndex((card) => card.dataset.id === state.focused);
		if (index < 0) {
			// Start from the first card on screen.
			index = list.findIndex((card) => card.getBoundingClientRect().bottom > 80);
			if (index < 0) index = 0;
			return focusPost(list[index].dataset.id, { tileIndex: 0 });
		}
		const next = index + step;
		if (next >= list.length) {
			if (state.hasMore) loadMore().then((added) => added && movePost(step));
			return;
		}
		if (next < 0) return;
		focusPost(list[next].dataset.id, { tileIndex: 0 });
	}

	function moveTile(step) {
		if (!state.focused) return movePost(0);
		const card = document.getElementById(state.focused);
		if (!card) return;
		const el = markTile(card, state.tileIndex + step);
		if (el) {
			el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
			sendSelection(state.focused, el.dataset.item);
		}
	}

	function keyChooseOption(number) {
		const post = state.focused && state.posts.get(state.focused);
		if (!post || !post.questions || !post.questions.length) return;
		const question = openQuestionsOf(post)[0] || post.questions[0];
		const option = question.options[number - 1];
		if (option) chooseOption(post.id, question.id, option.id);
	}

	function keySend() {
		const post = state.focused && state.posts.get(state.focused);
		if (!post || !post.questions || !post.questions.length) return;
		const draft = drafts.get(post.id);
		const question = (post.questions || []).find((candidate) => draft && draft.answers.get(candidate.id) && draft.answers.get(candidate.id).touched) || openQuestionsOf(post)[0];
		if (question) sendAnswer(post.id, question.id);
	}

	function typing(target) {
		return target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
	}

	function onKey(event) {
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (!$("#lightbox").hidden) return onLightboxKey(event);
		if (typing(event.target)) {
			if (event.key === "Escape") event.target.blur();
			return;
		}
		const key = event.key;
		const actions = {
			j: () => movePost(1),
			k: () => movePost(-1),
			h: () => moveTile(-1),
			l: () => moveTile(1),
			o: () => {
				const post = state.focused && state.posts.get(state.focused);
				if (post && post.kind !== "devlog" && !(post.questions && post.questions.length)) sendComment(post.id, "OK");
			},
			c: () => {
				const item = focusedTileItem();
				if (item) openFileNote(state.focused, item.id);
				else if (state.focused) $(`[data-focus-key="note:${state.focused}"]`)?.focus();
			},
			C: () => state.focused && $(`[data-focus-key="note:${state.focused}"]`)?.focus(),
			f: () => {
				const item = focusedTileItem();
				if (item) openLightbox(state.focused, item.id);
			},
			y: () => {
				const item = focusedTileItem();
				if (item) copyItem(item, false);
			},
			Y: () => {
				const item = focusedTileItem();
				if (item) copyItem(item, true);
			},
			d: () => {
				const item = focusedTileItem();
				if (item) download(item);
			},
			Enter: () => keySend(),
			n: () => state.mode === "ideas" && $("#idea-new-title")?.focus(),
			"[": () => moveInTree(-1),
			"]": () => moveInTree(1),
			"/": () => $("#search").focus(),
			Escape: () => {
				closeDrawer();
				if (state.pending.length) showPending();
			},
		};
		if (/^[1-9]$/.test(key)) {
			event.preventDefault();
			return keyChooseOption(Number(key));
		}
		const action = actions[key];
		if (action) {
			event.preventDefault();
			action();
		}
	}

	function renderKeys() {
		const keys = state.mode === "ideas" ? [["n", t("keysNewIdea")], ["[ ]", t("keysSide")], ["/", t("keysSearch")]] : [
			["j k", t("keysPosts")],
			["h l", t("keysFiles")],
			["o", t("keysOk")],
			["c C", t("keysNote")],
			["f", t("keysFull")],
			["1–9", t("keysChoose")],
			["↵", t("keysSend")],
			["y Y", t("keysCopy")],
			["d", t("keysDownload")],
			["[ ]", t("keysSide")],
			["/", t("keysSearch")],
		];
		$("#keys").replaceChildren(...keys.map(([combo, label]) => h("span", { class: "key" }, combo.split(" ").map((part) => h("kbd", null, part)), h("span", null, label))));
	}

	// ── Lightbox ────────────────────────────────────────────────────────────

	const lightbox = { postId: null, items: [], index: 0, noting: false };

	function openLightbox(postId, itemId) {
		const post = state.posts.get(postId);
		const card = document.getElementById(postId);
		if (!post || !card) return;
		const items = itemsOf(post);
		const ids = [];
		for (const el of tilesOf(card)) if (!ids.includes(el.dataset.item)) ids.push(el.dataset.item);
		lightbox.postId = postId;
		lightbox.items = ids.map((id) => items.get(id)).filter(Boolean);
		lightbox.index = Math.max(0, lightbox.items.findIndex((item) => item.id === itemId));
		lightbox.noting = false;
		$("#lightbox").hidden = false;
		document.body.classList.add("no-scroll");
		renderLightbox();
	}

	function renderLightbox() {
		const item = lightbox.items[lightbox.index];
		if (!item) return closeLightbox();
		const post = state.posts.get(lightbox.postId);
		const stage = $("#lb-stage");
		stage.replaceChildren(h("div", { class: `lb-media kind-${item.kind}` }, mediaFor(item, true)));
		const notes = ((post && post.comments) || []).filter((comment) => comment.item === item.id);
		const caption = $("#lb-caption");
		caption.replaceChildren(h("strong", null, item.name), h("span", { class: "muted" }, ` ${lightbox.index + 1}/${lightbox.items.length} · ${formatSize(item.size)}`), notes.length ? h("span", { class: "lb-notes" }, notes.map((comment) => commentEl(comment))) : null);
		$("#lb-prev").disabled = lightbox.index === 0;
		$("#lb-next").disabled = lightbox.index >= lightbox.items.length - 1;
		const bar = $(".lb-bar");
		const existing = $(".lb-editor", bar);
		if (existing) existing.remove();
		if (lightbox.noting) {
			const input = h("input", { type: "text", class: "lb-editor note-input", placeholder: t("fileNotePlaceholder") });
			input.addEventListener("keydown", (event) => {
				event.stopPropagation();
				if (event.key === "Enter" && !event.isComposing) {
					event.preventDefault();
					sendComment(lightbox.postId, input.value, item.id).then(() => {
						lightbox.noting = false;
						renderLightbox();
					});
				} else if (event.key === "Escape") {
					lightbox.noting = false;
					renderLightbox();
				}
			});
			bar.insertBefore(input, $("#lb-note"));
			input.focus();
		}
		const card = document.getElementById(lightbox.postId);
		if (card) {
			const index = tilesOf(card).findIndex((el) => el.dataset.item === item.id);
			if (index >= 0) focusPost(lightbox.postId, { tileIndex: index, scroll: false });
		}
	}

	function closeLightbox() {
		$("#lightbox").hidden = true;
		$("#lb-stage").replaceChildren();
		document.body.classList.remove("no-scroll");
	}

	function onLightboxKey(event) {
		if (typing(event.target)) return;
		const item = lightbox.items[lightbox.index];
		switch (event.key) {
			case "Escape":
			case "f":
				event.preventDefault();
				return closeLightbox();
			case "ArrowLeft":
			case "h":
				event.preventDefault();
				if (lightbox.index > 0) {
					lightbox.index--;
					renderLightbox();
				}
				return;
			case "ArrowRight":
			case "l":
				event.preventDefault();
				if (lightbox.index < lightbox.items.length - 1) {
					lightbox.index++;
					renderLightbox();
				}
				return;
			case "c":
				event.preventDefault();
				lightbox.noting = true;
				return renderLightbox();
			case "y":
			case "Y":
				event.preventDefault();
				return item && copyItem(item, event.key === "Y");
			case "d":
				event.preventDefault();
				return item && download(item);
		}
	}

	// ── Idea board ──────────────────────────────────────────────────────────
	// Ideas and things to implement, in columns by status. Anyone may add or move them; agents
	// do the same with `kustomad idea`.

	const IDEA_COLUMNS = ["idea", "candidate", "doing", "done"];
	const IDEA_STATUSES = [...IDEA_COLUMNS, "dropped"];
	const board = { dropped: false, editing: null /* { id, title, body, project } */, draft: { title: "", body: "", project: null, status: "idea" } };

	async function loadIdeas(token) {
		const params = new URLSearchParams({ all: "1" });
		if (state.scope.project) params.set("project", state.scope.project);
		if (state.q) params.set("q", state.q);
		const data = await api(`/api/ideas?${params}`);
		if (token !== loadToken) return;
		state.ideas = new Map(data.ideas.map((idea) => [idea.id, idea]));
		state.ideaProjects = data.projects || [];
		if (data.counts) state.counts = data.counts;
		renderBoard();
		renderIdeaTree();
		renderChrome();
	}

	function matchesIdea(idea) {
		if (state.scope.project && idea.project && idea.project !== state.scope.project) return false;
		if (!state.q) return true;
		const hay = [idea.title, idea.body, idea.project].filter(Boolean).join("\n").toLowerCase();
		return state.q.toLowerCase().split(/\s+/).filter(Boolean).every((word) => hay.includes(word));
	}

	function statusLabel(status) {
		return t(`ideaStatus_${status}`);
	}

	function projectSelect(value, onchange, focusKey) {
		const names = state.ideaProjects.map((entry) => entry.project);
		if (value && !names.includes(value)) names.unshift(value);
		const select = h("select", { class: "idea-select", title: t("ideaProject"), dataset: focusKey ? { focusKey } : undefined, onchange: (event) => onchange(event.target.value) }, h("option", { value: "" }, t("ideaGlobal")), names.map((name) => h("option", { value: name }, name)));
		select.value = value || "";
		return select;
	}

	function statusSelect(value, onchange) {
		const select = h("select", { class: `idea-select status s-${value}`, title: t("ideaMove"), onchange: (event) => onchange(event.target.value) }, IDEA_STATUSES.map((status) => h("option", { value: status }, statusLabel(status))));
		select.value = value;
		return select;
	}

	async function changeIdea(id, change) {
		try {
			const result = await api("/api/ideas/change", { idea: id, ...change, by: "human" });
			state.ideas.set(result.idea.id, result.idea);
			renderBoard();
			return true;
		} catch (error) {
			if (!/nothing to change/.test(error.message)) toast(t("sentFailed", { error: error.message }), true);
			return false;
		}
	}

	async function addIdea() {
		const draft = board.draft;
		const title = draft.title.trim();
		if (!title) return $("#idea-new-title")?.focus();
		const project = draft.project === null ? state.scope.project || "" : draft.project;
		try {
			const result = await api("/api/ideas", { title, body: draft.body, project, status: draft.status, by: "human" });
			state.ideas.set(result.idea.id, result.idea);
			board.draft = { title: "", body: "", project: draft.project, status: draft.status };
			renderBoard(true);
			$("#idea-new-title")?.focus();
		} catch (error) {
			toast(t("sentFailed", { error: error.message }), true);
		}
	}

	function composerEl() {
		const draft = board.draft;
		const title = h("input", {
			type: "text",
			id: "idea-new-title",
			class: "idea-input",
			placeholder: t("ideaNewTitle"),
			value: draft.title,
			autocomplete: "off",
			dataset: { focusKey: "idea-new-title" },
			oninput: (event) => (draft.title = event.target.value),
			onkeydown: (event) => {
				if (event.key === "Enter" && !event.isComposing) {
					event.preventDefault();
					addIdea();
				}
			},
		});
		const body = h("textarea", {
			class: "idea-input idea-body-input",
			rows: 2,
			placeholder: t("ideaBodyPlaceholder"),
			value: draft.body,
			dataset: { focusKey: "idea-new-body" },
			oninput: (event) => {
				draft.body = event.target.value;
				autosize(event.target);
			},
			onkeydown: (event) => {
				if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
					event.preventDefault();
					addIdea();
				}
			},
		});
		const project = draft.project === null ? state.scope.project || "" : draft.project;
		return h(
			"form",
			{ class: "idea-composer", onsubmit: (event) => (event.preventDefault(), addIdea()) },
			title,
			body,
			h(
				"div",
				{ class: "idea-composer-row" },
				projectSelect(project, (value) => (draft.project = value), "idea-new-project"),
				statusSelect(draft.status, (value) => {
					draft.status = value;
					renderBoard();
				}),
				h("span", { class: "spacer" }),
				h("button", { type: "submit", class: "btn primary small" }, t("ideaAdd")),
			),
		);
	}

	function ideaEditor(idea) {
		const edit = board.editing;
		const save = async () => {
			const ok = await changeIdea(idea.id, { title: edit.title, body: edit.body, project: edit.project });
			if (ok || edit.title.trim()) {
				board.editing = null;
				renderBoard();
			}
		};
		const cancel = () => {
			board.editing = null;
			renderBoard();
		};
		const keys = (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				cancel();
			} else if (event.key === "Enter" && (event.metaKey || event.ctrlKey || (event.target.tagName === "INPUT" && !event.isComposing))) {
				event.preventDefault();
				save();
			}
		};
		const body = h("textarea", {
			class: "idea-input idea-body-input",
			rows: 3,
			value: edit.body,
			placeholder: t("ideaBodyPlaceholder"),
			dataset: { focusKey: `idea-edit-body:${idea.id}` },
			oninput: (event) => {
				edit.body = event.target.value;
				autosize(event.target);
			},
			onkeydown: keys,
		});
		requestAnimationFrame(() => autosize(body));
		return h(
			"article",
			{ class: `idea editing s-${idea.status}`, id: idea.id },
			h("input", { type: "text", class: "idea-input", value: edit.title, dataset: { focusKey: `idea-edit-title:${idea.id}` }, oninput: (event) => (edit.title = event.target.value), onkeydown: keys }),
			body,
			h(
				"div",
				{ class: "idea-composer-row" },
				projectSelect(edit.project, (value) => (edit.project = value)),
				h("span", { class: "spacer" }),
				h("button", { type: "button", class: "btn ghost small", onclick: cancel }, t("ideaCancel")),
				h("button", { type: "button", class: "btn primary small", onclick: save }, t("ideaSave")),
			),
		);
	}

	function startEdit(idea) {
		board.editing = { id: idea.id, title: idea.title, body: idea.body || "", project: idea.project || "" };
		renderBoard();
		$(`[data-focus-key="idea-edit-title:${CSS.escape(idea.id)}"]`)?.focus();
	}

	function ideaCard(idea) {
		if (board.editing && board.editing.id === idea.id) return ideaEditor(idea);
		const card = h(
			"article",
			{ class: `idea s-${idea.status}`, id: idea.id, draggable: true, dataset: { id: idea.id } },
			h("div", { class: "idea-head" }, h("h3", { class: "idea-title" }, idea.title), h("button", { type: "button", class: "icon-btn small", title: t("ideaEdit"), "aria-label": t("ideaEdit"), onclick: () => startEdit(idea) }, "✎")),
			idea.body ? markdown(idea.body, "md idea-body") : null,
			h(
				"div",
				{ class: "idea-meta" },
				idea.project ? h("span", { class: "chip" }, idea.project) : h("span", { class: "chip global" }, t("ideaGlobal")),
				h("span", { class: "muted" }, idea.by === "agent" ? t("agent") : t("you")),
				timeEl(idea.updated),
				h("span", { class: "spacer" }),
				statusSelect(idea.status, (value) => changeIdea(idea.id, { status: value })),
			),
		);
		card.addEventListener("dragstart", (event) => {
			event.dataTransfer.setData("text/x-idea", idea.id);
			event.dataTransfer.effectAllowed = "move";
			card.classList.add("dragging");
		});
		card.addEventListener("dragend", () => card.classList.remove("dragging"));
		return card;
	}

	function columnEl(status, ideas) {
		const column = h(
			"section",
			{ class: `idea-col s-${status}`, dataset: { status } },
			h("header", { class: "idea-col-head" }, h("span", { class: "idea-dot" }), h("h2", null, statusLabel(status)), h("span", { class: "idea-count" }, String(ideas.length))),
			h("div", { class: "idea-list" }, ideas.length ? ideas.map(ideaCard) : h("p", { class: "idea-none" }, t("ideaNone"))),
		);
		column.addEventListener("dragover", (event) => {
			if (!event.dataTransfer.types.includes("text/x-idea")) return;
			event.preventDefault();
			column.classList.add("drop");
		});
		column.addEventListener("dragleave", (event) => {
			if (!column.contains(event.relatedTarget)) column.classList.remove("drop");
		});
		column.addEventListener("drop", (event) => {
			column.classList.remove("drop");
			const id = event.dataTransfer.getData("text/x-idea");
			const idea = state.ideas.get(id);
			if (!idea || idea.status === status) return;
			event.preventDefault();
			changeIdea(id, { status });
		});
		return column;
	}

	function renderBoard(resetComposer = false) {
		const root = $("#board");
		const saved = cardFocusKey();
		const ideas = [...state.ideas.values()].filter(matchesIdea).sort((a, b) => (a.updated < b.updated ? 1 : -1));
		const dropped = ideas.filter((idea) => idea.status === "dropped");
		const statuses = board.dropped ? IDEA_STATUSES : IDEA_COLUMNS;
		const composer = !resetComposer && $(".idea-composer", root);
		const parts = [
			composer && composer.contains(document.activeElement) ? composer : composerEl(),
			state.ideas.size || state.q ? null : markdown(t("emptyIdeas"), "md idea-hint"),
			h("div", { class: `idea-cols${board.dropped ? " with-dropped" : ""}` }, statuses.map((status) => columnEl(status, ideas.filter((idea) => idea.status === status)))),
			dropped.length || board.dropped
				? h(
						"div",
						{ class: "idea-foot" },
						h(
							"button",
							{
								type: "button",
								class: "btn ghost small",
								onclick: () => {
									board.dropped = !board.dropped;
									renderBoard();
								},
							},
							board.dropped ? t("ideaHideDropped") : t("ideaShowDropped", { n: dropped.length }),
						),
					)
				: null,
		];
		root.replaceChildren(...parts.filter(Boolean));
		restoreFocus(saved);
	}

	function renderIdeaTree() {
		$("#tree").replaceChildren(
			h("button", { type: "button", class: `node all${state.scope.project ? "" : " active"}`, dataset: { scope: "{}" } }, h("span", { class: "node-title" }, t("allProjects")), h("span", { class: "node-count" }, state.counts.ideas ? String(state.counts.ideas) : "")),
			...state.ideaProjects.map((entry) =>
				h(
					"button",
					{ type: "button", class: `node project-node${state.scope.project === entry.project ? " active" : ""}`, dataset: { scope: JSON.stringify({ project: entry.project }) } },
					h("span", { class: "node-title" }, entry.project),
					h("span", { class: "node-count" }, entry.open ? String(entry.open) : ""),
				),
			),
		);
	}

	async function revealIdea(id) {
		if (state.mode !== "ideas") {
			state.mode = "ideas";
			state.scope = {};
			await load();
		}
		if (!document.getElementById(id) && state.ideas.get(id)?.status === "dropped") {
			board.dropped = true;
			renderBoard();
		}
		const card = document.getElementById(id);
		if (!card) return;
		card.scrollIntoView({ block: "center", behavior: "smooth" });
		card.classList.add("flash");
		setTimeout(() => card.classList.remove("flash"), 1800);
	}

	// ── Hash links ──────────────────────────────────────────────────────────

	async function revealHash() {
		const id = decodeURIComponent(location.hash.slice(1));
		if (/^n_[a-z0-9]+$/i.test(id)) return revealIdea(id);
		if (!/^p_[a-z0-9]+$/i.test(id)) return;
		for (let page = 0; page < 15 && !document.getElementById(id); page++) {
			if (!state.hasMore) break;
			if (!(await loadMore())) break;
		}
		if (!document.getElementById(id) && !Object.keys(state.scope).length && !state.q) {
			// Maybe it lives on the other tab.
			const other = state.mode === "dailies" ? "devlog" : "dailies";
			const data = await api(`/api/state?mode=${other}&limit=200`).catch(() => null);
			if (data && data.posts.some((post) => post.id === id)) {
				state.mode = other;
				await load();
				for (let page = 0; page < 15 && !document.getElementById(id) && state.hasMore; page++) if (!(await loadMore())) break;
			}
		}
		const card = document.getElementById(id);
		if (!card) return;
		focusPost(id, { scroll: false });
		card.scrollIntoView({ block: "start", behavior: "smooth" });
		card.classList.add("flash");
		setTimeout(() => card.classList.remove("flash"), 1800);
	}

	// ── Live events ─────────────────────────────────────────────────────────

	let source = null;
	let retry = 1000;

	function connect() {
		if (source) source.close();
		source = new EventSource("/api/events");
		const on = (type, fn) =>
			source.addEventListener(type, (event) => {
				let data = null;
				try {
					data = JSON.parse(event.data);
				} catch {
					return;
				}
				try {
					fn(data);
				} catch (error) {
					console.error(error);
				}
			});
		source.onopen = () => {
			const wasOffline = !state.connected && state.everConnected;
			state.connected = true;
			state.everConnected = true;
			retry = 1000;
			renderChrome();
			if (wasOffline) load();
		};
		source.onerror = () => {
			state.connected = false;
			renderChrome();
			if (source.readyState === EventSource.CLOSED) {
				setTimeout(connect, retry);
				retry = Math.min(retry * 2, 15000);
			}
		};
		on("hello", (data) => {
			if (typeof data.viewers === "number") state.viewers = data.viewers;
			renderChrome();
		});
		on("viewers", (data) => {
			if (typeof data.viewers === "number") state.viewers = data.viewers;
			else if (typeof data.count === "number") state.viewers = data.count;
			renderChrome();
		});
		on("post", (post) => {
			receivePost(post);
			refreshTree();
		});
		on("comment", (comment) => addComment(comment));
		on("answer", (answer) => addAnswer(answer));
		on("verdict", (verdict) => {
			const post = state.posts.get(verdict.post);
			if (!post) return;
			const item = (post.items || []).find((candidate) => candidate.id === verdict.item);
			if (item) {
				item.verdict = verdict.verdict;
				replaceCard(post.id);
			}
		});
		on("issue", (issue) => {
			if (state.scope.issue && issue.key && issue.key.toUpperCase() === state.scope.issue.toUpperCase()) {
				state.issue = { ...(state.issue || {}), ...issue };
				renderIssue();
			}
			refreshTree();
		});
		on("amend", (data) => {
			if (!data.post) return;
			state.posts.set(data.post.id, data.post);
			if (document.getElementById(data.post.id)) replaceCard(data.post.id);
			refreshTree();
		});
		on("idea", (idea) => {
			state.ideas.set(idea.id, idea);
			if (state.mode === "ideas") renderBoard();
			refreshTree();
		});
		on("retract", (data) => {
			const post = data.post;
			if (!post) return;
			state.posts.set(post.id, post);
			if (post.retracted) removePost(post.id);
			else insertByTime(post);
			refreshTree();
		});
	}

	// ── Drawer (narrow screens) ─────────────────────────────────────────────

	function closeDrawer() {
		document.body.classList.remove("drawer-open");
	}

	// ── Wiring ──────────────────────────────────────────────────────────────

	function wire() {
		for (const el of $$("[data-i18n]")) el.textContent = t(el.dataset.i18n);
		for (const el of $$("[data-i18n-label]")) {
			el.setAttribute("aria-label", t(el.dataset.i18nLabel));
			el.title = t(el.dataset.i18nLabel);
		}
		$("#search").placeholder = t("search");

		for (const tab of $$(".tab")) {
			tab.addEventListener("click", () => {
				if (state.mode === tab.dataset.mode) return;
				state.mode = tab.dataset.mode;
				state.onlyOpen = false;
				state.scope = {};
				state.focused = null;
				load().then(() => window.scrollTo({ top: 0 }));
			});
		}
		$("#brand").addEventListener("click", (event) => {
			event.preventDefault();
			state.q = "";
			state.onlyOpen = false;
			history.replaceState(null, "", location.pathname + location.search);
			setScope({});
		});
		$("#scope-clear").addEventListener("click", () => {
			state.q = "";
			setScope({});
		});
		$("#waiting-btn").addEventListener("click", () => {
			state.onlyOpen = !state.onlyOpen;
			if (state.onlyOpen) {
				state.mode = "dailies";
				state.scope = {};
			}
			load().then(() => {
				window.scrollTo({ top: 0 });
				const first = cards()[0];
				if (first && state.onlyOpen) focusPost(first.dataset.id, { scroll: false });
			});
		});
		$("#tree").addEventListener("click", (event) => {
			const node = event.target.closest(".node");
			if (!node) return;
			const scope = JSON.parse(node.dataset.scope || "{}");
			if (sameScope(scope, state.scope) && Object.keys(scope).length) return closeDrawer();
			setScope(scope);
		});
		const search = $("#search");
		const runSearch = debounce(() => {
			const value = search.value.trim();
			if (value === state.q) return;
			state.q = value;
			load();
		}, 220);
		search.addEventListener("input", runSearch);
		search.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				search.value = "";
				runSearch();
				search.blur();
			} else if (event.key === "Enter") {
				search.blur();
				movePost(1);
			}
		});
		$("#more-btn").addEventListener("click", () => loadMore());
		$("#new-pill").addEventListener("click", showPending);
		$("#drawer-btn").addEventListener("click", () => document.body.classList.toggle("drawer-open"));
		$("#side-scrim").addEventListener("click", closeDrawer);
		$("#lb-close").addEventListener("click", closeLightbox);
		$("#lb-prev").addEventListener("click", () => {
			if (lightbox.index > 0) {
				lightbox.index--;
				renderLightbox();
			}
		});
		$("#lb-next").addEventListener("click", () => {
			if (lightbox.index < lightbox.items.length - 1) {
				lightbox.index++;
				renderLightbox();
			}
		});
		$("#lb-note").addEventListener("click", () => {
			lightbox.noting = true;
			renderLightbox();
		});
		$("#lightbox").addEventListener("click", (event) => {
			if (event.target.id === "lb-stage" || event.target.classList.contains("lb-media")) closeLightbox();
		});
		document.addEventListener("keydown", onKey);
		window.addEventListener("hashchange", revealHash);
		window.addEventListener("scroll", () => {
			if (nearTop() && state.pending.length) showPending();
		}, { passive: true });
		// Relative times stay fresh.
		setInterval(() => {
			for (const el of $$("time.when")) el.textContent = relativeTime(el.getAttribute("datetime"));
		}, 60_000);
		renderKeys();
	}

	async function start() {
		readUrl();
		wire();
		renderChrome();
		await load();
		connect();
		if (location.hash) revealHash();
	}

	start();
})();
