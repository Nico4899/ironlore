import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useState } from "react";
import { fetchRawUrl } from "../../lib/api.js";

interface ImageViewerProps {
  path: string;
}

export function ImageViewer({ path }: ImageViewerProps) {
  const url = fetchRawUrl(path);
  const [scale, setScale] = useState(1);

  const zoomIn = useCallback(() => setScale((s) => Math.min(s * 1.25, 5)), []);
  const zoomOut = useCallback(() => setScale((s) => Math.max(s / 1.25, 0.1)), []);
  const resetZoom = useCallback(() => setScale(1), []);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-1.5">
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
        <button
          type="button"
          className="rounded p-1 text-secondary hover:bg-ironlore-slate-hover"
          onClick={resetZoom}
          aria-label="Fit to window"
        >
          <Maximize2 className="h-4 w-4" />
        </button>
      </div>

      {/* Image */}
      <div className="flex flex-1 items-center justify-center overflow-auto p-8">
        <img
          src={url}
          alt={path}
          className="transition-transform duration-150"
          style={{ transform: `scale(${scale})` }}
          draggable={false}
        />
      </div>
    </div>
  );
}
