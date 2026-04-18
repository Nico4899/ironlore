import { Upload } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useAutoSave } from "../hooks/useAutoSave.js";
import type { ConflictResponse } from "../lib/api.js";
import { fetchPage, fetchRaw, submitOnboarding, uploadFile } from "../lib/api.js";
import { useAppStore } from "../stores/app.js";
import { useEditorStore } from "../stores/editor.js";
import { useTreeStore } from "../stores/tree.js";
import { ConflictBanner } from "./editor/ConflictBanner.js";
import { HighlightToolbar } from "./editor/HighlightToolbar.js";
import { MarkdownEditor } from "./editor/MarkdownEditor.js";
import { MarkdownPreview } from "./editor/MarkdownPreview.js";
import { SourceEditor } from "./editor/SourceEditor.js";
import { HomePanel } from "./HomePanel.js";
import { OnboardingWizard } from "./OnboardingWizard.js";
import { SplitPane } from "./SplitPane.js";
import { TabBar } from "./TabBar.js";
import { ViewerErrorBoundary } from "./ViewerErrorBoundary.js";
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
const NotebookViewer = lazy(() =>
  import("./viewers/NotebookViewer.js").then((m) => ({ default: m.NotebookViewer })),
);

/**
 * File types that are loaded as binary via URL, not as text content.
 * Word/Excel containers live here too — their viewers fetch the buffer
 * themselves and delegate to the shared extractor.
 */
