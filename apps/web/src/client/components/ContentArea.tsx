import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useAutoSave } from "../hooks/useAutoSave.js";
import type { ConflictResponse } from "../lib/api.js";
import { fetchPage, fetchRaw } from "../lib/api.js";
import { useAppStore } from "../stores/app.js";
import { useEditorStore } from "../stores/editor.js";
import { useTreeStore } from "../stores/tree.js";
import { ConflictBanner } from "./editor/ConflictBanner.js";
import { TabBar } from "./TabBar.js";
import { MarkdownEditor } from "./editor/MarkdownEditor.js";
import { MarkdownPreview } from "./editor/MarkdownPreview.js";
import { SourceEditor } from "./editor/SourceEditor.js";
import { CsvViewer } from "./viewers/CsvViewer.js";
import { ImageViewer } from "./viewers/ImageViewer.js";
import { MediaViewer } from "./viewers/MediaViewer.js";
import { SourceCodeViewer } from "./viewers/SourceCodeViewer.js";
import { TranscriptViewer } from "./viewers/TranscriptViewer.js";

// Lazy-load heavy viewers
const PdfViewer = lazy(() =>
  import("./viewers/PdfViewer.js").then((m) => ({ default: m.PdfViewer })),
);
const MermaidViewer = lazy(() =>
  import("./viewers/MermaidViewer.js").then((m) => ({ default: m.MermaidViewer })),
);
const DocxViewer = lazy(() =>
  import("./viewers/DocxViewer.js").then((m) => ({ default: m.DocxViewer })),
);
const XlsxViewer = lazy(() =>
  import("./viewers/XlsxViewer.js").then((m) => ({ default: m.XlsxViewer })),
);
const EmailViewer = lazy(() =>
  import("./viewers/EmailViewer.js").then((m) => ({ default: m.EmailViewer })),
);

/**
 * File types that are loaded as binary via URL, not as text content.
 * Word/Excel containers live here too — their viewers fetch the buffer
 * themselves and delegate to the shared extractor.
 */
const BINARY_TYPES = new Set(["pdf", "image", "video", "audio", "word", "excel", "email"]);

/**
 * File types that use fetchRaw (text, but not markdown's JSON endpoint).
 * Plain text and transcripts are parsed in the viewer from the cached
 * text buffer; .eml lives in BINARY_TYPES because the extractor needs
 * the raw bytes (and the viewer would otherwise fetch twice).
 */
const RAW_TEXT_TYPES = new Set(["source-code", "csv", "mermaid", "text", "transcript"]);

export function ContentArea() {
  const activePath = useAppStore((s) => s.activePath);
  const filePath = useEditorStore((s) => s.filePath);
  const fileType = useEditorStore((s) => s.fileType);
  const markdown = useEditorStore((s) => s.markdown);
  const mode = useEditorStore((s) => s.mode);
  const status = useEditorStore((s) => s.status);

  const [conflict, setConflict] = useState<ConflictResponse | null>(null);

  // Auto-save hook — fires on "dirty" status with 500ms debounce
  useAutoSave(useCallback((c: ConflictResponse) => setConflict(c), []));

  // Load page when activePath changes
  useEffect(() => {
    if (!activePath) return;

    // Determine the file type from the tree store
    const nodes = useTreeStore.getState().nodes;
    const node = nodes.find((n) => n.path === activePath);
    const type = node?.type === "directory" ? "markdown" : (node?.type ?? "markdown");

    let cancelled = false;

    if (BINARY_TYPES.has(type)) {
      // Binary types don't need content fetching — viewer loads from URL
      useEditorStore.getState().setFile(activePath, "", "", type);
      setConflict(null);
    } else if (RAW_TEXT_TYPES.has(type)) {
      // Text-based non-markdown types use raw endpoint
      fetchRaw(activePath)
        .then(async (res) => {
          if (cancelled) return;
          const text = await res.text();
          const etag = res.headers.get("ETag") ?? "";
          useEditorStore.getState().setFile(activePath, text, etag, type);
          setConflict(null);
        })
        .catch(() => {
          // Not found or network error
        });
    } else {
      // Markdown uses the structured JSON endpoint
      fetchPage(activePath)
        .then((page) => {
          if (cancelled) return;
          useEditorStore.getState().setFile(activePath, page.content, page.etag, "markdown");
          setConflict(null);
        })
        .catch(() => {
          // Page not found or network error — keep welcome screen
        });
    }

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
        <TabBar />
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
      <TabBar />

      {/* Conflict banner (markdown + CSV) */}
      {conflict && <ConflictBanner conflict={conflict} onResolved={handleConflictResolved} />}

      {/* Viewer dispatch */}
      {fileType === "markdown" ? (
        <MarkdownContent
          markdown={markdown}
          mode={mode}
          status={status}
          onChange={handleChange}
          onSelectionChange={handleSelectionChange}
        />
      ) : fileType === "image" ? (
        <ImageViewer path={filePath} />
      ) : fileType === "video" || fileType === "audio" ? (
        <MediaViewer path={filePath} fileType={fileType} />
      ) : fileType === "source-code" || fileType === "text" ? (
        <SourceCodeViewer content={markdown} path={filePath} />
      ) : fileType === "transcript" ? (
        <TranscriptViewer content={markdown} />
      ) : fileType === "csv" ? (
        <CsvViewer content={markdown} onChange={handleChange} />
      ) : fileType === "pdf" ? (
        <Suspense fallback={<ViewerLoading />}>
          <PdfViewer path={filePath} />
        </Suspense>
      ) : fileType === "mermaid" ? (
        <Suspense fallback={<ViewerLoading />}>
          <MermaidViewer content={markdown} />
        </Suspense>
      ) : fileType === "word" ? (
        <Suspense fallback={<ViewerLoading />}>
          <DocxViewer path={filePath} />
        </Suspense>
      ) : fileType === "excel" ? (
        <Suspense fallback={<ViewerLoading />}>
          <XlsxViewer path={filePath} />
        </Suspense>
      ) : fileType === "email" ? (
        <Suspense fallback={<ViewerLoading />}>
          <EmailViewer path={filePath} />
        </Suspense>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-secondary">Unsupported file type</p>
        </div>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ViewerLoading() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <p className="text-sm text-secondary">Loading viewer...</p>
    </div>
  );
}

interface MarkdownContentProps {
  markdown: string;
  mode: "wysiwyg" | "source";
  status: "clean" | "dirty" | "syncing" | "conflict";
  onChange: (markdown: string) => void;
  onSelectionChange: (selection: { from: number; to: number } | null) => void;
}

function MarkdownContent({
  markdown,
  mode,
  status,
  onChange,
  onSelectionChange,
}: MarkdownContentProps) {
  return (
    <>
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

      {/* Editor */}
      {mode === "wysiwyg" ? (
        <MarkdownEditor
          markdown={markdown}
          onChange={onChange}
          onSelectionChange={onSelectionChange}
        />
      ) : (
        <div className="flex flex-1 overflow-hidden">
          <SourceEditor markdown={markdown} onChange={onChange} />
          <div className="border-l border-border" style={{ flex: "0 0 50%" }}>
            <MarkdownPreview markdown={markdown} />
          </div>
        </div>
      )}
    </>
  );
}
