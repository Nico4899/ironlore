import type { PageType } from "@ironlore/core";
import { create } from "zustand";

interface EditorStore {
  filePath: string | null;
  fileType: PageType | null;
  markdown: string;
  etag: string | null;
  status: "clean" | "dirty" | "syncing" | "conflict";
  mode: "wysiwyg" | "source";
  selection: { from: number; to: number } | null;
  /** Epoch-ms of the last successful save. Drives the status-bar
   *  "Saved <N>s ago" indicator. Null until the first save in a session. */
  lastSavedAt: number | null;

  setFile: (path: string, content: string, etag: string, fileType: PageType) => void;
  setMarkdown: (markdown: string) => void;
  setStatus: (status: EditorStore["status"]) => void;
  setMode: (mode: EditorStore["mode"]) => void;
  setSelection: (selection: EditorStore["selection"]) => void;
  setEtag: (etag: string) => void;
}

export const useEditorStore = create<EditorStore>((set) => ({
  filePath: null,
  fileType: null,
  markdown: "",
  etag: null,
  status: "clean",
  mode: "wysiwyg",
  selection: null,
  lastSavedAt: null,

  setFile: (path, content, etag, fileType) =>
    set({ filePath: path, markdown: content, etag, fileType, status: "clean" }),
  setMarkdown: (markdown) => set({ markdown, status: "dirty" }),
  setStatus: (status) =>
    set((s) => ({
      status,
      lastSavedAt: status === "clean" && s.status !== "clean" ? Date.now() : s.lastSavedAt,
    })),
  setMode: (mode) => set({ mode }),
  setSelection: (selection) => set({ selection }),
  setEtag: (etag) => set({ etag }),
}));
