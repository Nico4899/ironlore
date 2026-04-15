import type { NotebookCell } from "@ironlore/core/extractors";
import { useEffect, useState } from "react";
import { fetchRawUrl } from "../../lib/api.js";
import { renderMarkdownSafe } from "../../lib/render-markdown-safe.js";

interface NotebookViewerProps {
  path: string;
}

/**
 * Renders a Jupyter `.ipynb` via the shared `extractIpynb` extractor.
 *
 * Markdown cells are sanitized through the same `renderMarkdownSafe`
 * pipeline as the editor preview. Code cells are shown in a monospace
 * block with an execution-count gutter. Outputs (stdout / stderr /
 * `text/plain`) are rendered as plain text; images and rich MIME types
 * are intentionally skipped — the goal is faithful, auditable display,
 * not a replacement for JupyterLab.
 */
export function NotebookViewer({ path }: NotebookViewerProps) {
  const [cells, setCells] = useState<NotebookCell[] | null>(null);
  const [language, setLanguage] = useState<string | undefined>(undefined);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCells(null);
    setLanguage(undefined);
    setWarnings([]);
    setError(null);

    (async () => {
      try {
        const res = await fetch(fetchRawUrl(path));
        if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
        const buf = await res.arrayBuffer();
        const { extract } = await import("@ironlore/core/extractors");
        const result = await extract("notebook", buf);
        if (cancelled) return;
        setCells(result.notebook ?? []);
        setLanguage(result.notebookLanguage);
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

  if (cells === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-secondary">Loading notebook...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border bg-ironlore-slate-hover px-4 py-1.5 text-xs text-secondary">
        <span>
          {cells.length} cell{cells.length === 1 ? "" : "s"}
        </span>
        {language && (
          <span className="rounded border border-border px-2 py-0.5 font-mono">{language}</span>
        )}
        {warnings.length > 0 && (
          <span>
            · {warnings.length} warning{warnings.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {cells.map((cell, idx) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: notebook cells are static within a loaded notebook
          <CellRow key={idx} cell={cell} />
        ))}
      </div>
    </div>
  );
}

function CellRow({ cell }: { cell: NotebookCell }) {
  if (cell.kind === "markdown") {
    return (
      <div className="mb-4 border-l-2 border-transparent pl-4">
        <div
          className="prose prose-sm max-w-none text-primary"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: output passes through renderMarkdownSafe
          dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(cell.source) }}
        />
      </div>
    );
  }

  if (cell.kind === "code") {
    return (
      <div className="mb-4 flex gap-3">
        <span
          className="select-none pt-1 font-mono text-xs text-secondary"
          aria-label="Execution count"
        >
          In [{cell.executionCount ?? " "}]:
        </span>
        <div className="flex-1 overflow-x-auto">
          <pre className="rounded bg-ironlore-slate p-3 font-mono text-xs text-primary">
            {cell.source}
          </pre>
          {cell.outputs.length > 0 && (
            <pre className="mt-1 rounded bg-ironlore-slate-hover p-3 font-mono text-xs text-secondary">
              {cell.outputs.join("\n")}
            </pre>
          )}
        </div>
      </div>
    );
  }

  // raw cell
  return (
    <div className="mb-4">
      <pre className="rounded bg-ironlore-slate p-3 font-mono text-xs text-secondary">
        {cell.source}
      </pre>
    </div>
  );
}
