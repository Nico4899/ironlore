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

/**
 * Pending in-editor edit proposed by an interactive Editor-agent run
 * — the on-screen counterpart of a `diff_preview` event whose `pageId`
 * matches the currently open file. The ProseMirror inline-diff plugin
 * reads this list out of the store and renders ghost decorations
 * keyed to `blockId`. Tab → accept (calls `onAccept` which fires the
 * existing `submitDryRunVerdict` round-trip); ⌘⇧Backspace → reject.
 *
 * Per [docs/03-editor.md §Pending-edit decorations](../../../../docs/03-editor.md):
 * autonomous runs (`review_mode: inbox`) keep using the staging-branch
 * + Inbox path — they never produce `PendingEdit`s.
 */
export interface PendingEdit {
  /** Tool-call ID the server's DryRunBridge is parked on. Identifier
   *  for both accept and reject. */
  toolCallId: string;
  /** Operation kind: `replace` strikes the old block + ghosts the new
   *  text; `insert` ghosts the new text after the anchor; `delete`
   *  strikes the old block. */
  op: "replace" | "insert" | "delete";
  /** Target block ID — anchor for the inline plugin's decoration
   *  search. Matched against the editor's existing block-id ledger. */
  blockId: string;
  /** Source page (always `=== filePath` for edits in this list — a
   *  cross-page edit takes the `DiffPreview` card path). */
  pageId: string;
  /** Existing block markdown for replace/delete — what the ghost
   *  decoration strikes through. Undefined for insertions. */
  currentMd?: string;
  /** Proposed markdown for replace/insert — rendered as ghost text.
   *  Undefined for deletions. */
  proposedMd?: string;
  /** Slug of the agent that proposed the edit. Surfaces in the
   *  decoration's hover tooltip ("Editor wants to…"). */
  agentSlug?: string;
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
  /**
   * Edits the interactive Editor agent has proposed against the
   * currently open page. Cleared automatically when the file
   * switches; mutated through `pushPendingEdit` / `removePendingEdit`
   * by `useAgentSession`. Read by the inline-diff ProseMirror plugin
   * via metadata transactions — the plugin doesn't subscribe to the
   * store directly because ProseMirror state lives outside React.
   */
  pendingEdits: PendingEdit[];

  setFile: (path: string, content: string, etag: string, fileType: PageType) => void;
  setMarkdown: (markdown: string) => void;
  setStatus: (status: EditorStore["status"]) => void;
  setMode: (mode: EditorStore["mode"]) => void;
  setSelection: (selection: EditorStore["selection"]) => void;
  setSelectedBlockIds: (ids: string[]) => void;
  setEtag: (etag: string) => void;
  pushPendingEdit: (edit: PendingEdit) => void;
  /** Drop the edit with this `toolCallId`. No-op if absent. Called
   *  on accept (after the server round-trip fires) and on reject. */
  removePendingEdit: (toolCallId: string) => void;
  /** Wipe the entire list — invoked on file-switch so a stale edit
   *  from a previous page can never render against the new doc. */
  clearPendingEdits: () => void;
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
  pendingEdits: [],

  setFile: (path, content, etag, fileType) => {
    // Split frontmatter only for markdown pages — CSV, PDFs, and
    //  every other viewer renders `content` as-is. Markdown is the
    //  only editable surface where a leading YAML block would leak
    //  into the user's view.
    if (fileType === "markdown") {
      const { frontmatter, body } = splitFrontmatter(content);
      set({
        filePath: path,
        markdown: body,
        frontmatter,
        etag,
        fileType,
        status: "clean",
        selectedBlockIds: [],
        // File-switch wipes pending edits — a stale edit from a
        //  previous page must never render decorations on the new doc.
        pendingEdits: [],
      });
    } else {
      set({
        filePath: path,
        markdown: content,
        frontmatter: "",
        etag,
        fileType,
        status: "clean",
        selectedBlockIds: [],
        pendingEdits: [],
      });
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
  pushPendingEdit: (edit) =>
    set((s) => {
      // De-dupe by toolCallId — defends against a duplicate
      //  diff_preview event firing twice for the same call.
      if (s.pendingEdits.some((e) => e.toolCallId === edit.toolCallId)) return s;
      return { pendingEdits: [...s.pendingEdits, edit] };
    }),
  removePendingEdit: (toolCallId) =>
    set((s) => ({ pendingEdits: s.pendingEdits.filter((e) => e.toolCallId !== toolCallId) })),
  clearPendingEdits: () => set({ pendingEdits: [] }),
  getFullContent: () => {
    const { frontmatter, markdown } = get();
    return frontmatter + markdown;
  },
}));
