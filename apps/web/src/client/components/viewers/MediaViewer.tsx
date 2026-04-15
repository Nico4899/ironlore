import type { PageType } from "@ironlore/core";
import { AlertTriangle, Download } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchRawUrl } from "../../lib/api.js";

interface MediaViewerProps {
  path: string;
  fileType: PageType;
}

export function MediaViewer({ path, fileType }: MediaViewerProps) {
  const url = fetchRawUrl(path);
  const fileName = path.split("/").pop() ?? "media";
  const [failed, setFailed] = useState(false);

  // Reset the failed flag when the active file changes — without it
  // the second video the user opens inherits the previous error state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on path change is the whole point
  useEffect(() => {
    setFailed(false);
  }, [path]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-1.5">
        <span className="text-xs text-secondary">{fileName}</span>
        <div className="flex-1" />
        <a
          href={url}
          download={fileName}
          className="rounded p-1 text-secondary hover:bg-ironlore-slate-hover"
          aria-label={`Download ${fileType}`}
        >
          <Download className="h-4 w-4" />
        </a>
      </div>

      {/* Player */}
      <div className="flex flex-1 items-center justify-center overflow-auto p-8">
        {failed ? (
          <div className="text-center text-sm text-secondary">
            <AlertTriangle className="mx-auto mb-2 h-8 w-8 text-signal-amber" aria-hidden="true" />
            <p className="font-medium text-primary">
              Cannot play this {fileType === "video" ? "video" : "audio"} file
            </p>
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
        ) : fileType === "video" ? (
          <video
            src={url}
            controls
            className="max-h-full max-w-full rounded"
            aria-label={fileName}
            onError={() => setFailed(true)}
          />
        ) : (
          <audio
            src={url}
            controls
            className="w-full max-w-lg"
            aria-label={fileName}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </div>
  );
}
