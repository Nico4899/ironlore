import type { CSSProperties, ReactNode } from "react";

/**
 * SectionLabel — the canvas-grammar header.
 *
 * Renders, inline on one baseline:
 *
 *   01  <Title>  ──────────────────────────────────  <meta>
 *
 * The zero-padded index (mono, muted) anchors the left. The title is
 * Inter 600 at 12 px. A 1 px `--il-border-soft` hairline runs *inline*
 * between the title and the meta cluster — filling the remaining
 * space — so the label reads like a technical-drawing section marker,
 * not a form field. Meta is JetBrains Mono uppercase.
 *
 * Exact shape matches the JSX canonical `SectionLabel` in
 * `shell.jsx`/`screen-home.jsx`. The `rule={false}` opt-out now
 * suppresses the inline hairline (rare — dense stacks of adjacent
 * labels are the only case that benefits).
 *
 * Per docs/09-ui-and-brand.md §Canvas grammar.
 */

export interface SectionLabelProps {
  /** Section index — rendered zero-padded to 2 chars. */
  index: number;
  /** Section title (Inter 600). */
  title: ReactNode;
  /** Optional meta cluster (mono uppercase) at the right edge. */
  meta?: ReactNode;
  /** Suppress the inline hairline between title and meta. Default true. */
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
        gap: 10,
        marginBottom: 10,
        ...style,
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10.5,
          letterSpacing: "0.08em",
          color: "var(--il-text4)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {padded}
      </span>
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: "-0.005em",
          color: "var(--il-text)",
        }}
      >
        {title}
      </span>
      {rule && (
        <span
          aria-hidden="true"
          style={{
            flex: 1,
            height: 1,
            alignSelf: "center",
            background: "var(--il-border-soft)",
          }}
        />
      )}
      {!rule && <span style={{ flex: 1 }} />}
      {meta && (
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
      )}
    </div>
  );
}
