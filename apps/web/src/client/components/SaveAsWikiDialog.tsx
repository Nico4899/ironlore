import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { saveReplyAsWikiPage } from "../lib/api.js";
import { useAppStore } from "../stores/app.js";

/**
 * "Save as wiki page" dialog — Phase-11 query-to-wiki workflow
 * (A.6.2). Captures the assistant reply the user wants to persist,
 * lets them set a title + parent folder, extracts citations from
 * the markdown body as `source_ids`, and POSTs to
 * `/api/projects/:id/pages/from-conversation`.
 *
 * Citation extraction follows the existing `[[Page#blk_…]]` grammar:
 * we collect every distinct page-path token before the `#`, dedupe,
 * and ship them as `sourceIds`. Per Principle 5a, the server saves
 * those into the new page's frontmatter `source_ids` array so the
 * trust pipeline can evaluate the citation chain on read.
 */
export function SaveAsWikiDialog({
  markdown,
  onClose,
}: {
  markdown: string;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [parent, setParent] = useState("wiki");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setActivePath = useAppStore((s) => s.setActivePath);

  // Extract block-ref source-page paths once on mount. Identical
  // grammar to the agent panel's CitationText regex.
  const sourceIds = extractSourcePaths(markdown);

  useEffect(() => {
    // Pre-seed the title from the first markdown header if present —
    // saves the user a step in the common case.
    const firstHeader = /^#+\s+(.+?)\s*$/m.exec(markdown);
    if (firstHeader?.[1]) setTitle(firstHeader[1].slice(0, 80));
  }, [markdown]);

  const handleSave = async () => {
    if (!title.trim()) {
      setError("Title required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await saveReplyAsWikiPage({
        title: title.trim(),
        markdown,
        parent: parent.trim() || "wiki",
        sourceIds,
      });
      // Navigate to the freshly-created page so the user lands on
      // their new wiki entry. Closes the dialog at the same time.
      setActivePath(res.path);
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Save reply as wiki page"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "color-mix(in oklch, black 50%, transparent)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 440,
          maxWidth: "90vw",
          background: "var(--il-slate-elev)",
          border: "1px solid var(--il-border)",
          borderRadius: 6,
          padding: 16,
        }}
      >
        <header className="flex items-center gap-2 border-b border-border pb-2">
          <span
            className="font-mono uppercase"
            style={{ fontSize: 10.5, letterSpacing: "0.06em", color: "var(--il-text3)" }}
          >
            Save as wiki page
          </span>
          <span className="flex-1" />
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded p-0.5 hover:bg-ironlore-slate-hover"
          >
            <X className="h-3.5 w-3.5" style={{ color: "var(--il-text3)" }} />
          </button>
        </header>

        <div className="mt-3 flex flex-col gap-3 text-xs">
          <label className="flex flex-col gap-1">
            <span style={{ color: "var(--il-text3)" }}>Title</span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              className="rounded border border-border bg-transparent px-2 py-1.5 text-primary focus:border-ironlore-blue focus:outline-none"
              maxLength={120}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span style={{ color: "var(--il-text3)" }}>Parent folder</span>
            <input
              type="text"
              value={parent}
              onChange={(e) => setParent(e.target.value)}
              className="rounded border border-border bg-transparent px-2 py-1.5 font-mono text-primary focus:border-ironlore-blue focus:outline-none"
              placeholder="wiki"
            />
          </label>
          {sourceIds.length > 0 && (
            <div
              className="rounded p-2 font-mono"
              style={{
                background: "color-mix(in oklch, var(--il-blue) 8%, transparent)",
                border: "1px solid color-mix(in oklch, var(--il-blue) 25%, transparent)",
                fontSize: 10.5,
              }}
            >
              <div className="uppercase" style={{ color: "var(--il-blue)" }}>
                source_ids · {sourceIds.length}
              </div>
              <ul className="mt-0.5 space-y-0.5" style={{ color: "var(--il-text2)" }}>
                {sourceIds.slice(0, 5).map((s) => (
                  <li key={s} className="truncate" title={s}>
                    {s}
                  </li>
                ))}
                {sourceIds.length > 5 && (
                  <li style={{ color: "var(--il-text4)" }}>
                    …and {sourceIds.length - 5} more
                  </li>
                )}
              </ul>
            </div>
          )}
          {sourceIds.length === 0 && (
            <p style={{ color: "var(--il-text3)", fontSize: 10.5 }}>
              No <code>[[page#blk_…]]</code> citations in this reply — the saved page will start
              with empty <code>source_ids</code> and surface as an unverified provenance gap on
              the next lint run.
            </p>
          )}
          {error && (
            <p role="alert" className="text-signal-red">
              {error}
            </p>
          )}
        </div>

        <footer className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded border border-border px-3 py-1 text-xs hover:bg-ironlore-slate-hover disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={submitting || !title.trim()}
            className="rounded bg-ironlore-blue px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Pull every distinct source-page path out of `[[page#blk_…]]`
 * citations in the markdown body. Order preserved (first
 * occurrence wins) so the resulting `source_ids` array reads in
 * the same order the agent introduced them.
 *
 * Exported for tests.
 */
export function extractSourcePaths(markdown: string): string[] {
  const re = /\[\[([^\]\n]+?)#blk_[A-Za-z0-9]+\]\]/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const page = m[1]?.trim();
    if (!page || seen.has(page)) continue;
    seen.add(page);
    out.push(page);
  }
  return out;
}
