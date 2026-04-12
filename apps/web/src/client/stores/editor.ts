import { create } from "zustand";

interface EditorStore {
  filePath: string | null;
  markdown: string;
  etag: string | null;
  status: "clean" | "dirty" | "syncing" | "conflict";
  mode: "wysiwyg" | "source";
  selection: { from: number; to: number } | null;

  setFile: (path: string, markdown: string, etag: string) => void;
  setMarkdown: (markdown: string) => void;
  setStatus: (status: EditorStore["status"]) => void;
  setMode: (mode: EditorStore["mode"]) => void;
  setSelection: (selection: EditorStore["selection"]) => void;
  setEtag: (etag: string) => void;
}

export const useEditorStore = create<EditorStore>((set) => ({
  filePath: null,
  markdown: "",
  etag: null,
  status: "clean",
  mode: "wysiwyg",
  selection: null,

  setFile: (path, markdown, etag) =>
    set({ filePath: path, markdown, etag, status: "clean" }),
  setMarkdown: (markdown) => set({ markdown, status: "dirty" }),
  setStatus: (status) => set({ status }),
  setMode: (mode) => set({ mode }),
  setSelection: (selection) => set({ selection }),
  setEtag: (etag) => set({ etag }),
}));
