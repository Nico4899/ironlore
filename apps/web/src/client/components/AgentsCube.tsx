import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Plus } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { useWorkspaceActivity } from "../hooks/useWorkspaceActivity.js";
import {
  FACE_ROTATIONS,
  FACES,
  type FaceId,
  MAX_AGENTS_PER_FACE,
  NEIGHBORS,
  useAgentClustersStore,
} from "../stores/agent-clusters.js";
import { useAppStore } from "../stores/app.js";
import { Reuleaux as ReuleauxIcon } from "./primitives/index.js";

/**
 * 3D cube of agent clusters — replaces the flat list in the
 * Agents tab. Six faces × four agent strips each. Faces with
 * fewer than four agents render "New agent" placeholder slots
 * sized identically to the strips.
 *
 * Navigation:
 * - **Edge hover** — when the cursor enters one of the four edge
 *   zones (top / right / bottom / left, ~22% of the face each, no
 *   overlap), an arrow + neighbour cluster name fades in pointing
 *   that way.
 * - **Click + drag** — pointerdown on the cube, drag in the
 *   direction of the target face, release. If the drag delta on
 *   the dominant axis exceeds the threshold, the cube animates
 *   through a 90° rotation to that face. Otherwise it snaps back.
 *
 * The cube uses CSS 3D transforms (`transform-style: preserve-3d`
 * + `perspective`); each face is positioned at one of the cube's
 * six canonical face transforms. Rotation animates via a CSS
 * transition on `transform` driven from React state.
 */
