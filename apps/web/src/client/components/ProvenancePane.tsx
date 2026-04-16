import { X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { fetchPage } from "../lib/api.js";
import { renderMarkdownSafe } from "../lib/render-markdown-safe.js";

/**
 * Provenance pane — opened by clicking a `[[Page#blk_…]]` citation
 * in an AI reply.
 *
 * A split overlays the content area 60/40 with the editor on the left
 * and the source page on the right, scrolled to the referenced block
 * with a Signal-Amber flash highlight for ~1.5s. Read-only, no edit
 * affordances, Escape-dismissible.
 *
 * See docs/03-editor.md §Block-ref click and hover provenance and
 * docs/09-ui-and-brand.md §Provenance pane.
 */

interface ProvenancePaneProps {
  /** The page path containing the cited block. */
  pagePath: string;
  /** The block ID to scroll to and highlight. */
  blockId: string;
  /** Close the pane. */
  onClose: () => void;
}

export function ProvenancePane({ pagePath, blockId, onClose }: ProvenancePaneProps) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);

    fetchPage(pagePath)
      .then((page) => {
        if (!cancelled) setContent(page.content);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      });

    return () => {
      cancelled = true;
    };
  }, [pagePath]);

  // Scroll to block + flash on load.
  useEffect(() => {
    if (!content) return;
    const timer = setTimeout(() => {
      const el = document.getElementById(`provenance-${blockId}`);
      if (el) {
        el.scrollIntoView({ block: "center" });
        el.classList.add("bg-signal-amber/20");
        setTimeout(() => el.classList.remove("bg-signal-amber/20"), 1500);
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [content, blockId]);

  // Escape to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleClickOutside = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  if (error) {
    return (
      <aside
        className="flex w-[40%] shrink-0 flex-col border-l border-border bg-ironlore-slate"
        aria-label="Source of citation"
      >
        <PaneHeader pagePath={pagePath} blockId={blockId} onClose={onClose} />
        <div className="flex flex-1 items-center justify-center px-6">
          <p className="text-sm text-signal-amber">This source has moved or was deleted.</p>
        </div>
      </aside>
    );
  }

  return (
    <aside
      className="flex w-[40%] shrink-0 flex-col border-l border-border bg-ironlore-slate"
      aria-label="Source of citation"
      onClick={handleClickOutside}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <PaneHeader pagePath={pagePath} blockId={blockId} onClose={onClose} />
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {content === null ? (
          <p className="text-sm text-secondary">Loading…</p>
        ) : (
          <ProvenanceContent content={content} blockId={blockId} />
        )}
      </div>
    </aside>
  );
}

function PaneHeader({
  pagePath,
  blockId,
  onClose,
}: {
  pagePath: string;
  blockId: string;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-4 py-2">
      <div className="flex-1 min-w-0">
        <div className="truncate text-xs font-medium text-primary">{pagePath.split("/").pop()}</div>
        <div className="truncate font-mono text-[10px] text-secondary">{blockId}</div>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close provenance pane"
        className="flex h-6 w-6 items-center justify-center rounded text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function ProvenanceContent({ content, blockId }: { content: string; blockId: string }) {
  // Render the full page but wrap each block-ID match in a target span.
  // The block we're looking for gets an ID for scrolling + the flash.
  const html = renderMarkdownSafe(content);

  // Inject an anchor before the target block ID comment so the scroll
  // target exists in the rendered DOM. Since block IDs are HTML comments
  // and get stripped by the sanitizer, we insert a visible marker via
  // a simple string replacement on the unsanitized content.
  const markedHtml = html.replace(
    new RegExp(`(${blockId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "g"),
    `<span id="provenance-${blockId}" class="transition-colors duration-1000"></span>$1`,
  );

  return (
    <div
      className="prose prose-sm max-w-none text-primary"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: output passes through renderMarkdownSafe
      dangerouslySetInnerHTML={{ __html: markedHtml }}
    />
  );
}
