import { extname } from "node:path";

export type Kind = "image" | "video" | "audio" | "model" | "pdf" | "html" | "markdown" | "text" | "other";

const TYPES: Record<string, [string, Kind]> = {
	".png": ["image/png", "image"],
	".jpg": ["image/jpeg", "image"],
	".jpeg": ["image/jpeg", "image"],
	".gif": ["image/gif", "image"],
	".webp": ["image/webp", "image"],
	".avif": ["image/avif", "image"],
	".bmp": ["image/bmp", "image"],
	".svg": ["image/svg+xml", "image"],
	".ico": ["image/x-icon", "image"],
	".mp4": ["video/mp4", "video"],
	".m4v": ["video/mp4", "video"],
	".webm": ["video/webm", "video"],
	".mov": ["video/quicktime", "video"],
	".mkv": ["video/x-matroska", "video"],
	".ogv": ["video/ogg", "video"],
	".avi": ["video/x-msvideo", "video"],
	".wmv": ["video/x-ms-wmv", "video"],
	".flv": ["video/x-flv", "video"],
	".mpg": ["video/mpeg", "video"],
	".mpeg": ["video/mpeg", "video"],
	".3gp": ["video/3gpp", "video"],
	".mp3": ["audio/mpeg", "audio"],
	".wav": ["audio/wav", "audio"],
	".ogg": ["audio/ogg", "audio"],
	".oga": ["audio/ogg", "audio"],
	".opus": ["audio/opus", "audio"],
	".flac": ["audio/flac", "audio"],
	".m4a": ["audio/mp4", "audio"],
	".aac": ["audio/aac", "audio"],
	".glb": ["model/gltf-binary", "model"],
	".gltf": ["model/gltf+json", "model"],
	".pdf": ["application/pdf", "pdf"],
	".html": ["text/html; charset=utf-8", "html"],
	".htm": ["text/html; charset=utf-8", "html"],
	".md": ["text/markdown; charset=utf-8", "markdown"],
	".markdown": ["text/markdown; charset=utf-8", "markdown"],
	".txt": ["text/plain; charset=utf-8", "text"],
	".log": ["text/plain; charset=utf-8", "text"],
	".json": ["application/json; charset=utf-8", "text"],
	".jsonl": ["text/plain; charset=utf-8", "text"],
	".csv": ["text/csv; charset=utf-8", "text"],
	".tsv": ["text/tab-separated-values; charset=utf-8", "text"],
	".xml": ["text/xml; charset=utf-8", "text"],
	".yaml": ["text/plain; charset=utf-8", "text"],
	".yml": ["text/plain; charset=utf-8", "text"],
	".toml": ["text/plain; charset=utf-8", "text"],
	".diff": ["text/plain; charset=utf-8", "text"],
	".patch": ["text/plain; charset=utf-8", "text"],
};

/** Extensions shown as text even though no mime type above names them (source code). */
const TEXTUAL = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".py", ".rs", ".go", ".rb", ".sh", ".css", ".c", ".h", ".cpp", ".hpp", ".java", ".kt", ".swift", ".lua", ".gd", ".cs", ".shader", ".glsl", ".wgsl", ".ini", ".cfg", ".sql"]);

/** Video containers or codecs browsers no longer play; ffmpeg turns them into WebM once. */
const TRANSCODE = new Set([".ogv", ".avi", ".wmv", ".flv", ".mpg", ".mpeg", ".3gp"]);

export function extOf(name: string): string {
	return extname(name).toLowerCase();
}

export function describe(name: string): { ext: string; mime: string; kind: Kind } {
	const ext = extOf(name);
	const known = TYPES[ext];
	if (known) return { ext, mime: known[0], kind: known[1] };
	if (TEXTUAL.has(ext)) return { ext, mime: "text/plain; charset=utf-8", kind: "text" };
	return { ext, mime: "application/octet-stream", kind: "other" };
}

export function needsTranscode(item: { ext: string; kind: string }): boolean {
	return item.kind === "video" && TRANSCODE.has(item.ext);
}

export function mimeOfExt(ext: string): string {
	return describe(`x${ext}`).mime;
}
