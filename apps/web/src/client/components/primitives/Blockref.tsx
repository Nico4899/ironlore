import type { CSSProperties, MouseEventHandler, ReactNode } from "react";

/**
 * Blockref — bespoke chip for `[[Page#blk_…]]` citations.
 *
 * Replaces the generic inline anchor the editor previously emitted.
 * The chip is anchored by a 2px Ironlore-Blue left bar, carries the
 * page title in Inter and the block id in JetBrains Mono. Hovering
 * swaps the background to `--il-blue-glow` and thickens the bar to
 * 3px (handled purely in CSS via `:hover`).
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
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap: 4,
        padding: "0 5px",
        fontFamily: "var(--font-sans)",
        fontSize: 13,
        lineHeight: 1.4,
        color: "var(--il-text)",
        background: "color-mix(in oklch, var(--il-blue) 10%, transparent)",
        borderLeft: stale ? "2px dashed var(--il-blue)" : "2px solid var(--il-blue)",
        borderRadius: "0 2px 2px 0",
        textDecoration: "none",
        cursor: "pointer",
        transition: "background var(--motion-snap) ease-out",
        verticalAlign: "baseline",
        ...style,
      }}
    >
      <span>{children ?? page}</span>
      {short && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            color: "var(--il-text3)",
            letterSpacing: "0.02em",
          }}
        >
          #{short}
        </span>
      )}
    </button>
  );
}
