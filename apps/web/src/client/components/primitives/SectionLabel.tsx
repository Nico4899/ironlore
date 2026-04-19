import type { CSSProperties, ReactNode } from "react";

/**
 * SectionLabel — the canvas-grammar header.
 *
 * Renders:
 *   01  <Title>                                    <meta> · <meta>
 *   ─────────────────────────────────────────────────────────────
 *
 * The zero-padded index anchors the left. The title uses Inter 600
 * at body size. The meta cluster on the right sits in JetBrains Mono
 * uppercase. A 1px `--il-border-soft` hairline runs beneath.
 *
 * Per docs/09-ui-and-brand.md §Canvas grammar. Six to ten sections
 * per surface is the healthy range.
 */

export interface SectionLabelProps {
  /** Section index — rendered zero-padded to 2 chars. */
  index: number;
  /** Section title (Inter 600). */
  title: ReactNode;
  /** Optional meta cluster (mono uppercase) at the right edge. */
  meta?: ReactNode;
  /** Hide the hairline beneath. */
  rule?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function SectionLabel({
  index,
  title,
  meta,
  rule = true,
  className,
  style,
}: SectionLabelProps) {
  const padded = String(Math.max(0, index)).padStart(2, "0");
  return (
    <div
      className={className}
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 12,
        paddingBottom: 6,
        borderBottom: rule ? "1px solid var(--il-border-soft)" : undefined,
        marginBottom: 10,
        ...style,
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10.5,
          letterSpacing: "0.04em",
          color: "var(--il-text3)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {padded}
      </span>
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 14,
          fontWeight: 600,
          letterSpacing: "-0.01em",
          color: "var(--il-text)",
        }}
      >
        {title}
      </span>
      {meta && (
        <>
          <span style={{ flex: 1 }} />
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10.5,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: "var(--il-text3)",
            }}
          >
            {meta}
          </span>
        </>
      )}
    </div>
  );
}
