import { type CSSProperties, useEffect, useRef } from "react";

/**
 * DottedHead — a humanoid head rendered as a point cloud of ~1,400
 * surface samples. Replaces the Venn emblem on the Agent detail hero
 * so each agent gets a live, hue-reactive avatar with real anatomy.
 *
 * How the mesh is built:
 *   · The head is a **union of procedurally-placed ellipsoids** —
 *     cranium, face plate, jaw, chin, nose bridge, nose tip, two
 *     ears, and a neck stub. Each ellipsoid is Fibonacci-sphere
 *     sampled on its own surface.
 *   · **Interior culling**: every sampled point is discarded if it
 *     falls inside any *other* body ellipsoid (scaled 0.97 for a
 *     soft seam). What survives is the outer envelope of the union
 *     — no internal dots, no ellipsoid-boundary ridges.
 *   · **Socket subtraction**: points inside the two eye sockets and
 *     the mouth-line groove are removed so the face reads with
 *     negative space where eyes and lips belong.
 *
 * The cloud is sampled once per module load and shared across every
 * instance; rendering is pure projection + painter's sort + alpha-
 * weighted dot draws.
 *
 * Default color (`var(--il-blue)`) tracks `--il-accent-hue` live —
 * the canvas re-resolves the CSS variable every frame so moving the
 * hue slider in Settings recolors the head immediately. Motion
 * respects `html[data-motion]`: `none` freezes forward-facing,
 * `reduced` snaps to the cursor target each frame, `full` eases.
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

/** Maximum yaw (rad) when the pointer is at a screen edge. ~23°. */
const MAX_YAW = 0.4;
/** Maximum pitch (rad) when the pointer is at a screen edge. ~17°. */
const MAX_PITCH = 0.3;
/** Per-frame lerp factor for smooth tracking in `full` motion. */
const EASE_FULL = 0.12;
/**
 * Y offset applied before projection so the head is visually centered
 * in the canvas frame — the model's Y extent is asymmetric (cranium
 * goes to +0.7, neck pulls to −1.2) so a naïve center(0,0) would
 * leave the head hugging the top edge.
 */
const Y_SHIFT = 0.24;

export interface Ellipsoid {
  cx: number;
  cy: number;
  cz: number;
  rx: number;
  ry: number;
  rz: number;
  count: number;
}

/**
 * Procedural head — every ellipsoid is axis-aligned in head-radius
 * units (cranium radius ~0.5). Counts are picked so dot density
 * stays roughly uniform per unit surface area, not per ellipsoid:
 * larger primitives get more points than smaller ones, and points
 * that fall in overlap regions are pruned by the builder.
 */
export const BODY: Ellipsoid[] = [
  // Cranium — back and top of the skull.
  { cx: 0, cy: 0.18, cz: -0.02, rx: 0.52, ry: 0.5, rz: 0.53, count: 520 },
  // Face plate — forward-shifted ellipsoid covering forehead, cheeks,
  //  temples. Overlaps the cranium intentionally so interior culling
  //  produces the blended front surface.
  { cx: 0, cy: -0.05, cz: 0.08, rx: 0.42, ry: 0.48, rz: 0.45, count: 320 },
  // Jaw — squat ellipsoid below the face plate; forms the lower
  //  skull silhouette and the mandible line.
  { cx: 0, cy: -0.42, cz: 0.08, rx: 0.3, ry: 0.28, rz: 0.38, count: 220 },
  // Chin — small protruding node at the bottom-front.
  { cx: 0, cy: -0.6, cz: 0.22, rx: 0.14, ry: 0.08, rz: 0.1, count: 50 },
  // Nose bridge — thin vertical ridge protruding forward.
  { cx: 0, cy: 0.03, cz: 0.44, rx: 0.055, ry: 0.22, rz: 0.12, count: 90 },
  // Nose tip — widens the bridge into a rounded tip.
  { cx: 0, cy: -0.18, cz: 0.55, rx: 0.09, ry: 0.07, rz: 0.12, count: 55 },
  // Left ear — flattened vertical ellipsoid on the side.
  { cx: -0.5, cy: -0.03, cz: -0.05, rx: 0.055, ry: 0.14, rz: 0.09, count: 80 },
  // Right ear — mirror of left.
  { cx: 0.5, cy: -0.03, cz: -0.05, rx: 0.055, ry: 0.14, rz: 0.09, count: 80 },
  // Neck stub — gives the composition a visual base.
  { cx: 0, cy: -0.9, cz: 0, rx: 0.22, ry: 0.3, rz: 0.22, count: 230 },
];

/**
 * Subtractive ellipsoids. Points that fall inside any socket are
 * removed during build — eye sockets produce dark concavities, and
 * the mouth groove carves a thin horizontal lip line.
 */
export const SOCKETS: Array<Omit<Ellipsoid, "count">> = [
  // Left eye socket.
  { cx: -0.18, cy: 0.05, cz: 0.38, rx: 0.085, ry: 0.055, rz: 0.06 },
  // Right eye socket.
  { cx: 0.18, cy: 0.05, cz: 0.38, rx: 0.085, ry: 0.055, rz: 0.06 },
  // Mouth — a thin horizontal groove, just deep enough to carve a
  //  lip line. Keep rz small so the cut doesn't eat into the chin.
  { cx: 0, cy: -0.3, cz: 0.42, rx: 0.1, ry: 0.015, rz: 0.05 },
];

/**
 * Fibonacci-sphere sampling on an ellipsoid. Produces a roughly-
 * uniform angular distribution; area density still varies with
 * eccentricity, which adds natural clustering in tight regions
 * (nose ridge, ears) — acceptable because those regions benefit
 * visually from extra density anyway.
 */