const BINARY_TYPES = new Set([
  "pdf",
  "image",
  "video",
  "audio",
  "word",
  "excel",
  "email",
  "notebook",
]);

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

  // ─── File upload via drag-and-drop ────────────────────────────────
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    // Only show overlay for external file drops, not internal sidebar drags
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragCounter.current++;
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      setDragOver(false);

      const files = e.dataTransfer.files;
      if (!files.length) return;

      // Determine the target directory from the current active path
      const nodes = useTreeStore.getState().nodes;
      const activeNode = nodes.find((n) => n.path === activePath);
      let targetDir = "";
      if (activeNode) {
        targetDir =
          activeNode.type === "directory"
            ? activeNode.path
            : activeNode.path.includes("/")
              ? activeNode.path.slice(0, activeNode.path.lastIndexOf("/"))
              : "";
      }

      for (const file of files) {
        const destPath = targetDir ? `${targetDir}/${file.name}` : file.name;
        const buf = await file.arrayBuffer();
        try {
          await uploadFile(destPath, buf);
        } catch {
          // Upload errors are non-fatal; file watcher will pick up
          // any that landed on disk via other means.
        }
      }
    },
    [activePath],
  );

  const dropZoneProps = {
    onDragEnter: handleDragEnter,
    onDragLeave: handleDragLeave,
    onDragOver: handleDragOver,
    onDrop: handleDrop,
  };

  // Onboarding state — show wizard on first visit
  const [onboarded, setOnboarded] = useState(() => {
    try {
      return localStorage.getItem("ironlore.onboarded") === "1";
    } catch {
      return false;
    }
  });

  const handleOnboardingComplete = useCallback(
    async (answers: { role: string; company: string; goals: string }) => {
      try {
        await submitOnboarding({
          company_name: answers.company,
          company_description: answers.company,
          goals: answers.goals,
        });
      } catch {
        // Non-fatal — substitution is best-effort
      }
      try {
        localStorage.setItem("ironlore.onboarded", "1");
      } catch {
        /* storage denied */
      }
      setOnboarded(true);
    },
    [],
  );

  const handleOnboardingSkip = useCallback(() => {
    try {
      localStorage.setItem("ironlore.onboarded", "1");
    } catch {
      /* storage denied */
    }
    setOnboarded(true);
  }, []);

  const sidebarTab = useAppStore((s) => s.sidebarTab);

  // No active file — show Home/Explore view or welcome screen
  if (!activePath || !filePath) {
    return (
      <main
        id="main-content"
        aria-label="Workspace"
        className="relative flex flex-1 flex-col overflow-hidden"
        style={{ minWidth: "480px" }}
        {...dropZoneProps}
      >
        <TabBar />
        {!onboarded ? (
          <OnboardingWizard onComplete={handleOnboardingComplete} onSkip={handleOnboardingSkip} />
        ) : sidebarTab === "explore" ? (
          <div className="flex flex-1 items-center justify-center px-8">
            <div className="max-w-md text-center">
              <h1 className="text-xl font-semibold text-primary">Explore</h1>
              <p className="mt-2 text-sm text-secondary">
                Visualize connections between your pages. Coming soon.
              </p>
            </div>
          </div>
        ) : (
          <HomePanel />
        )}
        {dragOver && <DropOverlay />}
      </main>
    );
  }

  return (
    <main
      id="main-content"
      className="relative flex flex-1 flex-col overflow-hidden"
      style={{ minWidth: "480px" }}
      {...dropZoneProps}
    >
      <TabBar />

      {/* Breadcrumb path */}
      {filePath && (
        <div className="flex items-center gap-1 border-b border-border px-4 py-1 text-xs text-secondary">
          {filePath.split("/").map((seg, i, arr) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: breadcrumb segments are path-derived
            <span key={`${seg}-${i}`} className="flex items-center gap-1">
              {i > 0 && <span className="text-border">/</span>}
              {i < arr.length - 1 ? (
                <button
                  type="button"
                  className="hover:text-primary"
                  onClick={() => {
                    const folderPath = arr.slice(0, i + 1).join("/");
                    useAppStore.getState().setSidebarFolder(folderPath);
                  }}
                >
                  {seg}
                </button>
              ) : (
                <span className="font-medium text-primary">{seg}</span>
              )}
            </span>
          ))}
        </div>
      )}

      {/* Conflict banner (markdown + CSV) */}
      {conflict && <ConflictBanner conflict={conflict} onResolved={handleConflictResolved} />}

      {/* Floating selection toolbar (rendered only when text is selected
           inside the ProseMirror editor; a no-op for other viewers). */}
      <HighlightToolbar />

      {/*
       * SR-only page heading. The markdown editor surfaces the title
       * inside its own `<h1>` in the document body; every other viewer
       * has no semantic page title, which made screen-reader navigation
       * land on the toolbar with no context. Adding one here keeps the
       * heading hierarchy clean (Phase 2.5 audit Step 6) without
       * touching every viewer's render path.
       */}
      {fileType !== "markdown" && filePath && (
        <h1 className="sr-only">{filePath.split("/").pop()}</h1>
      )}

      {/* Viewer dispatch */}
      <ViewerErrorBoundary path={filePath}>
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
          <TranscriptViewer content={markdown} path={filePath} />
        ) : fileType === "csv" ? (
          <CsvViewer content={markdown} onChange={handleChange} path={filePath} />
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
        ) : fileType === "notebook" ? (
          <Suspense fallback={<ViewerLoading />}>
            <NotebookViewer path={filePath} />
          </Suspense>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-secondary">
              Unsupported file type{fileType ? `: ${fileType}` : ""}
            </p>
          </div>
        )}
      </ViewerErrorBoundary>
      {dragOver && <DropOverlay />}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DropOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-ironlore-slate/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-ironlore-blue px-10 py-8">
        <Upload className="h-8 w-8 text-ironlore-blue" />
        <span className="text-sm font-medium text-primary">Drop files to upload</span>
        <span className="text-xs text-secondary">
          PDF, images, Word, Excel, email, notebooks, and more
        </span>
      </div>
    </div>
  );
}

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
        <span className="text-xs text-secondary" role="status" aria-live="polite">
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
        <SplitPane
          storageKey="ironlore.sourcePreviewRatio"
          handleLabel="Resize source and preview"
          left={<SourceEditor markdown={markdown} onChange={onChange} />}
          right={<MarkdownPreview markdown={markdown} />}
        />
      )}
    </>
  );
}
