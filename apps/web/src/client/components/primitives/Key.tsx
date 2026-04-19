import type { CSSProperties, ReactNode } from "react";

/**
 * Key — the unified keyboard-hint chip.
 *
 * Before this component we rendered `kbd` chips 4 different ways across
 * InboxPanel, SearchDialog, and the header. Key folds them together:
 * mono 10px, slate-elev background, soft-border outline, slight
 * tracking. Callers pass the glyph(s) they want to show.
 *
 * Per docs/09-ui-and-brand.md §Keyboard hints.
 */

export interface KeyProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function Key({ children, className, style }: KeyProps) {
  return (
    <kbd
      className={className}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        letterSpacing: "0.02em",
        color: "var(--il-text2)",
        background: "var(--il-slate-elev)",
        border: "1px solid var(--il-border-soft)",
        padding: "1px 5px",
        borderRadius: 3,
        display: "inline-flex",
        alignItems: "center",
        ...style,
      }}
    >
      {children}
    </kbd>
  );
}
