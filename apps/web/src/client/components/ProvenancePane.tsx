import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchPage } from "../lib/api.js";
import { renderMarkdownSafe } from "../lib/render-markdown-safe.js";
import { MOTION } from "../styles/motion.js";
import { Key } from "./primitives/index.js";

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

  // Scroll to block + flash on load. `.il-flash` runs the `ilFlash`
  //  keyframe (Signal-Amber → transparent) for `--motion-flash`
  //  (1.5 s). We add the class, then remove it MOTION.flash + 50 ms
  //  later so a subsequent citation click can re-trigger the
  //  animation (CSS only restarts when the class drops & re-adds).
  useEffect(() => {
    if (!content) return;
    const timer = setTimeout(() => {
      const el = document.getElementById(`provenance-${blockId}`);
      if (el) {
        el.scrollIntoView({ block: "center" });
        el.classList.remove("il-flash");
        // Force reflow so the re-added class re-runs the animation.
        void (el as HTMLElement).offsetWidth;
        el.classList.add("il-flash");
        setTimeout(() => el.classList.remove("il-flash"), MOTION.flash + 50);
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
        <PaneHeader pagePath={pagePath} onClose={onClose} />
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
      <PaneHeader pagePath={pagePath} onClose={onClose} />
      <div
        className="flex-1 overflow-y-auto"
        style={{
          padding: "18px 18px",
          background: "var(--il-bg-raised, var(--il-bg))",
        }}
      >
        {/* Full path as a muted mono overline, per screen-editor.jsx. */}
        <div
          className="font-mono truncate"
          style={{
            fontSize: 10.5,
            color: "var(--il-text4)",
            letterSpacing: "0.06em",
            marginBottom: 6,
          }}
          title={pagePath}
        >
          {pagePath}
        </div>
        {content === null ? (
          <p className="text-sm text-secondary">Loading…</p>
        ) : (
          // `key` forces a fresh mount whenever the user clicks a new
          //  citation so the target-block effect re-runs with the new
          //  DOM. Lets us scope the effect's deps to `[blockId]` alone.
          <ProvenanceContent key={`${pagePath}#${blockId}`} content={content} blockId={blockId} />
        )}
      </div>
    </aside>
  );
}

function PaneHeader({ pagePath, onClose }: { pagePath: string; onClose: () => void }) {
  const fileName = pagePath.split("/").pop() ?? pagePath;
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b"
      style={{
        padding: "10px 14px",
        borderColor: "var(--il-border-soft)",
      }}
    >
      {/* Mono `SOURCE · <file>` label — matches screen-editor.jsx. The
       *  short filename sits after the `Source ·` anchor; the full
       *  path appears below, inside the body, in muted text4. */}
      <span
        className="font-mono uppercase truncate"
        style={{
          fontSize: 10.5,
          letterSpacing: "0.08em",
          color: "var(--il-text3)",
        }}
        title={pagePath}
      >
        source · <span style={{ color: "var(--il-text)" }}>{fileName}</span>
      </span>
      <span className="flex-1" />
      {/* ESC chip is discovery; the actual close is bound to the
       *  Escape keydown listener above + the X button below. */}
      <Key>ESC</Key>
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

const BLOCK_TAGS = new Set([
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "UL",
  "OL",
  "LI",
  "BLOCKQUOTE",
  "PRE",
  "DIV",
  "TABLE",
]);

function ProvenanceContent({ content, blockId }: { content: string; blockId: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  // Rendered markdown — the block-ID HTML comments get stripped by
  //  the sanitizer, so we substitute a visible anchor before the
  //  sanitizer sees them. The anchor's id lets us scroll + locate
  //  the target block in a `useEffect` below.
  const html = renderMarkdownSafe(content).replace(
    new RegExp(`(${blockId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "g"),
    `<span id="provenance-${blockId}" class="il-provenance-anchor"></span>$1`,
  );

  // After the HTML mounts, locate the nearest block ancestor of the
  //  anchor and frame it in amber with a 2 px left rail. Append a
  //  mono `target · blk_<id> · flashed 1.5s` overline as a sibling
  //  inside the block so the cue is persistent (the transient flash
  //  is handled by the parent effect).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const anchor = host.querySelector(`#provenance-${CSS.escape(blockId)}`);
    if (!anchor) return;

    let block: HTMLElement | null = anchor.parentElement;
    while (block && block !== host && !BLOCK_TAGS.has(block.tagName)) {
      block = block.parentElement;
    }
    if (!block || block === host) return;

    block.classList.add("il-provenance-target");
    const overline = document.createElement("div");
    overline.className = "il-provenance-target-overline";
    overline.textContent = `target · ${blockId} · flashed ${MOTION.flash / 1000}s`;
    block.appendChild(overline);

    return () => {
      block?.classList.remove("il-provenance-target");
      overline.remove();
    };
  }, [blockId]);

  return (
    <div
      ref={hostRef}
      className="prose prose-sm max-w-none text-primary"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: output passes through renderMarkdownSafe
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
