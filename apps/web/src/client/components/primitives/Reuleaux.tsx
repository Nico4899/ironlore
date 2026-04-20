/**
 * Reuleaux — the Ironlore universal status pip.
 *
 * The Reuleaux triangle formed by three overlapping circles of radius
 * 6 centered on an equilateral triangle of side ≈ 7.27 (viewBox 0 0 32
 * 32). This is the one shape used for status across the entire
 * product: loading, running, healthy, warn, error, paused. Replaces
 * every plain colored dot.
 *
 * Per docs/09-ui-and-brand.md §Signature motifs / Reuleaux.
 */

import type { CSSProperties } from "react";
import { REULEAUX_PATH } from "./logo-geometry.js";

export interface ReuleauxProps {
  /** Rendered pixel size. Spec recommends 7–10px for status pips. */
  size?: number;
  /** Fill color. Accepts any CSS color / token var. */
  color?: string;
  /** Apply the 2s ilSpin rotation — running state. */
  spin?: boolean;
  /** Render at half opacity — paused state. */
  dim?: boolean;
  /** Apply the 3s 2-step opacity pulse — error state. */
  pulse?: boolean;
  /** Optional ARIA label. When omitted the pip is decorative. */
  "aria-label"?: string;
  className?: string;
  style?: CSSProperties;
}

export function Reuleaux({
  size = 10,
  color = "currentColor",
  spin = false,
  dim = false,
  pulse = false,
  className,
  style,
  ...rest
}: ReuleauxProps) {
  const hasLabel = typeof rest["aria-label"] === "string";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role={hasLabel ? "img" : undefined}
      aria-hidden={hasLabel ? undefined : true}
      aria-label={rest["aria-label"]}
      className={[spin ? "il-spin" : "", pulse ? "il-error" : "", className]
        .filter(Boolean)
        .join(" ")}
      style={{
        display: "inline-block",
        verticalAlign: "middle",
        opacity: dim ? 0.5 : undefined,
        ...style,
      }}
    >
      <path d={REULEAUX_PATH} fill={color} />
    </svg>
  );
}
