import type { CSSProperties, ReactNode } from "react";

/**
 * Meta — the mono "key · value" cluster that annotates agent cards,
 * search inputs, and provenance strips.
 *
 * Renders `KEY · value` in JetBrains Mono uppercase for the key and
 * mixed-case for the value. The separator dot is tracked a hair wider
 * per docs/09-ui-and-brand.md §Canvas grammar.
 */

export interface MetaProps {
  /** Short mono-uppercase label (branch, fts5, step, finalized). */
  k: ReactNode;
  /** The value that sits after the interpunct. */
  v: ReactNode;
  /** Override the value color — defaults to `--il-text3`. */
  color?: string;
  className?: string;
  style?: CSSProperties;
}

export function Meta({ k, v, color = "var(--il-text3)", className, style }: MetaProps) {
  return (
    <span
      className={className}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 10.5,
        letterSpacing: "0.04em",
        color,
        display: "inline-flex",
        alignItems: "baseline",
        gap: 4,
        ...style,
      }}
    >
      <span style={{ textTransform: "uppercase", color: "var(--il-text4)" }}>{k}</span>
      <span aria-hidden="true">·</span>
      {/* Tabular figures on the value — Meta values are nearly always
       *  counts (step NN) or positions (etag hash, NN / NN). Keeps
       *  numbers column-locked across re-renders. Per
       *  docs/09-ui-and-brand.md §Typography rule 2. */}
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{v}</span>
    </span>
  );
}
