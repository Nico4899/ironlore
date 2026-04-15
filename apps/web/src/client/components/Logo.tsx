/**
 * The Ironlore mark — three overlapping circles arranged in a
 * Venn-diagram pattern. The Reuleaux triangle at the center is filled
 * with Ironlore Blue; the circles themselves are stroked.
 *
 * Rendered via CSS custom properties so the mark picks up the current
 * theme's Ironlore Blue and text-primary values. The geometry is
 * intentionally plain so the same SVG works at 16px (favicon) and
 * 32px (header) without detail loss.
 */
interface LogoProps {
  size?: number;
  className?: string;
}

export function Logo({ size = 20, className }: LogoProps) {
  // Equilateral triangle centers, radius chosen so each pair intersects
  // through the opposite vertex — the classic Venn / Reuleaux layout.
  const cx = 16;
  const cy = 16;
  const r = 6;
  const offset = 4.2;
  const c1 = { cx: cx - offset, cy: cy + offset * 0.577 };
  const c2 = { cx: cx + offset, cy: cy + offset * 0.577 };
  const c3 = { cx: cx, cy: cy - offset * 1.155 };

  // Reuleaux triangle at the three mutual intersections.
  const tri = [
    `M ${cx},${cy - offset / 2}`,
    `A ${r},${r} 0 0 1 ${cx + offset / 2},${cy + offset * 0.289}`,
    `A ${r},${r} 0 0 1 ${cx - offset / 2},${cy + offset * 0.289}`,
    `A ${r},${r} 0 0 1 ${cx},${cy - offset / 2}`,
    "Z",
  ].join(" ");

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
      <path d={tri} fill="var(--color-ironlore-blue)" />
      <circle {...c1} r={r} stroke="var(--color-primary)" strokeWidth={1.25} />
      <circle {...c2} r={r} stroke="var(--color-primary)" strokeWidth={1.25} />
      <circle {...c3} r={r} stroke="var(--color-primary)" strokeWidth={1.25} />
    </svg>
  );
}
