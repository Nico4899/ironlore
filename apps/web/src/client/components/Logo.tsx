import { CIRCLE_A, CIRCLE_B, CIRCLE_C, LOGO_R, REULEAUX_PATH } from "./primitives/logo-geometry.js";

/**
 * The Ironlore mark — three overlapping circles arranged in a
 * Venn-diagram pattern. The Reuleaux triangle at the center is filled
 * with Ironlore Blue; the circles themselves are stroked.
 *
 * Geometry is imported from `logo-geometry.ts` so the mark, the status
 * pip (Reuleaux), and the Venn watermark can never drift apart.
 */
interface LogoProps {
  size?: number;
  className?: string;
}

export function Logo({ size = 20, className }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      role="img"
      aria-label="Ironlore"
      fill="none"
    >
      <title>Ironlore</title>
      <path d={REULEAUX_PATH} fill="var(--color-ironlore-blue)" />
      <circle {...CIRCLE_A} r={LOGO_R} stroke="var(--color-primary)" strokeWidth={1.25} />
      <circle {...CIRCLE_B} r={LOGO_R} stroke="var(--color-primary)" strokeWidth={1.25} />
      <circle {...CIRCLE_C} r={LOGO_R} stroke="var(--color-primary)" strokeWidth={1.25} />
    </svg>
  );
}