export function AgentsCube() {
  // Workspace activity feeds the per-strip pip + stepLabel so the
  //  cube cells reflect the same running state the rest of the
  //  app sees (sidebar, Home, AI panel header).
  const activity = useWorkspaceActivity();
  const installedSlugs = activity.agents.map((a) => a.slug);

  const names = useAgentClustersStore((s) => s.names);
  const agentsByFace = useAgentClustersStore((s) => s.agents);
  const ensureBootstrap = useAgentClustersStore((s) => s.ensureBootstrap);

  // Drop every installed agent onto a face on first run so the
  //  user starts with a populated cube rather than an empty one.
  //  Idempotent — `ensureBootstrap` no-ops after the first call.
  useEffect(() => {
    if (installedSlugs.length > 0) ensureBootstrap(installedSlugs);
  }, [installedSlugs, ensureBootstrap]);

  const [currentFace, setCurrentFace] = useState<FaceId>("front");
  // Live cube rotation in degrees. Updates continuously while the
  //  user drags (no transition); flips to a transition on release
  //  so the snap animation runs smoothly.
  const [rotation, setRotation] = useState({ x: 0, y: 0 });
  const [animating, setAnimating] = useState(false);

  const dragRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    pointerId: number;
    /** Becomes true once total movement exceeds a small threshold —
     *  separates real drags from clicks-with-jitter so an agent
     *  strip's onClick still fires when the user clicks without
     *  dragging. */
    moved: boolean;
  } | null>(null);

  // Constant cube tilt — applied as a visual offset to every
  //  rotation state so the cube always reads as a 3D object even
  //  when no face is mid-rotation. Without this, the front face
  //  renders straight-on and the cube looks like a flat panel. The
  //  values are baked into the visual transform only; logical
  //  rotation state stays at canonical face values (0, ±90, etc.)
  //  so drag math + snap continue to work cleanly.
  const TILT_X = -12;
  const TILT_Y = 18;

  /** Animate the cube to the canonical rotation of `target`, then
   *  commit the new face-id once the transition completes. */
  const navigateTo = useCallback((target: FaceId) => {
    setAnimating(true);
    setRotation(FACE_ROTATIONS[target]);
    setCurrentFace(target);
    // Match `--motion-transit` for the snap.
    setTimeout(() => setAnimating(false), 220);
  }, []);

  // ─── Pointer drag → rotate → snap ───────────────────────────────
  //  Click-vs-drag disambiguation: pointerdown ALWAYS starts a
  //  potential drag (even on agent strips), but the rotation
  //  preview only kicks in once the cursor has moved past
  //  `DRAG_BEGIN_PX`. If the user releases without crossing that
  //  threshold, we let the click event bubble naturally so the
  //  strip's onClick fires (opens the agent detail page). If they
  //  did drag, we suppress the synthesised click via a one-shot
  //  capture-phase listener on the document.
  const DRAG_BEGIN_PX = 4;
  const NAVIGATE_PX = 50;

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (animating) return;
      dragRef.current = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        pointerId: e.pointerId,
        moved: false,
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [animating],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag?.active) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      // Below the begin-threshold, treat as a still-press — no
      //  rotation preview, no commitment to a drag. This lets a
      //  press-with-tiny-jitter on a strip resolve as a click.
      if (!drag.moved && Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_BEGIN_PX) return;
      drag.moved = true;
      const base = FACE_ROTATIONS[currentFace];
      // Sign convention — swipe-carousel semantics:
      //  - Drag right (dx > 0) → user wants to navigate right →
      //    cube rotates toward the right-neighbour's canonical
      //    rotation, which sits at y = -90 from front. So as dx
      //    grows positive, rotation.y must DECREASE.
      //  - Drag down (dy > 0) → navigate down → bottom face's
      //    canonical x = +90. So rotation.x INCREASES with dy.
      setRotation({ x: base.x + dy * 0.5, y: base.y - dx * 0.5 });
    },
    [currentFace],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag?.active) return;
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(drag.pointerId);
      } catch {
        /* pointer capture may already be released */
      }
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      const wasDrag = drag.moved;
      dragRef.current = null;

      // No drag → let the click event bubble naturally to the
      //  strip / new-agent button that was pressed. This is the
      //  click branch of the disambiguation.
      if (!wasDrag) return;

      // Drag happened — suppress the synthesised click so the
      //  underlying strip doesn't fire its onClick after a rotate.
      //  Capture-phase + once: the next click anywhere is eaten
      //  before any other handler sees it.
      const suppress = (clickEvent: Event) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
      };
      document.addEventListener("click", suppress, { capture: true, once: true });

      const absX = Math.abs(dx);
      const absY = Math.abs(dy);

      if (Math.max(absX, absY) < NAVIGATE_PX) {
        // Drag was too short to commit a navigation — snap back
        //  to current face.
        setAnimating(true);
        setRotation(FACE_ROTATIONS[currentFace]);
        setTimeout(() => setAnimating(false), 220);
        return;
      }

      // Dominant axis decides the direction. Map drag → neighbour
      //  via the topology graph: drag right = swipe-carousel right
      //  = navigate to the right-neighbour face.
      const direction: "up" | "down" | "left" | "right" =
        absX > absY ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
      const target = NEIGHBORS[currentFace][direction];
      navigateTo(target);
    },
    [currentFace, navigateTo],
  );

  // ─── Edge-hover affordance ──────────────────────────────────────
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hoverEdge, setHoverEdge] = useState<"up" | "down" | "left" | "right" | null>(null);

  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Hide the affordance while a drag is in flight — the cube
      //  is in motion and a static arrow would be misleading.
      if (dragRef.current?.active || animating) {
        if (hoverEdge !== null) setHoverEdge(null);
        return;
      }
      const node = containerRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width; // 0..1
      const y = (e.clientY - rect.top) / rect.height; // 0..1
      // 22%-deep, non-overlapping edge zones. Corners go to
      //  whichever zone is closer to the cursor; if a corner is
      //  exactly diagonal we leave the edge undecided (no
      //  affordance), preserving the "boxes don't overlap" promise.
      const edgeDepth = 0.22;
      const inTop = y < edgeDepth;
      const inBottom = y > 1 - edgeDepth;
      const inLeft = x < edgeDepth;
      const inRight = x > 1 - edgeDepth;
      type EdgeDir = "up" | "down" | "left" | "right";
      let next: EdgeDir | null = null;
      const distTop = y;
      const distBottom = 1 - y;
      const distLeft = x;
      const distRight = 1 - x;
      if (inTop && !inLeft && !inRight) next = "up";
      else if (inBottom && !inLeft && !inRight) next = "down";
      else if (inLeft && !inTop && !inBottom) next = "left";
      else if (inRight && !inTop && !inBottom) next = "right";
      else if (inTop || inBottom || inLeft || inRight) {
        // Corner — pick the closest edge.
        const dists: Array<[EdgeDir, number]> = [
          ["up", distTop],
          ["down", distBottom],
          ["left", distLeft],
          ["right", distRight],
        ];
        const inZones = dists.filter(([dir]) =>
          dir === "up" ? inTop : dir === "down" ? inBottom : dir === "left" ? inLeft : inRight,
        );
        inZones.sort((a, b) => a[1] - b[1]);
        next = inZones[0]?.[0] ?? null;
      }
      if (next !== hoverEdge) setHoverEdge(next);
    },
    [animating, hoverEdge],
  );

  const onMouseLeave = useCallback(() => {
    if (hoverEdge !== null) setHoverEdge(null);
  }, [hoverEdge]);

  // The cube's display CSS — rotation transform with conditional
  //  transition (active during snap, off during drag for 1:1 feel).
  const cubeStyle: CSSProperties = {
    // Visual rotation = logical face state + constant tilt. The
    //  tilt is what makes the front face read as "this is a cube
    //  you can rotate" rather than "this is a flat panel" — the
    //  side faces peek through at the edges. Logical state in
    //  `rotation` stays at canonical 90° increments so drag math
    //  + face snap stay clean.
    transform: `translateZ(-120px) rotateX(${rotation.x + TILT_X}deg) rotateY(${rotation.y + TILT_Y}deg)`,
    transition: animating ? "transform var(--motion-transit) ease-out" : "none",
  };

  return (
    <section
      ref={containerRef}
      className="il-agents-cube-host relative mx-auto"
      style={{ width: 240, height: 240, perspective: 800, marginTop: 12, marginBottom: 12 }}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      aria-label="Agent clusters cube"
    >
      {hoverEdge && (
        <EdgeAffordance edge={hoverEdge} neighbourName={names[NEIGHBORS[currentFace][hoverEdge]]} />
      )}
      <div className="il-agents-cube" style={cubeStyle}>
        {FACES.map((faceId) => (
          <CubeFace
            key={faceId}
            faceId={faceId}
            name={names[faceId]}
            agents={agentsByFace[faceId]}
            workspaceAgents={activity.agents}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * One face of the cube. Renders the cluster name header + up to
 * `MAX_AGENTS_PER_FACE` agent strips, with empty slots filled by
 * "New agent" placeholders that share the strip's height.
 */
function CubeFace({
  faceId,
  name,
  agents,
  workspaceAgents,
}: {
  faceId: FaceId;
  name: string;
  agents: string[];
  workspaceAgents: ReturnType<typeof useWorkspaceActivity>["agents"];
}) {
  const slots: Array<string | null> = Array.from(
    { length: MAX_AGENTS_PER_FACE },
    (_, i) => agents[i] ?? null,
  );
  const placedSlugs = new Set(agents);
  return (
    <div className={`il-agents-cube-face il-agents-cube-face--${faceId}`}>
      <header
        className="font-mono uppercase truncate"
        style={{
          fontSize: 10.5,
          letterSpacing: "0.08em",
          color: "var(--il-text3)",
          paddingBottom: 6,
          borderBottom: "1px solid var(--il-border-soft)",
          marginBottom: 6,
        }}
        title={name}
      >
        {name}
      </header>
      <div className="flex flex-col gap-1">
        {slots.map((slug, idx) =>
          slug ? (
            <AgentStrip
              key={slug}
              slug={slug}
              agent={workspaceAgents.find((a) => a.slug === slug)}
              alreadyPlaced={placedSlugs.has(slug)}
            />
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: empty slots have no stable identifier — index is the only meaningful key
            <NewAgentSlot key={`empty-${faceId}-${idx}`} faceId={faceId} />
          ),
        )}
      </div>
    </div>
  );
}

/** Single agent strip — same visual contract on every face. */
function AgentStrip({
  slug,
  agent,
}: {
  slug: string;
  agent: ReturnType<typeof useWorkspaceActivity>["agents"][number] | undefined;
  alreadyPlaced: boolean;
}) {
  const paused = agent?.status === "paused";
  const running = agent?.running ?? false;
  const pipColor = running ? "var(--il-blue)" : paused ? "var(--il-amber)" : "var(--il-text3)";
  const label = running ? agent?.stepLabel : paused ? "paused" : "idle";
  return (
    <button
      type="button"
      data-cube-cell
      onClick={(e) => {
        e.stopPropagation();
        useAppStore.getState().setActiveAgentSlug(slug);
      }}
      className="il-agents-cube-strip flex items-center gap-2 rounded outline-none transition-colors hover:bg-ironlore-slate-hover focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
      style={{
        height: 32,
        padding: "0 8px",
        background: "var(--il-slate-elev)",
        border: "1px solid var(--il-border-soft)",
      }}
    >
      <ReuleauxIcon size={7} color={pipColor} spin={running} />
      <span
        className="flex-1 truncate text-left"
        style={{ fontSize: 12, color: "var(--il-text2)" }}
      >
        {slug}
      </span>
      {label && (
        <span
          className="font-mono"
          style={{ fontSize: 10, color: pipColor, letterSpacing: "0.04em" }}
        >
          {label}
        </span>
      )}
    </button>
  );
}

/**
 * Empty-slot "New agent" cell. Same height as `AgentStrip` so the
 * cube cells line up regardless of how full the face is. Click
 * delegates to the same agent-builder flow the bottom rail uses.
 */
function NewAgentSlot({ faceId }: { faceId: FaceId }) {
  return (
    <button
      type="button"
      data-cube-cell
      onClick={(e) => {
        e.stopPropagation();
        // Re-using the same window.prompt + persona scaffolding
        //  pattern the AgentsPanel `+ Add agent` button uses keeps
        //  the cube path simple. A future Visual Agent Builder
        //  integration could land here too.
        const slug = window.prompt(`New agent for ${faceId} cluster (lowercase + dashes):`, "");
        if (!slug) return;
        const clean = slug.trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(clean)) {
          window.alert(
            "Slug must be 3–32 chars, lowercase letters/digits/dashes; no leading/trailing dash.",
          );
          return;
        }
        useAgentClustersStore.getState().assign(faceId, clean);
        // The persona file scaffold lives outside this component
        //  (AgentsPanel onAdd creates it); for v1 the cube only
        //  records the cluster placement and the user creates the
        //  persona via the existing "New agent" rail below the cube.
      }}
      className="il-agents-cube-empty flex items-center justify-center gap-1.5 rounded outline-none transition-all duration-(--motion-snap) focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
      style={{
        height: 32,
        padding: "0 8px",
        background: "transparent",
        border: "1px dashed var(--il-border-soft)",
        color: "var(--il-text3)",
        fontSize: 11,
      }}
    >
      <Plus className="h-3 w-3" aria-hidden="true" />
      <span className="font-mono uppercase" style={{ letterSpacing: "0.06em" }}>
        new agent
      </span>
    </button>
  );
}

/**
 * Edge-hover arrow + neighbour cluster label. Renders inside one
 * of four non-overlapping zones (top / right / bottom / left).
 * Pure visual cue: clicking it does nothing — the user navigates
 * by dragging.
 */
function EdgeAffordance({
  edge,
  neighbourName,
}: {
  edge: "up" | "down" | "left" | "right";
  neighbourName: string;
}) {
  const Icon =
    edge === "up"
      ? ChevronUp
      : edge === "down"
        ? ChevronDown
        : edge === "left"
          ? ChevronLeft
          : ChevronRight;
  const positionStyle: CSSProperties =
    edge === "up"
      ? { top: 4, left: "50%", transform: "translateX(-50%)" }
      : edge === "down"
        ? { bottom: 4, left: "50%", transform: "translateX(-50%)" }
        : edge === "left"
          ? { left: 4, top: "50%", transform: "translateY(-50%)" }
          : { right: 4, top: "50%", transform: "translateY(-50%)" };
  return (
    <div
      className="il-agents-cube-edge pointer-events-none absolute z-10 flex items-center gap-1.5 rounded font-mono uppercase"
      style={{
        ...positionStyle,
        padding: "3px 8px",
        background: "color-mix(in oklch, var(--il-slate-elev) 90%, var(--il-blue) 12%)",
        border: "1px solid color-mix(in oklch, var(--il-blue) 30%, transparent)",
        color: "var(--il-blue)",
        fontSize: 10,
        letterSpacing: "0.06em",
        animation: "ilEdgePulse 1.4s ease-in-out infinite",
      }}
      role="status"
      aria-label={`Drag ${edge} to ${neighbourName}`}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate" style={{ maxWidth: 120 }}>
        {neighbourName}
      </span>
    </div>
  );
}
