import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  meetsContrast,
  parseOklch,
  WCAG_AA_LARGE,
  WCAG_AA_TEXT,
} from "./contrast.js";

/**
 * Contrast contract for the Ironlore palette.
 *
 * Values mirror the tokens in `apps/web/src/client/styles/globals.css`.
 * If a token changes in the stylesheet the corresponding literal here
 * must change too — that forces a conscious re-check of WCAG ratios
 * instead of silently drifting below the AA floor.
 *
 * Thresholds:
 *   - body text ≥ 4.5:1 (WCAG 2.1 AA §1.4.3)
 *   - UI components / large text ≥ 3:1  (WCAG 2.1 AA §1.4.11)
 */

const DARK = {
  background: "oklch(0.16 0.01 260)",
  slate: "oklch(0.22 0.015 260)",
  slateHover: "oklch(0.28 0.015 260)",
  primary: "oklch(0.96 0.005 260)",
  secondary: "oklch(0.68 0.015 260)",
  ironloreBlue: "oklch(0.65 0.18 258)",
  ironloreBlueStrong: "oklch(0.72 0.20 258)",
  signalAmber: "oklch(0.82 0.17 80)",
  signalRed: "oklch(0.62 0.22 25)",
  signalGreen: "oklch(0.72 0.17 148)",
  accentViolet: "oklch(0.68 0.17 300)",
  border: "oklch(0.32 0.01 260)",
  borderStrong: "oklch(0.52 0.020 260)",
};

const LIGHT = {
  background: "oklch(0.99 0.003 260)",
  slate: "oklch(0.95 0.008 260)",
  slateHover: "oklch(0.90 0.010 260)",
  primary: "oklch(0.18 0.01 260)",
  secondary: "oklch(0.42 0.012 260)",
  ironloreBlue: "oklch(0.55 0.20 258)",
  ironloreBlueStrong: "oklch(0.48 0.22 258)",
  signalAmber: "oklch(0.68 0.17 75)",
  signalRed: "oklch(0.55 0.22 25)",
  signalGreen: "oklch(0.56 0.17 148)",
  accentViolet: "oklch(0.55 0.20 300)",
  border: "oklch(0.82 0.010 260)",
  borderStrong: "oklch(0.72 0.015 260)",
};

describe("parseOklch", () => {
  it("parses L C H triplets", () => {
    expect(parseOklch("oklch(0.5 0.1 200)")).toEqual({ l: 0.5, c: 0.1, h: 200 });
  });

  it("accepts extra whitespace", () => {
    expect(parseOklch("  oklch(  0.3   0.05   120  )")).toEqual({ l: 0.3, c: 0.05, h: 120 });
  });

  it("throws on malformed input", () => {
    expect(() => parseOklch("rgb(1,2,3)")).toThrow();
  });
});

describe("contrastRatio", () => {
  it("returns 21 for pure black on pure white", () => {
    const ratio = contrastRatio("oklch(1 0 0)", "oklch(0 0 0)");
    expect(ratio).toBeGreaterThan(20.5);
  });

  it("returns 1 for identical colors", () => {
    const ratio = contrastRatio("oklch(0.5 0.1 200)", "oklch(0.5 0.1 200)");
    expect(ratio).toBeCloseTo(1, 3);
  });

  it("is symmetric in its arguments", () => {
    const a = contrastRatio(DARK.primary, DARK.background);
    const b = contrastRatio(DARK.background, DARK.primary);
    expect(a).toBeCloseTo(b, 6);
  });
});

describe("Dark palette — AA body text (≥4.5:1)", () => {
  it("primary text on background", () => {
    expect(meetsContrast(DARK.primary, DARK.background, WCAG_AA_TEXT)).toBe(true);
  });

  it("primary text on slate (chrome surfaces)", () => {
    expect(meetsContrast(DARK.primary, DARK.slate, WCAG_AA_TEXT)).toBe(true);
  });

  it("primary text on slate-hover", () => {
    expect(meetsContrast(DARK.primary, DARK.slateHover, WCAG_AA_TEXT)).toBe(true);
  });

  it("secondary text on background", () => {
    expect(meetsContrast(DARK.secondary, DARK.background, WCAG_AA_TEXT)).toBe(true);
  });

  it("secondary text on slate", () => {
    expect(meetsContrast(DARK.secondary, DARK.slate, WCAG_AA_TEXT)).toBe(true);
  });
});

describe("Dark palette — AA UI components and accents (≥3:1)", () => {
  it("ironlore-blue on background (focus ring / active tab stripe)", () => {
    expect(meetsContrast(DARK.ironloreBlue, DARK.background, WCAG_AA_LARGE)).toBe(true);
  });

  it("ironlore-blue-strong on background (pressed states)", () => {
    expect(meetsContrast(DARK.ironloreBlueStrong, DARK.background, WCAG_AA_LARGE)).toBe(true);
  });

  it("signal-amber on background (offline banner)", () => {
    expect(meetsContrast(DARK.signalAmber, DARK.background, WCAG_AA_LARGE)).toBe(true);
  });

  it("signal-red on background (error states)", () => {
    expect(meetsContrast(DARK.signalRed, DARK.background, WCAG_AA_LARGE)).toBe(true);
  });

  it("signal-green on background (success / connected)", () => {
    expect(meetsContrast(DARK.signalGreen, DARK.background, WCAG_AA_LARGE)).toBe(true);
  });

  it("accent-violet on background (AI surfaces)", () => {
    expect(meetsContrast(DARK.accentViolet, DARK.background, WCAG_AA_LARGE)).toBe(true);
  });

  it("border-strong on background (visible separators)", () => {
    expect(meetsContrast(DARK.borderStrong, DARK.background, WCAG_AA_LARGE)).toBe(true);
  });
});

describe("Light palette — AA body text (≥4.5:1)", () => {
  it("primary text on background", () => {
    expect(meetsContrast(LIGHT.primary, LIGHT.background, WCAG_AA_TEXT)).toBe(true);
  });

  it("primary text on slate", () => {
    expect(meetsContrast(LIGHT.primary, LIGHT.slate, WCAG_AA_TEXT)).toBe(true);
  });

  it("primary text on slate-hover", () => {
    expect(meetsContrast(LIGHT.primary, LIGHT.slateHover, WCAG_AA_TEXT)).toBe(true);
  });

  it("secondary text on background", () => {
    expect(meetsContrast(LIGHT.secondary, LIGHT.background, WCAG_AA_TEXT)).toBe(true);
  });

  it("secondary text on slate", () => {
    expect(meetsContrast(LIGHT.secondary, LIGHT.slate, WCAG_AA_TEXT)).toBe(true);
  });
});

describe("Light palette — AA UI components and accents (≥3:1)", () => {
  it("ironlore-blue on background", () => {
    expect(meetsContrast(LIGHT.ironloreBlue, LIGHT.background, WCAG_AA_LARGE)).toBe(true);
  });

  it("signal-red on background", () => {
    expect(meetsContrast(LIGHT.signalRed, LIGHT.background, WCAG_AA_LARGE)).toBe(true);
  });
});
