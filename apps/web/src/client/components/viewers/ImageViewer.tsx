import { Download, Maximize2, RotateCw, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useState } from "react";
import { fetchRawUrl } from "../../lib/api.js";

interface ImageViewerProps {
  path: string;
}

export function ImageViewer({ path }: ImageViewerProps) {
  const url = fetchRawUrl(path);
  const fileName = path.split("/").pop() ?? "image";
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);

  const zoomIn = useCallback(() => setScale((s) => Math.min(s * 1.25, 5)), []);
  const zoomOut = useCallback(() => setScale((s) => Math.max(s / 1.25, 0.1)), []);
  const resetZoom = useCallback(() => {
    setScale(1);
    setRotation(0);
  }, []);
  const rotate = useCallback(() => setRotation((r) => (r + 90) % 360), []);

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
          onClick={resetZoom}
          aria-label="Reset view"
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
        <div className="flex-1" />
        <a
          href={url}
          download={fileName}
          className="rounded p-1 text-secondary hover:bg-ironlore-slate-hover"
          aria-label="Download image"
        >
          <Download className="h-4 w-4" />
        </a>
      </div>

      {/* Image */}
      <div className="flex flex-1 items-center justify-center overflow-auto p-8">
        <img
          src={url}
          alt={path}
          className="transition-transform duration-150"
          style={{ transform: `scale(${scale}) rotate(${rotation}deg)` }}
          draggable={false}
        />
      </div>
    </div>
  );
}
