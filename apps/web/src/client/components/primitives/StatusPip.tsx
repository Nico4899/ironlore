import type { CSSProperties } from "react";
import { Reuleaux } from "./Reuleaux.js";

/**
 * StatusPip — Reuleaux + optional mono label.
 *
 * The canonical way to show state anywhere in the product. The six
 * states each map to a deterministic color (idle/paused are muted,
 * running is blue with rotation, healthy is green, warn is amber,
 * error is red). Wraps Reuleaux so it always stays consistent — no
 * one-off dots.
 *
 * Per docs/09-ui-and-brand.md §Reuleaux state table.
 */

export type PipState = "idle" | "running" | "healthy" | "warn" | "error" | "paused" | "rate";

export interface StatusPipProps {
  state?: PipState;
  /** Optional label rendered in JetBrains Mono uppercase. */
  label?: string;
  /** Pip size in px. Defaults to 10 (spec's upper-end for a pip). */
  size?: number;
  /** Accessibility label — exposed only when no visible label is given. */
  "aria-label"?: string;
  className?: string;
  style?: CSSProperties;
}

const STATE_COLOR: Record<PipState, string> = {
  idle: "var(--il-text3)",
  running: "var(--il-blue)",
  healthy: "var(--il-green)",
  warn: "var(--il-amber)",
  error: "var(--il-red)",
  paused: "var(--il-text3)",
  rate: "var(--il-amber)",
};

export function StatusPip({
  state = "idle",
  label,
  size = 10,
  className,
  style,
  "aria-label": ariaLabel,
}: StatusPipProps) {
  const color = STATE_COLOR[state];
  const resolvedAriaLabel = ariaLabel ?? (label ? undefined : state);
  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        color: "var(--il-text2)",
        ...style,
      }}
    >
      <Reuleaux
        size={size}
        color={color}
        spin={state === "running"}
        dim={state === "paused"}
        pulse={state === "error"}
        aria-label={resolvedAriaLabel}
      />
      {label && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            color: "var(--il-text2)",
          }}
        >
          {label}
        </span>
      )}
    </span>
  );
}
