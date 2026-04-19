import type { CSSProperties, ReactNode } from "react";

/**
 * DisplayNum — large display numerals for dashboard stats.
 *
 * Per docs/09-ui-and-brand.md §Canvas grammar the "142 runs · 24h"
 * pattern pairs an oversized tabular numeral with a mono overline.
 * DisplayNum renders the numeral only; callers supply the overline /
 * trend line. Serif + italic is the "bold" variant's voice; sans is
 * the "safe" default.
 */

export interface DisplayNumProps {
  /** The number (or numeric string) to render. */
  children: ReactNode;
  /** Font size in px — the display hero beat. Defaults to 36. */
  size?: number;
  /** Swap to Instrument Serif for the bold/typographic voice. */
  serif?: boolean;
  /** Italicize — only meaningful when `serif` is true. */
  italic?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function DisplayNum({
  children,
  size = 36,
  serif = false,
  italic = false,
  className,
  style,
}: DisplayNumProps) {
  return (
    <span
      className={className}
      style={{
        fontFamily: serif ? "var(--font-display)" : "var(--font-sans)",
        fontWeight: serif ? 400 : 600,
        fontStyle: serif && italic ? "italic" : "normal",
        fontSize: size,
        lineHeight: 1,
        letterSpacing: "-0.025em",
        color: "var(--il-text)",
        fontVariantNumeric: "tabular-nums",
        ...style,
      }}
    >
      {children}
    </span>
  );
}
