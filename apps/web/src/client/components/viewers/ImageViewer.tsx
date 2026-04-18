import { Download, ImageOff, Maximize2, RotateCw, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { fetchRawUrl } from "../../lib/api.js";

interface ImageViewerProps {
  path: string;
}

export function ImageViewer({ path }: ImageViewerProps) {
  const url = fetchRawUrl(path);
  const fileName = path.split("/").pop() ?? "image";
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [failed, setFailed] = useState(false);

  // Reset the failed state when the user navigates to a different
  // file (the `<img onError>` handler is sticky otherwise).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on path change is the whole point
  useEffect(() => {
    setFailed(false);
  }, [path]);

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
        {failed ? (
          <div className="text-center text-sm text-secondary">
            <ImageOff className="mx-auto mb-2 h-8 w-8 text-signal-amber" aria-hidden="true" />
            <p className="font-medium text-primary">Couldn't load this image</p>
            <p className="mt-1 text-xs">
              <code className="font-mono">{fileName}</code>
            </p>
            <a
              href={url}
              download={fileName}
              className="mt-3 inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs text-primary hover:bg-ironlore-slate-hover"
            >
              <Download className="h-3.5 w-3.5" />
              Download original
            </a>
          </div>
        ) : (
          <img
            src={url}
            // Basename only — passing the full path here makes screen
            // readers announce a slash-delimited string that's noisy and
            // doesn't help users place the image in their workspace.
            alt={fileName}
            className="transition-transform duration-(--motion-transit)"
            style={{ transform: `scale(${scale}) rotate(${rotation}deg)` }}
            draggable={false}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </div>
  );
}
