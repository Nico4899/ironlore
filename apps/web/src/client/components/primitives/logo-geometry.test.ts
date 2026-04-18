import { describe, expect, it } from "vitest";
import {
  CIRCLE_A,
  CIRCLE_B,
  CIRCLE_C,
  LOGO_CX,
  LOGO_CY,
  LOGO_OFFSET,
  LOGO_R,
  REULEAUX_PATH,
} from "./logo-geometry.js";

/**
 * Guard the canonical logo geometry. Reuleaux, Venn, and Logo all pull
 * from this file; if a future refactor changes a number but only
 * touches one consumer, the pip + watermark + header logo visibly
 * disagree. These tests lock in the published numbers so the moment a
 * swap breaks the Venn/Reuleaux harmony, CI flags it.
 */
describe("logo-geometry", () => {
  it("centers the mark on the 32×32 viewBox", () => {
    expect(LOGO_CX).toBe(16);
    expect(LOGO_CY).toBe(16);
  });

  it("spaces the three circles as an equilateral triangle", () => {
    // Two bottom centers share y and are 2·offset apart on x.
    expect(CIRCLE_A.cy).toBeCloseTo(CIRCLE_B.cy);
    expect(CIRCLE_B.cx - CIRCLE_A.cx).toBeCloseTo(2 * LOGO_OFFSET);

    // Top center sits directly above the midpoint of the other two.
    expect(CIRCLE_C.cx).toBe(LOGO_CX);
    expect(CIRCLE_C.cy).toBeLessThan(CIRCLE_A.cy);

    // Equilateral check: pairwise distances are within floating-point
    // tolerance. The ratio of vertical separation to horizontal is the
    // √3 offset implied by an equilateral layout.
    const dAB = Math.hypot(CIRCLE_B.cx - CIRCLE_A.cx, CIRCLE_B.cy - CIRCLE_A.cy);
    const dAC = Math.hypot(CIRCLE_C.cx - CIRCLE_A.cx, CIRCLE_C.cy - CIRCLE_A.cy);
    expect(dAC).toBeCloseTo(dAB, 1);
  });

  it("traces a closed Reuleaux path starting above center", () => {
    expect(REULEAUX_PATH.startsWith(`M ${LOGO_CX},${LOGO_CY - LOGO_OFFSET / 2}`)).toBe(true);
    expect(REULEAUX_PATH.endsWith("Z")).toBe(true);
    // Three arcs — one per edge of the Reuleaux triangle.
    expect(REULEAUX_PATH.split(" A ")).toHaveLength(4);
  });

  it("uses a radius large enough that circles overlap", () => {
    // Overlap happens when the distance between any two circle centers
    // is < 2·R. The design depends on this — if someone bumps R down
    // past the offset, the logo falls apart.
    const dAB = Math.hypot(CIRCLE_B.cx - CIRCLE_A.cx, CIRCLE_B.cy - CIRCLE_A.cy);
    expect(dAB).toBeLessThan(2 * LOGO_R);
  });
});
