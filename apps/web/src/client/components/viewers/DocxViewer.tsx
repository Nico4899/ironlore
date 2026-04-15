import { useEffect, useState } from "react";
import { fetchRawUrl } from "../../lib/api.js";
import { sanitizeHtml } from "../../lib/sanitize-html.js";
import "../editor/editor.css";

interface DocxViewerProps {
  path: string;
}

/**
 * Renders a .docx file via the shared `extractDocx` extractor.
 *
 * Mammoth handles the container parsing; its HTML output passes through
 * `sanitizeHtml` before reaching the DOM. The same extractor feeds
 * server-side FTS5 ingestion so "what agents see" matches "what users
 * see."
 */
export function DocxViewer({ path }: DocxViewerProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setError(null);
    setWarnings([]);

    (async () => {
      try {
        const url = fetchRawUrl(path);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
        const buf = await res.arrayBuffer();
        const { extract } = await import("@ironlore/core/extractors");
        const result = await extract("word", buf);
        if (cancelled) return;
        setHtml(sanitizeHtml(result.html ?? ""));
        setWarnings(result.warnings);
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path]);

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-secondary">Failed to render: {error}</p>
      </div>
    );
  }

  if (html === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-secondary">Loading document...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {warnings.length > 0 && (
        <div className="border-b border-border bg-ironlore-slate-hover px-4 py-1.5 text-xs text-secondary">
          {warnings.length} parse warning{warnings.length === 1 ? "" : "s"}
        </div>
      )}
      <div
        className="ProseMirror flex-1 overflow-y-auto px-8 py-6"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