function sampleEllipsoid(e: Ellipsoid, out: Array<[number, number, number]>): void {
  const phi = Math.PI * (Math.sqrt(5) - 1);
  for (let i = 0; i < e.count; i++) {
    const y = 1 - (i / (e.count - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = phi * i;
    const sx = Math.cos(theta) * r;
    const sz = Math.sin(theta) * r;
    out.push([e.cx + sx * e.rx, e.cy + y * e.ry, e.cz + sz * e.rz]);
  }
}

/** True when `(px,py,pz)` lies inside the ellipsoid, optionally shrunk by `k`. */
function insideEllipsoid(
  px: number,
  py: number,
  pz: number,
  e: Omit<Ellipsoid, "count">,
  k = 1,
): boolean {
  const dx = (px - e.cx) / (e.rx * k);
  const dy = (py - e.cy) / (e.ry * k);
  const dz = (pz - e.cz) / (e.rz * k);
  return dx * dx + dy * dy + dz * dz < 1;
}

/**
 * Build the point cloud. Samples each body ellipsoid, drops points
 * that sit inside any other body ellipsoid (interior cull), then
 * drops points inside any socket (eye/mouth carve-outs). Returns a
 * flat Float32Array of `[x0,y0,z0,x1,y1,z1,…]` for fast iteration.
 *
 * Exported so the test file can assert on the output without spinning
 * up a DOM; pure function, deterministic per inputs.
 */
export function buildHeadCloud(
  body: Ellipsoid[] = BODY,
  sockets: Array<Omit<Ellipsoid, "count">> = SOCKETS,
): Float32Array {
  const raw: Array<[number, number, number]> = [];
  const starts: number[] = [];
  for (const e of body) {
    starts.push(raw.length);
    sampleEllipsoid(e, raw);
  }
  starts.push(raw.length);

  const kept: Array<[number, number, number]> = [];
  for (let i = 0; i < body.length; i++) {
    const start = starts[i] as number;
    const end = starts[i + 1] as number;
    for (let k = start; k < end; k++) {
      const p = raw[k];
      if (!p) continue;
      const [px, py, pz] = p;
      // Interior cull — drop points inside any other body ellipsoid.
      let buried = false;
      for (let j = 0; j < body.length; j++) {
        if (j === i) continue;
        const other = body[j];
        if (other && insideEllipsoid(px, py, pz, other, 0.97)) {
          buried = true;
          break;
        }
      }
      if (buried) continue;
      // Socket cull — drop points inside eye sockets or mouth groove.
      let inSocket = false;
      for (const s of sockets) {
        if (insideEllipsoid(px, py, pz, s)) {
          inSocket = true;
          break;
        }
      }
      if (inSocket) continue;
      kept.push([px, py, pz]);
    }
  }

  const flat = new Float32Array(kept.length * 3);
  for (let i = 0; i < kept.length; i++) {
    const p = kept[i];
    if (!p) continue;
    flat[i * 3] = p[0];
    flat[i * 3 + 1] = p[1];
    flat[i * 3 + 2] = p[2];
  }
  return flat;
}

let cachedPoints: Float32Array | null = null;
/** Lazy, module-shared sample cache — built on first mount only. */
function getHeadPoints(): Float32Array {
  if (!cachedPoints) cachedPoints = buildHeadCloud();
  return cachedPoints;
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
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(match[1]).trim();
  return resolved || fallback;
}

export function DottedHead({
  size = 128,
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

    const points = getHeadPoints();
    const N = (points.length / 3) | 0;

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

    // Scale so the shifted model's Y span (~±0.92) fits the canvas
    //  with a small margin. X and Z are narrower so they fit under
    //  this scale automatically.
    const radius = size * 0.5;
    const centre = size / 2;

    let rafId: number | null = null;
    const projected: Array<{ x: number; y: number; z: number }> = new Array(N);
    for (let i = 0; i < N; i++) projected[i] = { x: 0, y: 0, z: 0 };

    const draw = () => {
      const ease = motion === "full" ? EASE_FULL : motion === "reduced" ? 1 : 0;
      if (ease > 0) {
        rot.yawCur += (rot.yawTgt - rot.yawCur) * ease;
        rot.pitchCur += (rot.pitchTgt - rot.pitchCur) * ease;
      }

      const cosY = Math.cos(rot.yawCur);
      const sinY = Math.sin(rot.yawCur);
      const cosP = Math.cos(rot.pitchCur);
      const sinP = Math.sin(rot.pitchCur);

      for (let i = 0; i < N; i++) {
        const x0 = points[i * 3] as number;
        const y0 = (points[i * 3 + 1] as number) + Y_SHIFT;
        const z0 = points[i * 3 + 2] as number;
        // Yaw around Y (horizontal sweep).
        const x1 = x0 * cosY + z0 * sinY;
        const z1 = -x0 * sinY + z0 * cosY;
        // Pitch around X (vertical nod).
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
      //  far ones. In-place mutation — no allocation in the hot loop.
      projected.sort((a, b) => a.z - b.z);

      const fill = resolveColor(color);
      ctx.clearRect(0, 0, size, size);
      ctx.fillStyle = fill;

      for (let i = 0; i < N; i++) {
        const p = projected[i];
        if (!p) continue;
        // Depth normalization across the head's Z span (~±0.55). Near
        //  points pop bright and slightly larger; far points fade to a
        //  faint haze (rear-of-head density cue).
        const depth = clamp((p.z + 0.55) / 1.1, 0, 1);
        const dotSize = 0.55 + depth * 0.95;
        const alpha = 0.22 + depth * 0.68;
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
