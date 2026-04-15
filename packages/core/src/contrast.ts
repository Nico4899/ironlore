/**
 * WCAG 2.1 contrast computation for OKLCh tokens.
 *
 * The brand palette is defined in OKLCh for perceptual uniformity but
 * WCAG scores contrast on sRGB relative luminance. This module converts
 * OKLCh → linear-RGB → relative luminance and applies the WCAG 2 contrast
 * formula so every `ironlore-blue on background` pair can be asserted
 * in a unit test instead of eyeballed.
 *
 * The conversion follows the OKLab whitepaper (Ottosson 2020) and the
 * sRGB gamma companding used by WCAG. This is a standalone port — it
 * deliberately doesn't pull in `culori` or `color.js` so the core
 * package stays dependency-light.
 */

/** Minimum WCAG 2.1 AA contrast for body text on its background. */
export const WCAG_AA_TEXT = 4.5;
/**
 * Minimum WCAG 2.1 AA contrast for large text (≥18px, or ≥14px bold) and
 * for UI components / graphical objects that convey meaning.
 */
export const WCAG_AA_LARGE = 3.0;

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

/**
 * Parse an `oklch(L C H)` string. Tolerates optional `/` alpha which we
 * ignore — contrast is computed against the solid color; callers
 * wanting to evaluate transparency should composite against a base
 * themselves and pass the result.
 */
export function parseOklch(input: string): Oklch {
  const match = /oklch\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)/i.exec(input.trim());
  if (!match) throw new Error(`contrast: cannot parse OKLCh value ${JSON.stringify(input)}`);
  return {
    l: Number.parseFloat(match[1] ?? "0"),
    c: Number.parseFloat(match[2] ?? "0"),
    h: Number.parseFloat(match[3] ?? "0"),
  };
}

function oklchToOklab({ l, c, h }: Oklch): { L: number; a: number; b: number } {
  const hRad = (h * Math.PI) / 180;
  return { L: l, a: c * Math.cos(hRad), b: c * Math.sin(hRad) };
}

function oklabToLinearSrgb({ L, a, b }: { L: number; a: number; b: number }): {
  r: number;
  g: number;
  b: number;
} {
  // Inverse of the matrix from the OKLab paper.
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

/**
 * WCAG sRGB gamma companding: linear → sRGB. Used here for clamping
 * during out-of-gamut handling; the luminance formula itself consumes
 * the linear value directly.
 */
function clamp(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * Relative luminance per WCAG 2.1 (§2.2.3). Expects linear-light
 * channel values in [0, 1]; the gamma step is implicit because we
 * start from linear-RGB.
 */
function relativeLuminance(r: number, g: number, b: number): number {
  const R = clamp(r);
  const G = clamp(g);
  const B = clamp(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/**
 * Contrast ratio between two OKLCh colors per WCAG 2.1 (§1.4.3).
 *
 * `(L1 + 0.05) / (L2 + 0.05)` where L1 is the lighter of the two
 * relative luminances. Range is [1, 21].
 */
export function contrastRatio(a: Oklch | string, b: Oklch | string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

function luminance(color: Oklch | string): number {
  const parsed = typeof color === "string" ? parseOklch(color) : color;
  const linear = oklabToLinearSrgb(oklchToOklab(parsed));
  return relativeLuminance(linear.r, linear.g, linear.b);
}

/**
 * Convenience: does `fg` over `bg` meet the given WCAG threshold?
 */
export function meetsContrast(fg: Oklch | string, bg: Oklch | string, threshold: number): boolean {
  return contrastRatio(fg, bg) >= threshold;
}
