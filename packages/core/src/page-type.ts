import type { PageType } from "./types.js";

/** Browser-safe extname — returns ".foo" or "" just like node:path.extname. */
function extname(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  if (dot <= 0 || dot === filePath.length - 1) return "";
  // Ignore dots that are part of a directory separator
  const slash = filePath.lastIndexOf("/");
  if (slash > dot) return "";
  return filePath.slice(dot);
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".ogg"]);
const CODE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".rb",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".lua",
  ".r",
  ".sql",
  ".yaml",
  ".yml",
  ".toml",
  ".json",
  ".xml",
  ".html",
  ".css",
  ".scss",
]);
const MERMAID_EXTS = new Set([".mermaid", ".mmd"]);

/**
 * Detect the page type from a file path or directory structure.
 * Single dispatch point — no scattered `if (endsWith...)` checks.
 */
export function detectPageType(filePath: string, isDirectory = false): PageType {
  if (isDirectory) {
    // Directory with index.md → markdown page
    // Directory with index.html + .app marker → fullscreen app
    // Directory with index.html (no index.md) → embedded app
    return "markdown"; // default for directories; refined at runtime
  }

  const ext = extname(filePath).toLowerCase();

  if (ext === ".md") return "markdown";
  if (ext === ".pdf") return "pdf";
  if (ext === ".csv") return "csv";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (CODE_EXTS.has(ext)) return "source-code";
  if (MERMAID_EXTS.has(ext)) return "mermaid";

  return "markdown"; // fallback
}
