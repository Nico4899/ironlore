import type { PageType } from "@ironlore/core";
import { create } from "zustand";

/**
 * Regex matching the leading YAML frontmatter block of a page.
 * Captures the entire block (including the opening/closing `---`
 * fences and the trailing newline) so we can splice it back in
 * verbatim at save time. Frontmatter must start on the first line.
 */
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/**
 * Split a page's raw markdown into `{ frontmatter, body }`. The
 * frontmatter string preserves the full `---\n…\n---\n` block
 * (including the final newline) so joining is a pure
 * concatenation: `frontmatter + body`. When there's no frontmatter,
 * `frontmatter` is the empty string and `body === raw`.
 *
 * This is client-side-only splitting — the on-disk page, the
 * server's StorageWriter, and every agent tool all see the full
 * markdown. The split exists so the WYSIWYG editor can render the
 * body without leaking the YAML block into the user's visible
 * surface while still round-tripping the metadata untouched.
 */
export function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return { frontmatter: "", body: raw };
  return { frontmatter: match[0], body: raw.slice(match[0].length) };
}

interface EditorStore {
  filePath: string | null;
  fileType: PageType | null;
  /**
   * The **body** of the current page — frontmatter stripped. The
   * editor renders this; the auto-save path reassembles with
   * `frontmatter` before sending to the server.
   */
  markdown: string;
  /**
   * Raw `---\n…\n---\n` YAML block split from the loaded page, or
   * the empty string when the page had none. Preserved verbatim so
   * a round-trip is lossless.
   */
  frontmatter: string;
  etag: string | null;
  status: "clean" | "dirty" | "syncing" | "conflict";
  mode: "wysiwyg" | "source";
  selection: { from: number; to: number } | null;
  /**
   * Block IDs covered by the current ProseMirror selection. Empty
   * when the selection is empty or covers no block-IDed nodes. Read
   * by the AI panel composer so a non-empty editor selection becomes
   * `kb.read_block` context on the next agent prompt — implements
   * [docs/03-editor.md §Selection as AI context](../../../../docs/03-editor.md).
   */
  selectedBlockIds: string[];
  /** Epoch-ms of the last successful save. Drives the status-bar
   *  "Saved <N>s ago" indicator. Null until the first save in a session. */
  lastSavedAt: number | null;

  setFile: (path: string, content: string, etag: string, fileType: PageType) => void;
  setMarkdown: (markdown: string) => void;
  setStatus: (status: EditorStore["status"]) => void;
  setMode: (mode: EditorStore["mode"]) => void;
  setSelection: (selection: EditorStore["selection"]) => void;
  setSelectedBlockIds: (ids: string[]) => void;
  setEtag: (etag: string) => void;
  /**
   * Return the on-disk representation — frontmatter re-prepended to
   * the body. Callers (auto-save, conflict-resolver) use this so
   * the server receives the full page and the YAML block never
   * disappears from disk.
   */
  getFullContent: () => string;
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  filePath: null,
  fileType: null,
  markdown: "",
  frontmatter: "",
  etag: null,
  status: "clean",
  mode: "wysiwyg",
  selection: null,
  selectedBlockIds: [],
  lastSavedAt: null,

  setFile: (path, content, etag, fileType) => {
    // Split frontmatter only for markdown pages — CSV, PDFs, and
    //  every other viewer renders `content` as-is. Markdown is the
    //  only editable surface where a leading YAML block would leak
    //  into the user's view.
    if (fileType === "markdown") {
      const { frontmatter, body } = splitFrontmatter(content);
      set({ filePath: path, markdown: body, frontmatter, etag, fileType, status: "clean" });
    } else {
      set({ filePath: path, markdown: content, frontmatter: "", etag, fileType, status: "clean" });
    }
  },
  setMarkdown: (markdown) => set({ markdown, status: "dirty" }),
  setStatus: (status) =>
    set((s) => ({
      status,
      lastSavedAt: status === "clean" && s.status !== "clean" ? Date.now() : s.lastSavedAt,
    })),
  setMode: (mode) => set({ mode }),
  setSelection: (selection) => set({ selection }),
  setSelectedBlockIds: (selectedBlockIds) => set({ selectedBlockIds }),
  setEtag: (etag) => set({ etag }),
  getFullContent: () => {
    const { frontmatter, markdown } = get();
    return frontmatter + markdown;
  },
}));
