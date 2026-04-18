/**
 * Canonical geometry for the Ironlore logo / Venn / Reuleaux primitives.
 *
 * Centralizing the numbers here keeps every rendering (favicon, header
 * logo, status pip, onboarding watermark) tracing the same triangle. If
 * a future design tweak changes the offsets, it lands in one place.
 */

export const LOGO_CX = 16;
export const LOGO_CY = 16;
export const LOGO_R = 6;
export const LOGO_OFFSET = 4.2;

// Bottom-left, bottom-right, and top circle centers of the Venn layout.
export const CIRCLE_A = { cx: LOGO_CX - LOGO_OFFSET, cy: LOGO_CY + LOGO_OFFSET * 0.577 };
export const CIRCLE_B = { cx: LOGO_CX + LOGO_OFFSET, cy: LOGO_CY + LOGO_OFFSET * 0.577 };
export const CIRCLE_C = { cx: LOGO_CX, cy: LOGO_CY - LOGO_OFFSET * 1.155 };

/** SVG path commands for the filled Reuleaux triangle at the center. */
export const REULEAUX_PATH = [
  `M ${LOGO_CX},${LOGO_CY - LOGO_OFFSET / 2}`,
  `A ${LOGO_R},${LOGO_R} 0 0 1 ${LOGO_CX + LOGO_OFFSET / 2},${LOGO_CY + LOGO_OFFSET * 0.289}`,
  `A ${LOGO_R},${LOGO_R} 0 0 1 ${LOGO_CX - LOGO_OFFSET / 2},${LOGO_CY + LOGO_OFFSET * 0.289}`,
  `A ${LOGO_R},${LOGO_R} 0 0 1 ${LOGO_CX},${LOGO_CY - LOGO_OFFSET / 2}`,
  "Z",
].join(" ");
