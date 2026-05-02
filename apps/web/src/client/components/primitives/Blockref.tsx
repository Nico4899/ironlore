import {
  type CSSProperties,
  type MouseEventHandler,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { useBlockPreview } from "../../hooks/useBlockPreview.js";

/**
 * Blockref — bespoke chip for `[[Page#blk_…]]` citations.
 *
 * All visual styling lives in `.il-blockref` (globals.css) so the
 * ProseMirror editor's wiki-link nodeView can render the same chip
 * shape with the same class. Hover (3px bar + blue-glow background),
 * the stale dashed variant, and focus rings are CSS-driven.
 *
 * On hover, a 200 ms timer triggers a custom preview card rendered
 * from the in-memory block cache (see `useBlockPreview`). No network
 * round-trip once the page has been seen once — the cache also
 * populates from sidebars and editor loads. Click still opens the
 * full provenance pane.
 *
 * Per docs/09-ui-and-brand.md §Signature motifs / Blockref.
 */

export interface BlockrefProps {
  /** Page title or path to display as the main label. */
  page: string;
  /**
   * Block ID, with or without the `blk_` prefix. The chip renders
   * `#<short>` using the last 4 chars so a 26-char ULID fits
   * elegantly inside a chip.
   */
  block?: string;
  /** Optional override for the visible body text (defaults to `page`). */
  children?: ReactNode;
  /** Mark the ref as stale — block has moved since last cache write. */
  stale?: boolean;
  /** Click handler; opens the cited page in production. */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  className?: string;
  style?: CSSProperties;
}

function shortBlockId(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.replace(/^blk_/, "");
  if (trimmed.length <= 6) return trimmed;
  return trimmed.slice(-4);
}

const HOVER_DELAY_MS = 200;
const PREVIEW_MAX_CHARS = 240;

export function Blockref({
  page,
  block,
  children,
  stale = false,
  onClick,
  className,
  style,
}: BlockrefProps) {
  const short = shortBlockId(block);
  const [hovered, setHovered] = useState(false);
  const timer = useRef<number | null>(null);
  const preview = useBlockPreview(page, block, hovered);

  const startHover = () => {
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      setHovered(true);
      timer.current = null;
    }, HOVER_DELAY_MS);
  };
  const endHover = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setHovered(false);
  };

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={onClick}
        onMouseEnter={startHover}
        onMouseLeave={endHover}
        onFocus={() => setHovered(true)}
        onBlur={endHover}
        // No native `title` — the custom `BlockrefPreview` card is
        //  the canonical hover affordance. Stacking a browser
        //  tooltip on top of it produced the "Open <path>" ghost
        //  hovering above our preview, doubling up the same info
        //  in two surfaces. The `aria-label` below carries the
        //  same content for assistive tech without the visual stack.
        aria-label={`Open ${page}${block ? ` block ${block}` : ""}`}
        className={["il-blockref", stale ? "il-blockref-stale" : "", className]
          .filter(Boolean)
          .join(" ")}
        style={style}
      >
        <span>{children ?? page}</span>
        {short && <span className="il-blockref__id">#{short}</span>}
      </button>
      {/* Render the preview any time the chip is hovered — the card
       *  shows the page's first block when the ref doesn't carry a
       *  `#blk_…` suffix, so `[[Page]]` citations aren't silent. */}
      {hovered && <BlockrefPreview page={page} block={block} text={preview} />}
    </span>
  );
}

/**
 * Preview card rendered at `bottom` of the chip when hover survives
 * the 200 ms delay. Mirrors the schematic in the design handoff: a
 * small mono file/block header + a tail-indicator toward the chip +
 * up to `PREVIEW_MAX_CHARS` of body text (truncated with an ellipsis
 * when the block is long). If the cache hasn't landed yet, the body
 * collapses to a single `Loading…` line — the header stays so the
 * user still sees which target they're about to open.
 */
function BlockrefPreview({
  page,
  block,
  text,
}: {
  page: string;
  /** Optional — when present the head shows `file / blk_…`. */
  block?: string;
  text: string | null;
}) {
  const fileName = page.split("/").pop() ?? page;
  const body =
    text === null
      ? null
      : text.length > PREVIEW_MAX_CHARS
        ? `${text.slice(0, PREVIEW_MAX_CHARS)}…`
        : text;
  return (
    <div role="tooltip" className="il-blockref-preview" aria-label={`Preview of ${page}`}>
      <div className="il-blockref-preview__head">
        <span aria-hidden="true" style={{ color: "var(--il-text4)" }}>
          ·
        </span>
        <span className="truncate" title={page}>
          {fileName}
        </span>
        {block && (
          <>
            <span style={{ color: "var(--il-text4)" }}>/</span>
            <span style={{ color: "var(--il-text3)" }}>{block}</span>
          </>
        )}
        <span className="flex-1" />
        <span style={{ color: "var(--il-text3)" }}>click to open</span>
      </div>
      <div className="il-blockref-preview__body">
        {body === null ? <span style={{ color: "var(--il-text4)" }}>Loading…</span> : body}
      </div>
    </div>
  );
}
