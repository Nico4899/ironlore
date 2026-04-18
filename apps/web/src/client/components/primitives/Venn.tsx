/**
 * Venn — three overlapping rings around a filled Reuleaux center.
 *
 * The expanded-scale companion to the logo. Reserved for exactly three
 * surfaces per docs/09-ui-and-brand.md §Signature motifs / Venn:
 *   · onboarding watermark
 *   · agent-detail hero
 *   · empty states
 *
 * Never a spinner, never decoration, never a tile. If you find yourself
 * reaching for Venn elsewhere, use Reuleaux instead.
 */

import type { CSSProperties } from "react";
import { CIRCLE_A, CIRCLE_B, CIRCLE_C, LOGO_R, REULEAUX_PATH } from "./logo-geometry.js";

export interface VennProps {
  /** Rendered pixel size — design recommends 80–280. */
  size?: number;
  /** Fill of the central Reuleaux triangle. Accepts any token var. */
  fill?: string;
  /** Stroke color for the three circles. */
  color?: string;
  /** Stroke width for the three circles. */
  lineWidth?: number;
  /** Opacity applied to the three outer rings only. */
  ringOpacity?: number;
  /** Opacity applied to the Reuleaux center only. */
  fillOpacity?: number;
  /** Accessibility label. When omitted the SVG is decorative. */
  "aria-label"?: string;
  className?: string;
  style?: CSSProperties;
}

export function Venn({
  size = 80,
  fill = "var(--il-blue)",
  color = "var(--il-text2)",
  lineWidth = 0.8,
  ringOpacity = 0.8,
  fillOpacity = 0.9,
  className,
  style,
  ...rest
}: VennProps) {
  const hasLabel = typeof rest["aria-label"] === "string";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role={hasLabel ? "img" : undefined}
      aria-hidden={hasLabel ? undefined : true}
      aria-label={rest["aria-label"]}
      className={className}
      style={{ display: "inline-block", ...style }}
    >
      <path d={REULEAUX_PATH} fill={fill} opacity={fillOpacity} />
      <circle
        cx={CIRCLE_A.cx}
        cy={CIRCLE_A.cy}
        r={LOGO_R}
        stroke={color}
        strokeWidth={lineWidth}
        opacity={ringOpacity}
      />
      <circle
        cx={CIRCLE_B.cx}
        cy={CIRCLE_B.cy}
        r={LOGO_R}
        stroke={color}
        strokeWidth={lineWidth}
        opacity={ringOpacity}
      />
      <circle
        cx={CIRCLE_C.cx}
        cy={CIRCLE_C.cy}
        r={LOGO_R}
        stroke={color}
        strokeWidth={lineWidth}
        opacity={ringOpacity}
      />
    </svg>
  );
}
