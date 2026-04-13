import { useCallback, useEffect, useState } from "react";
import { useAutoSave } from "../hooks/useAutoSave.js";
import type { ConflictResponse } from "../lib/api.js";
import { fetchPage } from "../lib/api.js";
import { useAppStore } from "../stores/app.js";
import { useEditorStore } from "../stores/editor.js";
import { ConflictBanner } from "./editor/ConflictBanner.js";
import { MarkdownEditor } from "./editor/MarkdownEditor.js";
import { SourceEditor } from "./editor/SourceEditor.js";

export function ContentArea() {
  const activePath = useAppStore((s) => s.activePath);
  const filePath = useEditorStore((s) => s.filePath);
  const markdown = useEditorStore((s) => s.markdown);
  const mode = useEditorStore((s) => s.mode);
  const status = useEditorStore((s) => s.status);

  const [conflict, setConflict] = useState<ConflictResponse | null>(null);

  // Auto-save hook — fires on "dirty" status with 500ms debounce
  useAutoSave(useCallback((c: ConflictResponse) => setConflict(c), []));

  // Load page when activePath changes
  useEffect(() => {
    if (!activePath) return;

    let cancelled = false;

    fetchPage(activePath)
      .then((page) => {
        if (cancelled) return;
        useEditorStore.getState().setFile(activePath, page.content, page.etag);
        setConflict(null);
      })
      .catch(() => {
        // Page not found or network error — keep welcome screen
      });

    return () => {
      cancelled = true;
    };
  }, [activePath]);

  const handleChange = useCallback((newMarkdown: string) => {
    useEditorStore.getState().setMarkdown(newMarkdown);
  }, []);

  const handleSelectionChange = useCallback((selection: { from: number; to: number } | null) => {
    useEditorStore.getState().setSelection(selection);
  }, []);

  const handleConflictResolved = useCallback(() => {
    setConflict(null);
  }, []);

  // No active file — welcome screen
  if (!activePath || !filePath) {
    return (
      <main
        id="main-content"
        className="flex flex-1 flex-col overflow-hidden"
        style={{ minWidth: "480px" }}
      >
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <h1 className="text-2xl font-semibold">Welcome to Ironlore</h1>
            <p className="mt-2 text-sm text-secondary">
              Select a page from the sidebar or create a new one.
            </p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main
      id="main-content"
      className="flex flex-1 flex-col overflow-hidden"
      style={{ minWidth: "480px" }}
    >
      {/* Toolbar: mode toggle */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-1.5">
        <div className="flex rounded border border-border text-xs">
          <button
            type="button"
            className={`px-3 py-1 ${mode === "wysiwyg" ? "bg-ironlore-slate-hover font-medium" : "hover:bg-ironlore-slate-hover"}`}
            onClick={() => useEditorStore.getState().setMode("wysiwyg")}
            aria-pressed={mode === "wysiwyg"}
          >
            Edit
          </button>
          <button
            type="button"
            className={`border-l border-border px-3 py-1 ${mode === "source" ? "bg-ironlore-slate-hover font-medium" : "hover:bg-ironlore-slate-hover"}`}
            onClick={() => useEditorStore.getState().setMode("source")}
            aria-pressed={mode === "source"}
          >
            Source
          </button>
        </div>
        <div className="flex-1" />
        <span className="text-xs text-secondary">
          {status === "dirty"
            ? "Unsaved"
            : status === "syncing"
              ? "Saving..."
              : status === "conflict"
                ? "Conflict"
                : ""}
        </span>
      </div>

      {/* Conflict banner */}
      {conflict && <ConflictBanner conflict={conflict} onResolved={handleConflictResolved} />}

      {/* Editor */}
      {mode === "wysiwyg" ? (
        <MarkdownEditor
          markdown={markdown}
          onChange={handleChange}
          onSelectionChange={handleSelectionChange}
        />
      ) : (
        <SourceEditor markdown={markdown} onChange={handleChange} />
      )}
    </main>
  );
}
