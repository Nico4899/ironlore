import { type CSSProperties, useEffect, useRef } from "react";

/**
 * DottedHead — a 3D head silhouette rendered as a point cloud that
 * gently rotates toward the pointer. Replaces the Venn emblem on the
 * Agent detail hero so each agent has a live, hue-reactive avatar
 * instead of the generic three-ring motif.
 *
 * Geometry is a Fibonacci-sphere-sampled ovoid, tapered toward the
 * chin and elongated vertically so the silhouette reads as humanoid
 * at a glance. The default color (`var(--il-blue)`) is driven by
 * `--il-accent-hue`, so changing the hue setting recolors the head
 * live — we re-resolve the CSS variable once per frame.
 *
 * Motion respects `html[data-motion]`: `none` freezes the head
 * forward-facing with no mouse tracking; `reduced` snaps toward the
 * target each frame without easing; `full` eases smoothly.
 */

export interface DottedHeadProps {
  /** Rendered pixel size. Square. */
  size?: number;
  /** Dot color — CSS color string or `var(...)` token. */
  color?: string;
  /** Accessibility label. When omitted the canvas is decorative. */
  "aria-label"?: string;
  className?: string;
  style?: CSSProperties;
}

/** Total number of surface points sampled on the head shape. */
const POINT_COUNT = 360;
/** Maximum yaw (rad) when the pointer is at a screen edge. ~23°. */
const MAX_YAW = 0.4;
/** Maximum pitch (rad) when the pointer is at a screen edge. ~17°. */
const MAX_PITCH = 0.3;
/** Per-frame lerp factor for smooth tracking in `full` motion. */
const EASE_FULL = 0.12;

/**
 * Fibonacci-sphere surface sampling with a head-silhouette warp:
 *   · elongate vertically by 1.15× so the ovoid reads as a head
 *   · taper the lower half toward the chin (Y<0) so the bottom
 *     narrows into a jaw rather than rounding off like an egg
 *   · compress depth to 0.78 so side-on views still read round
 */
function generateHeadPoints(): Float32Array {
  const out = new Float32Array(POINT_COUNT * 3);
  const phi = Math.PI * (Math.sqrt(5) - 1);
  for (let i = 0; i < POINT_COUNT; i++) {
    const y = 1 - (i / (POINT_COUNT - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = phi * i;
    const sx = Math.cos(theta) * r;
    const sz = Math.sin(theta) * r;
    // Chin taper: points below the equator shrink horizontally.
    const taper = y < 0 ? 1 + y * 0.38 : 1;
    out[i * 3] = sx * taper * 0.82;
    out[i * 3 + 1] = y * 1.15;
    out[i * 3 + 2] = sz * taper * 0.78;
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Resolve `var(--token)` against :root. Returns the fallback on any
 * miss so the canvas never paints with an empty string (which would
 * silently skip `fill()` in some browsers).
 */
function resolveColor(input: string, fallback = "#6aa0ff"): string {
  if (!input.startsWith("var(")) return input;
  const match = /var\(\s*(--[\w-]+)/.exec(input);
  if (!match?.[1]) return fallback;
  const resolved = getComputedStyle(document.documentElement)
    .getPropertyValue(match[1])
    .trim();
  return resolved || fallback;
}

export function DottedHead({
  size = 96,
  color = "var(--il-blue)",
  className,
  style,
  ...rest
}: DottedHeadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hasLabel = typeof rest["aria-label"] === "string";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const points = generateHeadPoints();

    // Target and current rotation. Eased toward target each frame so
    //  the head arrives smoothly rather than tracking the pointer 1:1.
    const rot = { yawCur: 0, pitchCur: 0, yawTgt: 0, pitchTgt: 0 };

    let motion = document.documentElement.getAttribute("data-motion") ?? "full";

    const onMove = (e: MouseEvent) => {
      if (motion === "none") return;
      const rect = canvas.getBoundingClientRect();
      const cxs = rect.left + rect.width / 2;
      const cys = rect.top + rect.height / 2;
      const dx = (e.clientX - cxs) / (window.innerWidth / 2);
      const dy = (e.clientY - cys) / (window.innerHeight / 2);
      rot.yawTgt = clamp(dx, -1, 1) * MAX_YAW;
      rot.pitchTgt = clamp(dy, -1, 1) * MAX_PITCH;
    };

    // A MutationObserver lets us react live if the user flips motion
    //  in Settings while the detail page is open. Cheap — one attr.
    const mo = new MutationObserver(() => {
      motion = document.documentElement.getAttribute("data-motion") ?? "full";
      if (motion === "none") {
        rot.yawTgt = 0;
        rot.pitchTgt = 0;
      }
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });

    const radius = size * 0.42;
    const centre = size / 2;
    let rafId: number | null = null;
    const projected: Array<{ x: number; y: number; z: number }> = new Array(POINT_COUNT);
    for (let i = 0; i < POINT_COUNT; i++) projected[i] = { x: 0, y: 0, z: 0 };

    const draw = () => {
      // Ease current → target. `reduced` snaps (ease = 1) so the head
      //  still responds without the smoothing animation; `none` freezes.
      const ease = motion === "full" ? EASE_FULL : motion === "reduced" ? 1 : 0;
      if (ease > 0) {
        rot.yawCur += (rot.yawTgt - rot.yawCur) * ease;
        rot.pitchCur += (rot.pitchTgt - rot.pitchCur) * ease;
      }

      const cosY = Math.cos(rot.yawCur);
      const sinY = Math.sin(rot.yawCur);
      const cosP = Math.cos(rot.pitchCur);
      const sinP = Math.sin(rot.pitchCur);

      for (let i = 0; i < POINT_COUNT; i++) {
        const x0 = points[i * 3] as number;
        const y0 = points[i * 3 + 1] as number;
        const z0 = points[i * 3 + 2] as number;
        // Yaw rotates around Y (horizontal sweep).
        const x1 = x0 * cosY + z0 * sinY;
        const z1 = -x0 * sinY + z0 * cosY;
        // Pitch rotates around X (vertical nod). Screen Y points down,
        //  so we subtract in the projection step.
        const y1 = y0 * cosP - z1 * sinP;
        const z2 = y0 * sinP + z1 * cosP;
        const p = projected[i];
        if (p) {
          p.x = x1;
          p.y = y1;
          p.z = z2;
        }
      }

      // Painter's-algorithm sort: back-to-front so near points cover
      //  far ones. Small N so this is negligible each frame.
      projected.sort((a, b) => a.z - b.z);

      const fill = resolveColor(color);
      ctx.clearRect(0, 0, size, size);
      ctx.fillStyle = fill;

      for (let i = 0; i < POINT_COUNT; i++) {
        const p = projected[i];
        if (!p) continue;
        // Depth cue: near dots are bigger and opaque; far dots fade.
        const depth = (p.z + 1) / 2;
        const dotSize = 0.9 + depth * 1.7;
        const alpha = 0.28 + depth * 0.72;
        const sx = centre + p.x * radius;
        const sy = centre - p.y * radius;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(sx, sy, dotSize, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      rafId = requestAnimationFrame(draw);
    };

    draw();
    window.addEventListener("mousemove", onMove, { passive: true });

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener("mousemove", onMove);
      mo.disconnect();
    };
  }, [size, color]);

  return (
    <canvas
      ref={canvasRef}
      role={hasLabel ? "img" : undefined}
      aria-hidden={hasLabel ? undefined : true}
      aria-label={rest["aria-label"]}
      className={className}
      style={{ display: "inline-block", width: size, height: size, ...style }}
    />
  );
}
