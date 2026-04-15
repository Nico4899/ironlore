import {
  ChevronLeft,
  ChevronRight,
  Download,
  Maximize2,
  RotateCw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchRawUrl } from "../../lib/api.js";

interface PdfViewerProps {
  path: string;
}

export function PdfViewer({ path }: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1.5);
  const [rotation, setRotation] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pdfDocRef = useRef<unknown>(null);
  // Per-page wrapper element (canvas + textLayer share its coordinate
  // space). Used by the IntersectionObserver below to track the
  // currently-visible page during scroll.
  const pageElsRef = useRef<HTMLDivElement[]>([]);

  const url = fetchRawUrl(path);
  const fileName = path.split("/").pop() ?? "document.pdf";

  const zoomIn = useCallback(() => setScale((s) => Math.min(s * 1.25, 4)), []);
  const zoomOut = useCallback(() => setScale((s) => Math.max(s / 1.25, 0.5)), []);
  const rotate = useCallback(() => setRotation((r) => (r + 90) % 360), []);

  const fitToWidth = useCallback(async () => {
    const pdf = pdfDocRef.current as {
      getPage: (n: number) => Promise<PdfPage>;
    } | null;
    const container = containerRef.current;
    if (!pdf || !container) return;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1, rotation });
    // 64px accounts for p-8 padding on both sides.
    const available = container.clientWidth - 64;
    if (available > 0 && viewport.width > 0) {
      setScale(available / viewport.width);
    }
  }, [rotation]);

  const scrollToPage = useCallback((n: number) => {
    const canvas = pageElsRef.current[n - 1];
    if (canvas) canvas.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const goPrev = useCallback(() => {
    setCurrentPage((p) => {
      const next = Math.max(1, p - 1);
      scrollToPage(next);
      return next;
    });
  }, [scrollToPage]);

  const goNext = useCallback(() => {
    setCurrentPage((p) => {
      const next = Math.min(numPages, p + 1);
      scrollToPage(next);
      return next;
    });
  }, [numPages, scrollToPage]);

  // Load PDF document
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only; path changes handled by parent remounting
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const pdfjsLib = await import("pdfjs-dist");
        const workerModule = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerModule.default;

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
      const pdf = pdfDocRef.current as { destroy?: () => void } | null;
      if (pdf?.destroy) {
        pdf.destroy();
        pdfDocRef.current = null;
      }
    };
  }, []);

  // Render pages when scale/rotation/document changes.
  //
  // Per page we build a positioned wrapper containing both the canvas
  // (raster pixels) and a `TextLayer` overlay (transparent positioned
  // spans) so users can drag-select text, the OS "find in page" finds
  // hits, and the global `HighlightToolbar` activates inside PDFs.
  //
  // biome-ignore lint/correctness/useExhaustiveDependencies: numPages triggers re-render after PDF load completes
  useEffect(() => {
    const pdf = pdfDocRef.current as {
      numPages: number;
      getPage: (n: number) => Promise<PdfPage>;
    } | null;
    const container = containerRef.current;
    if (!pdf || !container) return;

    let cancelled = false;

    (async () => {
      // Preserve scroll position across re-render so zoom/rotate
      // doesn't dump the user back to page 1 (Phase 2.5 audit Step 3).
      const fractional =
        container.scrollHeight > 0 ? container.scrollTop / container.scrollHeight : 0;

      container.replaceChildren();
      pageElsRef.current = [];

      const pdfjsLib = await import("pdfjs-dist");
      const TextLayer = (pdfjsLib as unknown as { TextLayer: TextLayerCtor }).TextLayer;

      for (let i = 1; i <= pdf.numPages; i++) {
        if (cancelled) return;

        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale, rotation });

        // Per-page wrapper — canvas + textLayer share its coordinate
        // space via absolute positioning.
        const wrapper = document.createElement("div");
        wrapper.className = "ir-pdf-page shadow-md";
        wrapper.style.width = `${viewport.width}px`;
        wrapper.style.height = `${viewport.height}px`;
        wrapper.dataset.pageNumber = String(i);
        container.appendChild(wrapper);
        pageElsRef.current[i - 1] = wrapper;

        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.display = "block";
        wrapper.appendChild(canvas);

        const textDiv = document.createElement("div");
        textDiv.className = "ir-pdf-textLayer";
        textDiv.style.width = `${viewport.width}px`;
        textDiv.style.height = `${viewport.height}px`;
        // PDF.js >=4 uses `--scale-factor` to size the spans relative to
        // the viewport. Without this, text spans render at 1px height.
        textDiv.style.setProperty("--scale-factor", String(scale));
        wrapper.appendChild(textDiv);

        const ctx = canvas.getContext("2d");
        if (ctx) {
          await page.render({ canvasContext: ctx, viewport }).promise;
        }

        if (cancelled) return;

        // Render the text layer second so the user sees the canvas
        // immediately and selection arrives a frame later. Fall back
        // silently for scanned PDFs that have no extractable text.
        try {
          const textContent = await page.getTextContent();
          const textLayer = new TextLayer({
            textContentSource: textContent,
            container: textDiv,
            viewport,
          });
          await textLayer.render();
        } catch {
          // No extractable text — selection just won't activate here.
        }
      }

      if (!cancelled && container.scrollHeight > 0) {
        container.scrollTop = fractional * container.scrollHeight;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [numPages, scale, rotation]);

  // Track which page is currently in view while scrolling.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || numPages === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!visible) return;
        const n = Number((visible.target as HTMLElement).dataset.pageNumber);
        if (n) setCurrentPage(n);
      },
      { root: container, threshold: [0.25, 0.5, 0.75] },
    );

    for (const c of pageElsRef.current) observer.observe(c);
    return () => observer.disconnect();
  }, [numPages]);

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
        <button
          type="button"
          className="rounded p-1 text-secondary hover:bg-ironlore-slate-hover disabled:opacity-40"
          onClick={goPrev}
          disabled={currentPage <= 1}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-xs text-secondary tabular-nums">
          {loading ? "…" : `${currentPage} / ${numPages}`}
        </span>
        <button
          type="button"
          className="rounded p-1 text-secondary hover:bg-ironlore-slate-hover disabled:opacity-40"
          onClick={goNext}
          disabled={currentPage >= numPages}
          aria-label="Next page"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <div className="flex-1" />
        <button
          type="button"
          className="rounded p-1 text-secondary hover:bg-ironlore-slate-hover"
          onClick={zoomOut}
          aria-label="Zoom out"
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <span className="min-w-12 text-center text-xs text-secondary tabular-nums">
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
        <button
          type="button"
          className="rounded p-1 text-secondary hover:bg-ironlore-slate-hover"
          onClick={fitToWidth}
          aria-label="Fit to width"
        >
          <Maximize2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="rounded p-1 text-secondary hover:bg-ironlore-slate-hover"
          onClick={rotate}
          aria-label="Rotate"
        >
          <RotateCw className="h-4 w-4" />
        </button>
        <a
          href={url}
          download={fileName}
          className="rounded p-1 text-secondary hover:bg-ironlore-slate-hover"
          aria-label="Download PDF"
        >
          <Download className="h-4 w-4" />
        </a>
      </div>

      {/* Pages */}
      <div
        ref={containerRef}
        className="flex flex-1 flex-col items-center overflow-auto bg-ironlore-slate p-8"
      />
    </div>
  );
}

/**
 * Minimal PDF.js types for the surface we actually call. We keep these
 * structural types here instead of pulling pdfjs-dist's full `.d.ts`
 * into the call sites — the dynamic `import("pdfjs-dist")` already
 * deferred the runtime cost; bringing the static types back into the
 * viewer just to type three method shapes isn't worth the ergonomics.
 */
interface PdfViewport {
  width: number;
  height: number;
}

interface PdfPage {
  getViewport: (params: { scale: number; rotation?: number }) => PdfViewport;
  render: (params: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }) => {
    promise: Promise<void>;
  };
  /** PDF.js text layer source — an opaque object handed to TextLayer. */
  getTextContent: () => Promise<unknown>;
}

/** Constructor signature for the dynamically-imported `TextLayer`. */
interface TextLayerCtor {
  new (params: {
    textContentSource: unknown;
    container: HTMLElement;
    viewport: PdfViewport;
  }): { render: () => Promise<void> };
}
