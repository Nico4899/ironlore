import { ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchRawUrl } from "../../lib/api.js";

interface PdfViewerProps {
  path: string;
}

export function PdfViewer({ path }: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1.5);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pdfDocRef = useRef<unknown>(null);

  const zoomIn = useCallback(() => setScale((s) => Math.min(s * 1.25, 4)), []);
  const zoomOut = useCallback(() => setScale((s) => Math.max(s / 1.25, 0.5)), []);

  // Load PDF document
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only; path changes handled by parent remounting
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const pdfjsLib = await import("pdfjs-dist");
        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).href;

        const url = fetchRawUrl(path);
        const loadingTask = pdfjsLib.getDocument(url);
        const pdf = await loadingTask.promise;

        if (cancelled) return;

        pdfDocRef.current = pdf;
        setNumPages(pdf.numPages);
        setLoading(false);
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load PDF");
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Render pages when scale or document changes
  useEffect(() => {
    const pdf = pdfDocRef.current as
      | { numPages: number; getPage: (n: number) => Promise<PdfPage> }
      | null;
    const container = containerRef.current;
    if (!pdf || !container) return;

    let cancelled = false;

    (async () => {
      // Clear existing canvases
      container.replaceChildren();

      for (let i = 1; i <= pdf.numPages; i++) {
        if (cancelled) return;

        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale });

        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.className = "mb-4 shadow-md";
        container.appendChild(canvas);

        const ctx = canvas.getContext("2d");
        if (ctx) {
          await page.render({ canvasContext: ctx, viewport }).promise;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [numPages, scale]);

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="rounded border border-signal-red bg-ironlore-slate p-4 text-sm text-signal-red">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-1.5">
        <span className="text-xs text-secondary">
          {loading ? "Loading..." : `${numPages} page${numPages === 1 ? "" : "s"}`}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          className="rounded p-1 text-secondary hover:bg-ironlore-slate-hover"
          onClick={zoomOut}
          aria-label="Zoom out"
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <span className="min-w-[3rem] text-center text-xs text-secondary">
          {Math.round(scale * 100)}%
        </span>
        <button
          type="button"
          className="rounded p-1 text-secondary hover:bg-ironlore-slate-hover"
          onClick={zoomIn}
          aria-label="Zoom in"
        >
          <ZoomIn className="h-4 w-4" />
        </button>
      </div>

      {/* Pages */}
      <div
        ref={containerRef}
        className="flex flex-1 flex-col items-center overflow-auto bg-ironlore-slate p-8"
      />
    </div>
  );
}

/** Minimal PDF.js page type for internal use. */
interface PdfPage {
  getViewport: (params: { scale: number }) => { width: number; height: number };
  render: (params: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }) => { promise: Promise<void> };
}
