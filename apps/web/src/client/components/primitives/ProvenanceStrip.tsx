import type { CSSProperties, ReactNode } from "react";
import { Reuleaux } from "./Reuleaux.js";

/**
 * ProvenanceStrip — the mono metadata bar above an agent-authored
 * block.
 *
 * Shape (left → right):
 *   ◆  <agent>  /  <timestamp>  /  sources  <chip> <chip> …    ● TRUST
 *
 * The whole bar is mono 10.5px uppercase. The trust badge at the
 * right glows 6px in its badge color (green / amber / grey).
 *
 * The strip is suppressed entirely when no provenance record exists —
 * callers pass `sources={[]}` with no agent only if they also expect
 * the strip to render nothing.
 *
 * Per docs/09-ui-and-brand.md §Signature motifs / Provenance strip.
 */

export type TrustState = "fresh" | "stale" | "unverified";

export interface ProvenanceStripProps {
  /** Agent slug (e.g. `docs-curator`). */
  agent: string;
  /** Relative timestamp — string, caller formats it (e.g. "2m ago"). */
  timestamp: string;
  /** Source chips (usually `[[page#blk]]` strings). */
  sources?: ReactNode[];
  /** Trust level — affects the right-hand badge. */
  trust?: TrustState;
  /** Optional click handler (whole strip is clickable). */
  onClick?: () => void;
  className?: string;
  style?: CSSProperties;
}

const TRUST_META: Record<TrustState, { color: string; label: string }> = {
  fresh: { color: "var(--il-green)", label: "FRESH" },
  stale: { color: "var(--il-amber)", label: "STALE" },
  unverified: { color: "var(--il-text3)", label: "UNVERIFIED" },
};

export function ProvenanceStrip({
  agent,
  timestamp,
  sources = [],
  trust = "fresh",
  onClick,
  className,
  style,
}: ProvenanceStripProps) {
  const { color: trustColor, label: trustLabel } = TRUST_META[trust];

  return (
    <div
      role="note"
      aria-label={`Authored by ${agent}, ${timestamp}, trust ${trustLabel}`}
      onClick={onClick}
      onKeyDown={onClick ? (e) => e.key === "Enter" && onClick() : undefined}
      tabIndex={onClick ? 0 : undefined}
      className={["il-provenance-strip", className].filter(Boolean).join(" ")}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "7px 10px",
        background: "color-mix(in oklch, var(--il-blue) 6%, transparent)",
        borderLeft: "2px solid var(--il-blue)",
        borderRadius: "0 3px 3px 0",
        fontFamily: "var(--font-mono)",
        fontSize: 10.5,
        color: "var(--il-text2)",
        letterSpacing: "0.02em",
        textTransform: "uppercase",
        cursor: onClick ? "pointer" : undefined,
        ...style,
      }}
    >
      <Reuleaux size={8} color="var(--il-blue)" />
      <span style={{ color: "var(--il-text)" }}>{agent}</span>
      <span style={{ color: "var(--il-text4)" }}>/</span>
      <span>{timestamp}</span>
      {sources.length > 0 && (
        <>
          <span style={{ color: "var(--il-text4)" }}>/</span>
          <span>sources</span>
          {sources.map((chip, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: chip identity is positional
              key={i}
              style={{
                padding: "1px 5px",
                background: "var(--il-slate-elev)",
                border: "1px solid var(--il-border-soft)",
                borderRadius: 2,
                color: "var(--il-text)",
                textTransform: "none",
              }}
            >
              {chip}
            </span>
          ))}
        </>
      )}
      <span style={{ flex: 1 }} />
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          color: trustColor,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: trustColor,
            boxShadow: `0 0 6px ${trustColor}`,
          }}
        />
        {trustLabel}
      </span>
    </div>
  );
}
