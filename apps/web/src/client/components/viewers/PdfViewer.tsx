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
  const pageElsRef = useRef<HTMLCanvasElement[]>([]);

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

  // Render pages when scale/rotation/document changes
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
      container.replaceChildren();
      pageElsRef.current = [];

      for (let i = 1; i <= pdf.numPages; i++) {
        if (cancelled) return;

        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale, rotation });

        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.className = "mb-4 shadow-md";
        canvas.dataset.pageNumber = String(i);
        container.appendChild(canvas);
        pageElsRef.current[i - 1] = canvas;

        const ctx = canvas.getContext("2d");
        if (ctx) {
          await page.render({ canvasContext: ctx, viewport }).promise;
        }
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

/** Minimal PDF.js page type for internal use. */
interface PdfPage {
  getViewport: (params: { scale: number; rotation?: number }) => {
    width: number;
    height: number;
  };
  render: (params: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }) => { promise: Promise<void> };
}
