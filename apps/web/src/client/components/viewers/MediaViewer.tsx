import type { PageType } from "@ironlore/core";
import { fetchRawUrl } from "../../lib/api.js";

interface MediaViewerProps {
  path: string;
  fileType: PageType;
}

export function MediaViewer({ path, fileType }: MediaViewerProps) {
  const url = fetchRawUrl(path);

  return (
    <div className="flex flex-1 items-center justify-center overflow-auto p-8">
      {fileType === "video" ? (
        <video
          src={url}
          controls
          className="max-h-full max-w-full rounded"
          aria-label={path}
        >
          <track kind="captions" />
        </video>
      ) : (
        <audio src={url} controls className="w-full max-w-lg" aria-label={path}>
          <track kind="captions" />
        </audio>
      )}
    </div>
  );
}
