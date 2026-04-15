import { useEffect, useState } from "react";
import { createPage, fetchRawUrl } from "../../lib/api.js";
import { sanitizeHtml } from "../../lib/sanitize-html.js";
import { useAppStore } from "../../stores/app.js";

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
  const [text, setText] = useState<string>("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);

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
        setText(result.text);
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

  const markdownPath = path.replace(/\.docx$/i, ".md");

  const handleConvert = async () => {
    if (converting) return;
    if (!window.confirm(`Create ${markdownPath} from ${path}?`)) return;
    setConverting(true);
    try {
      const body = text.trim().length > 0 ? text : "_(empty document)_";
      await createPage(markdownPath, body);
      useAppStore.getState().setActivePath(markdownPath);
    } catch (err) {
      window.alert(`Convert failed: ${(err as Error).message}`);
    } finally {
      setConverting(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border bg-ironlore-slate-hover px-4 py-1.5 text-xs text-secondary">
        {warnings.length > 0 && (
          <span>
            {warnings.length} parse warning{warnings.length === 1 ? "" : "s"}
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          disabled={converting}
          onClick={handleConvert}
          className="rounded border border-border px-2 py-0.5 hover:bg-ironlore-slate disabled:opacity-40"
        >
          {converting ? "Converting…" : "Convert to markdown"}
        </button>
      </div>
      <div
        className="docx-body flex-1 overflow-y-auto px-8 py-6"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
