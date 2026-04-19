import type { CSSProperties, MouseEventHandler, ReactNode } from "react";

/**
 * Blockref — bespoke chip for `[[Page#blk_…]]` citations.
 *
 * All visual styling lives in `.il-blockref` (globals.css) so the
 * ProseMirror editor's wiki-link nodeView can render the same chip
 * shape with the same class. Hover (3px bar + blue-glow background),
 * the stale dashed variant, and focus rings are CSS-driven.
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
  /** Click handler; opens the provenance pane in production. */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /** Tooltip text on hover; usually the first line of the target block. */
  title?: string;
  className?: string;
  style?: CSSProperties;
}

function shortBlockId(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.replace(/^blk_/, "");
  if (trimmed.length <= 6) return trimmed;
  return trimmed.slice(-4);
}

export function Blockref({
  page,
  block,
  children,
  stale = false,
  onClick,
  title,
  className,
  style,
}: BlockrefProps) {
  const short = shortBlockId(block);
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={`Open ${page}${block ? ` block ${block}` : ""}`}
      className={["il-blockref", stale ? "il-blockref-stale" : "", className]
        .filter(Boolean)
        .join(" ")}
      style={style}
    >
      <span>{children ?? page}</span>
      {short && <span className="il-blockref__id">#{short}</span>}
    </button>
  );
}
