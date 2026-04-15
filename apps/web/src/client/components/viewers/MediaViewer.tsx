import type { PageType } from "@ironlore/core";
import { Download } from "lucide-react";
import { fetchRawUrl } from "../../lib/api.js";

interface MediaViewerProps {
  path: string;
  fileType: PageType;
}

export function MediaViewer({ path, fileType }: MediaViewerProps) {
  const url = fetchRawUrl(path);
  const fileName = path.split("/").pop() ?? "media";

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
        {fileType === "video" ? (
          <video src={url} controls className="max-h-full max-w-full rounded" aria-label={path} />
        ) : (
          <audio src={url} controls className="w-full max-w-lg" aria-label={path} />
        )}
      </div>
    </div>
  );
}
