/**
 * biome-ignore-all lint/a11y/noStaticElementInteractions: this file
 * uses HTML5 drag-and-drop on `<div>` cube-faces and agent-strips —
 * making them `<button>`s would nest interactive controls (invalid
 * HTML, since each strip already contains its own buttons). Keyboard
 * users are served by the buttons inside each strip + the visible
 * edge-affordance navigation arrows; drag is a mouse-only enhancement.
 */
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Plus } from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useWorkspaceActivity } from "../hooks/useWorkspaceActivity.js";
import { ApiError, startAutonomousRun } from "../lib/api.js";
import {
  FACE_ROTATIONS,
  FACES,
  type FaceId,
  MAX_AGENTS_PER_FACE,
  NEIGHBORS,
  useAgentClustersStore,
} from "../stores/agent-clusters.js";
import { useAppStore } from "../stores/app.js";
import { AgentPulse, Key, Meta, Reuleaux } from "./primitives/index.js";

/**
 * Six-cluster 3D agent cube — replaces the flat list in Home's
 * §01 Active runs. Each face holds up to four agent strips and
 * ships exactly one trailing "New Job" button (placeholder TBD).
 *
 * **Geometry.** A real 3D cube — six faces are statically
 * positioned at `translateZ(W/2)` from the cube center (where W is
 * the column's measured width). Front / right / back / left faces
 * read as W × H rectangles matching the original Active-Runs card
 * ratio; top / bottom are capped W × W. The container carries
 * `perspective` + `transform-style: preserve-3d` so the rotation
 * animates as a true 3D rotation rather than a flat flip.
 *
 * **Navigation.**
 * - **Drag** — pointerdown anywhere on the cube, drag in the
 *   target direction, release. Single-axis only: the dominant
 *   drag axis decides the direction; the orthogonal delta is
 *   ignored (no diagonal flips).
 * - **Arrow click** — each edge-hover affordance is a button. Click
 *   navigates the same way a drag would.
 *
 * **Cells.** Each face renders the cluster name header + one
 * `ActiveAgentCard` per assigned agent, followed by exactly one
 * "New Job" button (or just the button at the top when the face is
 * empty). When a face is full (4 agents), the new-job button is
 * hidden — same affordance as the legacy New page rail.
 */
export function AgentsCube({ displaySerif = false }: { displaySerif?: boolean }) {
  const activity = useWorkspaceActivity();
  const installedSlugs = useMemo(() => activity.agents.map((a) => a.slug), [activity.agents]);

  const names = useAgentClustersStore((s) => s.names);
  const agentsByFace = useAgentClustersStore((s) => s.agents);
  const ensureBootstrap = useAgentClustersStore((s) => s.ensureBootstrap);
  const syncFromServer = useAgentClustersStore((s) => s.syncFromServer);
  const setName = useAgentClustersStore((s) => s.setName);
  const assign = useAgentClustersStore((s) => s.assign);

  // Hydrate from `<projectDir>/.ironlore/agent-clusters.json` once on
  //  mount. Server is authoritative; localStorage was the paint cache
  //  while the round-trip was in flight. Failures are silent — the
  //  cache already has the layout.
  useEffect(() => {
    void syncFromServer();
  }, [syncFromServer]);

  // First-run migration — drop every installed agent onto the
  //  front face so the cube starts populated rather than empty.
  useEffect(() => {
    if (installedSlugs.length > 0) ensureBootstrap(installedSlugs);
  }, [installedSlugs, ensureBootstrap]);

  // ─── Cube width tracking ────────────────────────────────────────
  //  ResizeObserver keeps the inline `--cube-w` CSS variable in
  //  sync with the container's measured width so each face's
  //  `translateZ(W/2)` lands at the cube edge regardless of the
  //  Home column's resize. The initial value (480 px) is a
  //  reasonable fallback for SSR / pre-mount paint.
  const [cubeW, setCubeW] = useState(480);
  const containerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setCubeW(Math.max(240, entry.contentRect.width));
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  const [currentFace, setCurrentFace] = useState<FaceId>("front");
  // Logical rotation state — animates from one canonical
  //  FACE_ROTATIONS value to another. Drag adds a single-axis
  //  offset before commit; on release we either snap back or
  //  navigate to the neighbour and update both `rotation` and
  //  `currentFace` together.
  const [rotation, setRotation] = useState(FACE_ROTATIONS.front);
  const [animating, setAnimating] = useState(false);

  // First-paint tilt only — the cube renders with a small 3D tilt
  //  on mount so the user can see it's a 3D object, but the moment
  //  they interact (drag OR arrow click) the tilt fades and every
  //  subsequent state is a strict horizontal/vertical canonical
  //  orientation. Per the user's brief: "the slight tilt should
  //  only be initially. When the user actually clicks and drags the
  //  box to the desired side it should snap directly to strict
  //  horizontal or vertical rotation."
  const [userInteracted, setUserInteracted] = useState(false);

  type Direction = "up" | "down" | "left" | "right";
  const dragRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    pointerId: number;
    moved: boolean;
    /** Locked to the dominant axis once movement passes the begin
     *  threshold. Subsequent move events update rotation only on
     *  this axis — the user's brief: "you can only rotate
     *  vertically or horizontally (not diagonally)." */
    axis: "x" | "y" | null;
  } | null>(null);

  const TILT_X = -5;
  const TILT_Y = 8;
  const SNAP_MS = 320;
  const DRAG_BEGIN_PX = 4;
  const NAVIGATE_PX = 50;

  /** Animate the cube to the canonical rotation of `target`, then
   *  commit the new face-id once the transition completes. The first
   *  call retires the resting tilt so subsequent navigations land at
   *  strict horizontal/vertical orientations. */
  const navigateTo = useCallback((target: FaceId) => {
    setUserInteracted(true);
    setAnimating(true);
    setRotation(FACE_ROTATIONS[target]);
    setCurrentFace(target);
    setTimeout(() => setAnimating(false), SNAP_MS);
  }, []);

  // ─── Pointer drag → rotate → snap ───────────────────────────────
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (animating) return;
      // The drag-rotate gesture starts on the cube body itself, never
      //  on an agent strip — we want strips to remain HTML5-draggable
      //  to other faces. The handle attribute marks strips so we can
      //  bail out before pointer-capturing.
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-cube-strip]")) return;
      // Inline-rename input also shouldn't trigger drag.
      if (target?.closest("[data-cube-rename]")) return;
      setUserInteracted(true);
      dragRef.current = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        pointerId: e.pointerId,
        moved: false,
        axis: null,
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [animating],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag?.active) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.moved && Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_BEGIN_PX) return;
      drag.moved = true;
      // Lock the axis the first time movement passes the begin
      //  threshold — the dominant axis at that moment wins for the
      //  rest of the gesture so a curved drag doesn't switch axes
      //  mid-flight.
      if (drag.axis === null) {
        drag.axis = Math.abs(dx) >= Math.abs(dy) ? "y" : "x";
      }
      const base = FACE_ROTATIONS[currentFace];
      // Sign convention (swipe-carousel):
      //  - drag right (dx > 0) → reveal right neighbour → rotation.y
      //    moves toward right's canonical y (-90 from front), so
      //    rotation.y DECREASES with positive dx.
      //  - drag down (dy > 0) → reveal bottom (canonical x = +90),
      //    so rotation.x INCREASES with positive dy.
      if (drag.axis === "y") {
        setRotation({ x: base.x, y: base.y - dx * 0.5 });
      } else {
        setRotation({ x: base.x + dy * 0.5, y: base.y });
      }
    },
    [currentFace],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
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
      const axis = drag.axis;
      dragRef.current = null;

      if (!wasDrag) return;

      // Suppress the synthesised click after a real drag so the
      //  underlying card / arrow doesn't fire its onClick.
      const suppress = (clickEvent: Event) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
      };
      document.addEventListener("click", suppress, { capture: true, once: true });

      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      const dominant = axis === "y" ? absX : absY;

      if (dominant < NAVIGATE_PX) {
        // Snap back to current face.
        setAnimating(true);
        setRotation(FACE_ROTATIONS[currentFace]);
        setTimeout(() => setAnimating(false), SNAP_MS);
        return;
      }

      const direction: Direction =
        axis === "y" ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
      const target = NEIGHBORS[currentFace][direction];
      navigateTo(target);
    },
    [currentFace, navigateTo],
  );

  // ─── Edge-hover affordance ──────────────────────────────────────
  const [hoverEdge, setHoverEdge] = useState<Direction | null>(null);

  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (dragRef.current?.active || animating) {
        if (hoverEdge !== null) setHoverEdge(null);
        return;
      }
      const node = containerRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      const edgeDepth = 0.18;
      const inTop = y < edgeDepth;
      const inBottom = y > 1 - edgeDepth;
      const inLeft = x < edgeDepth;
      const inRight = x > 1 - edgeDepth;
      let next: Direction | null = null;
      if (inTop && !inLeft && !inRight) next = "up";
      else if (inBottom && !inLeft && !inRight) next = "down";
      else if (inLeft && !inTop && !inBottom) next = "left";
      else if (inRight && !inTop && !inBottom) next = "right";
      else if (inTop || inBottom || inLeft || inRight) {
        const dists: Array<[Direction, number]> = [
          ["up", y],
          ["down", 1 - y],
          ["left", x],
          ["right", 1 - x],
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

  // The cube's transform composes the logical rotation state with
  //  the constant tilt. `translateZ(-W/2)` pulls the cube center
  //  back so the front face (at +W/2) sits at z=0 in screen space.
  const halfDepth = cubeW / 2;
  // Tilt is a one-shot first-paint hint. Once `userInteracted`
  //  flips, every transform composes only the canonical rotation
  //  state — strict horizontal/vertical orientations as the user
  //  asked for. The transition that fades the tilt out runs on the
  //  same `transform` property so the move feels continuous.
  const tiltX = userInteracted ? 0 : TILT_X;
  const tiltY = userInteracted ? 0 : TILT_Y;
  const cubeStyle: CSSProperties = {
    transform: `translateZ(-${halfDepth}px) rotateX(${rotation.x + tiltX}deg) rotateY(${rotation.y + tiltY}deg)`,
    transition: animating || userInteracted ? `transform ${SNAP_MS}ms ease-out` : "none",
  };

  // The host's height needs to be tall enough for the longest face's
  //  content; otherwise the cube clips. Each ActiveAgentCard is
  //  ~108 px (content + padding + progress-bar headroom) + 12 px
  //  gap; header is ~30 px (incl. divider + margin); face padding is
  //  14 px top/bottom; the optional new-job button adds 36 + 12 px.
  //  The previous estimate (76 px/strip, cap 560) cut off the 4th
  //  strip — bumped to 112 px/strip and cap 720 to hold a full face
  //  + new-job button comfortably.
  const STRIP_H = 112;
  const HEADER_H = 30;
  const FACE_PAD = 28;
  const GAP_H = 12;
  const NEW_JOB_H = 36;
  const measuredHeights = FACES.map((f) => {
    const n = agentsByFace[f]?.length ?? 0;
    const showNewJob = n < MAX_AGENTS_PER_FACE;
    const items = n + (showNewJob ? 1 : 0);
    if (items === 0) return FACE_PAD + HEADER_H;
    return (
      FACE_PAD +
      HEADER_H +
      n * STRIP_H +
      (showNewJob ? NEW_JOB_H : 0) +
      Math.max(0, items - 1) * GAP_H
    );
  });
  const hostHeight = Math.min(720, Math.max(220, Math.max(...measuredHeights)));

  return (
    <section
      ref={containerRef}
      className="il-agents-cube-host relative"
      style={{
        perspective: 1400,
        height: hostHeight,
        marginTop: 4,
        marginBottom: 12,
        userSelect: "none",
      }}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      aria-label="Agent clusters"
    >
      {hoverEdge && (
        <EdgeAffordance
          edge={hoverEdge}
          neighbourName={names[NEIGHBORS[currentFace][hoverEdge]]}
          onClick={() => {
            const target = NEIGHBORS[currentFace][hoverEdge];
            navigateTo(target);
          }}
        />
      )}
      <div className="il-agents-cube" style={cubeStyle}>
        {FACES.map((faceId) => (
          <CubeFace
            key={faceId}
            faceId={faceId}
            name={names[faceId]}
            agents={agentsByFace[faceId]}
            workspaceAgents={activity.agents}
            cubeW={cubeW}
            hostHeight={hostHeight}
            displaySerif={displaySerif}
            onRename={(next) => setName(faceId, next)}
            onDropAgent={(slug) => assign(faceId, slug)}
          />
        ))}
      </div>
    </section>
  );
}

// ───────────── faces ─────────────

/**
 * One cube face. Holds the cluster name header, every assigned
 * agent's `ActiveAgentCard`, and one trailing "New Job" placeholder
 * button (TBD). On an empty face the button is the only cell —
 * which lands it at the top — matching the user's brief: "if there
 * are not any agents on this side the New Job button should sit at
 * the top."
 */
function CubeFace({
  faceId,
  name,
  agents,
  workspaceAgents,
  cubeW,
  hostHeight,
  displaySerif,
  onRename,
  onDropAgent,
}: {
  faceId: FaceId;
  name: string;
  agents: string[];
  workspaceAgents: ReturnType<typeof useWorkspaceActivity>["agents"];
  cubeW: number;
  hostHeight: number;
  displaySerif: boolean;
  onRename: (next: string) => void;
  onDropAgent: (slug: string) => void;
}) {
  const halfDepthW = cubeW / 2;
  const halfDepthH = hostHeight / 2;
  // Rectangular cuboid geometry — depth = cubeW, so the box reads
  //  as W × H × W.
  //  - Front/back/right/left fill the host (W × H), translated by W/2
  //    along the appropriate axis.
  //  - Top/bottom are W × W square caps positioned at the top + bottom
  //    of the cube. They're laid out vertically-centered in the cube
  //    container (so their rotation pivot lands at host center) and
  //    then translateZ(H/2) lifts/drops them onto the proper plane.
  //  Without this, top/bottom inherited the host height and extended
  //  beyond the actual depth of the cube — visible as a gap when the
  //  cube was tilted.
  const faceStyle: Record<FaceId, CSSProperties> = {
    front: { transform: `translateZ(${halfDepthW}px)` },
    back: { transform: `rotateY(180deg) translateZ(${halfDepthW}px)` },
    right: { transform: `rotateY(90deg) translateZ(${halfDepthW}px)` },
    left: { transform: `rotateY(-90deg) translateZ(${halfDepthW}px)` },
    top: {
      top: Math.max(0, (hostHeight - cubeW) / 2),
      left: 0,
      height: cubeW,
      transform: `rotateX(90deg) translateZ(${halfDepthH}px)`,
    },
    bottom: {
      top: Math.max(0, (hostHeight - cubeW) / 2),
      left: 0,
      height: cubeW,
      transform: `rotateX(-90deg) translateZ(${halfDepthH}px)`,
    },
  };
  const canAddMore = agents.length < MAX_AGENTS_PER_FACE;
  const isCap = faceId === "top" || faceId === "bottom";
  const [isDropTarget, setIsDropTarget] = useState(false);

  // ─── HTML5 drop target ────────────────────────────────────────
  //  Every face accepts a `text/x-il-agent-slug` payload. On drop
  //  we call `assign(faceId, slug)` (which bumps the slug off any
  //  prior face). dragenter/dragleave manage the visual highlight;
  //  dragover preventDefault is required for the browser to fire
  //  drop at all.
  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes("text/x-il-agent-slug")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  }, []);
  const onDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes("text/x-il-agent-slug")) {
      e.preventDefault();
      setIsDropTarget(true);
    }
  }, []);
  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // dragleave fires when the cursor crosses ANY child boundary;
    //  guard with relatedTarget containment to avoid flicker.
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setIsDropTarget(false);
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const slug = e.dataTransfer.getData("text/x-il-agent-slug");
      setIsDropTarget(false);
      if (!slug) return;
      e.preventDefault();
      onDropAgent(slug);
    },
    [onDropAgent],
  );

  return (
    <div
      className={`il-agents-cube-face${isCap ? " is-cap" : ""}${isDropTarget ? " is-drop-target" : ""}`}
      style={faceStyle[faceId]}
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <RenameableHeader name={name} onRename={onRename} />
      <div style={{ display: "grid", gap: 12 }}>
        {agents.map((slug) => {
          const agent = workspaceAgents.find((a) => a.slug === slug);
          return (
            <DraggableStrip key={slug} slug={slug}>
              <ActiveAgentCard
                slug={slug}
                running={agent?.running ?? false}
                paused={agent?.status === "paused"}
                stepLabel={agent?.stepLabel ?? null}
                note={agent?.lastNote ?? null}
                displaySerif={displaySerif}
              />
            </DraggableStrip>
          );
        })}
        {canAddMore && <NewJobSlot faceId={faceId} />}
      </div>
    </div>
  );
}

/**
 * Click-to-edit cluster name. Single-line input swap on click;
 * commits on blur or Enter, reverts on Escape. The input is
 * tagged `data-cube-rename` so the parent's pointerdown handler
 * skips cube-rotation while the user is editing.
 */
function RenameableHeader({ name, onRename }: { name: string; onRename: (next: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Sync external updates (e.g. server hydration) when not editing.
  useEffect(() => {
    if (!editing) setDraft(name);
  }, [editing, name]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed.length > 0 && trimmed !== name) onRename(trimmed.slice(0, 64));
    setEditing(false);
  };
  const cancel = () => {
    setDraft(name);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        data-cube-rename
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") cancel();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className="font-mono uppercase"
        style={{
          width: "100%",
          fontSize: 11,
          letterSpacing: "0.08em",
          color: "var(--il-text)",
          background: "transparent",
          border: "none",
          borderBottom: "1px solid var(--il-blue)",
          outline: "none",
          paddingBottom: 8,
          marginBottom: 10,
        }}
        maxLength={64}
        aria-label="Cluster name"
      />
    );
  }

  return (
    <button
      type="button"
      data-cube-rename
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className="font-mono uppercase truncate text-left"
      style={{
        display: "block",
        width: "100%",
        fontSize: 11,
        letterSpacing: "0.08em",
        color: "var(--il-text3)",
        background: "transparent",
        border: "none",
        paddingBottom: 8,
        borderBottom: "1px solid var(--il-border-soft)",
        marginBottom: 10,
        cursor: "text",
      }}
      title={`Rename "${name}"`}
    >
      {name}
    </button>
  );
}

/**
 * HTML5-draggable wrapper for an agent strip. Drag carries the slug
 * via the `text/x-il-agent-slug` MIME type so a CubeFace `onDrop`
 * can move the agent. Tagged `data-cube-strip` so the cube's
 * pointerdown rotation gesture skips the strip — strips drag
 * between faces, never the cube itself.
 */
function DraggableStrip({ slug, children }: { slug: string; children: ReactNode }) {
  return (
    <div
      data-cube-strip
      draggable
      title={`Drag to move ${slug} to another cluster`}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/x-il-agent-slug", slug);
        e.dataTransfer.effectAllowed = "move";
      }}
      style={{ cursor: "grab" }}
    >
      {children}
    </div>
  );
}

/**
 * Active-agent card matching `screen-home.jsx` AgentRunCard.
 * Restored verbatim from the prior Home renderer so each cube
 * face's strips read identically to the original Active Runs
 * section: AgentPulse wrapper, Reuleaux + slug + status row,
 * action note, 2 px blue-left rail when live, "Run now" CTA in the
 * idle state.
 */
function ActiveAgentCard({
  slug,
  running,
  paused,
  stepLabel,
  note,
  displaySerif,
}: {
  slug: string;
  running: boolean;
  paused: boolean;
  stepLabel: string | null;
  note: string | null;
  displaySerif: boolean;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    useAppStore.getState().setActiveAgentSlug(slug);
  };

  const onRunNow = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (starting || running) return;
      setStarting(true);
      setError(null);
      try {
        await startAutonomousRun(slug);
      } catch (err) {
        setStarting(false);
        if (err instanceof ApiError) {
          if (err.status === 429) {
            setError("rate-limited · try again later");
          } else {
            setError(err.body.slice(0, 60) || `error ${err.status}`);
          }
        } else {
          setError("failed to start");
        }
      }
    },
    [slug, running, starting],
  );

  useEffect(() => {
    if (!starting) return;
    if (running) {
      setStarting(false);
      return;
    }
    const id = window.setTimeout(() => setStarting(false), 20_000);
    return () => window.clearTimeout(id);
  }, [starting, running]);

  const showRunNow = !running && !paused;
  const live = running || starting;
  const pct = live ? parseStepPct(stepLabel) : null;
  const target = deriveTargetLine({ live, paused, note, starting });

  return (
    <AgentPulse
      active={live}
      style={{
        background: "var(--il-bg-raised)",
        border: "1px solid var(--il-border-soft)",
        borderLeft: `2px solid ${live ? "var(--il-blue)" : "var(--il-border)"}`,
        borderRadius: 4,
        padding: "16px 18px",
      }}
    >
      <div className="flex w-full items-baseline gap-3">
        <button
          type="button"
          onClick={onOpen}
          className="flex flex-1 items-baseline gap-3 text-left outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
          style={{ background: "transparent", border: "none", cursor: "pointer", minWidth: 0 }}
          aria-label={`Open ${slug} detail page`}
        >
          <Reuleaux
            size={9}
            color={live ? "var(--il-blue)" : paused ? "var(--il-amber)" : "var(--il-text3)"}
            spin={live}
          />
          <span
            className="truncate"
            style={
              displaySerif
                ? {
                    fontFamily: "var(--font-serif)",
                    fontSize: 20,
                    fontWeight: 400,
                    fontStyle: "italic",
                    letterSpacing: "-0.01em",
                    lineHeight: 1.15,
                    color: "var(--il-text)",
                  }
                : {
                    fontFamily: "var(--font-sans)",
                    fontSize: 14,
                    fontWeight: 600,
                    letterSpacing: "-0.01em",
                    color: "var(--il-text)",
                  }
            }
          >
            {slug}
          </span>
          <span style={{ flex: 1 }} />
          <Meta k="step" v={stepLabel ?? "—"} color={live ? "var(--il-blue)" : "var(--il-text3)"} />
        </button>

        {showRunNow && (
          <button
            type="button"
            onClick={onRunNow}
            disabled={starting}
            className="flex shrink-0 items-center gap-1.5 rounded-sm px-2 py-0.75 text-xs outline-none hover:bg-ironlore-slate-hover focus-visible:ring-1 focus-visible:ring-ironlore-blue/50 disabled:opacity-50"
            style={{
              background: "var(--il-slate-elev)",
              border: "1px solid var(--il-border-soft)",
              color: "var(--il-text)",
              cursor: starting ? "progress" : "pointer",
            }}
            aria-label={`Run ${slug} now`}
            title="Start an autonomous run for this agent"
          >
            <span
              className="font-mono uppercase"
              style={{
                fontSize: 10.5,
                letterSpacing: "0.04em",
                color: starting ? "var(--il-text3)" : "var(--il-text2)",
              }}
            >
              {starting ? "starting…" : "run now"}
            </span>
            {!starting && <Key>⌘R</Key>}
          </button>
        )}
      </div>

      <div
        className={live && note ? "truncate" : "font-mono truncate"}
        style={
          live && note
            ? { marginTop: 6, fontSize: 12.5, color: "var(--il-text2)" }
            : {
                marginTop: 6,
                fontSize: 10.5,
                color: "var(--il-text3)",
                letterSpacing: "0.02em",
                textTransform: "uppercase",
              }
        }
      >
        {live && note ? note : paused ? "paused" : note ? `last · ${note}` : "no recent activity"}
      </div>

      <div
        className="font-mono truncate"
        style={{
          marginTop: 4,
          fontSize: 10.5,
          letterSpacing: "0.02em",
          color: "var(--il-text3)",
        }}
      >
        → {target}
      </div>

      {pct !== null && (
        <div
          aria-hidden="true"
          style={{
            height: 2,
            background: "var(--il-border-soft)",
            borderRadius: 1,
            marginTop: 10,
            position: "relative",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              right: `${100 - pct}%`,
              background: "var(--il-blue)",
              borderRadius: 1,
              boxShadow: "0 0 8px var(--il-blue-glow)",
              transition: "right var(--motion-transit) ease",
            }}
          />
        </div>
      )}

      {error && (
        <div
          className="font-mono"
          style={{
            marginTop: 6,
            fontSize: 10.5,
            color: "var(--il-red)",
            letterSpacing: "0.02em",
          }}
        >
          {error}
        </div>
      )}
    </AgentPulse>
  );
}

/**
 * Parse a `"NN/MM"` step label (e.g. `"04/12"`) into a 0–100 %
 * completion ratio. Clamps to `[0, 100]` so a server-side off-by-one
 * doesn't overflow the progress bar. Returns `null` when the label
 * can't be parsed so the caller suppresses the bar cleanly.
 */
function parseStepPct(label: string | null): number | null {
  if (!label) return null;
  const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(label);
  if (!match?.[1] || !match[2]) return null;
  const step = Number.parseInt(match[1], 10);
  const total = Number.parseInt(match[2], 10);
  if (!Number.isFinite(step) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, (step / total) * 100));
}

/**
 * Trailing placeholder button for adding work to a cluster.
 * Renamed from "New Agent" to "New Job" (TBD) per the user's brief.
 * Click is currently a stub — wires into the cluster-assignment
 * flow once the behaviour is decided.
 */
function NewJobSlot({ faceId }: { faceId: FaceId }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        // Placeholder — TBD. For now, stash the slug onto the
        //  cluster so the cube state advances; persona scaffolding
        //  is out of scope for this stub.
        const slug = window.prompt(`New job for ${faceId} (lowercase + dashes):`, "");
        if (!slug) return;
        const clean = slug.trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(clean)) {
          window.alert(
            "Slug must be 3–32 chars, lowercase letters/digits/dashes; no leading/trailing dash.",
          );
          return;
        }
        useAgentClustersStore.getState().assign(faceId, clean);
      }}
      className="flex items-center justify-center gap-1.5 rounded outline-none transition-all duration-(--motion-snap) hover:bg-ironlore-slate-hover focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
      style={{
        height: 36,
        padding: "0 10px",
        background: "transparent",
        border: "1px dashed var(--il-border)",
        color: "var(--il-text3)",
        fontSize: 11.5,
      }}
    >
      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="font-mono uppercase" style={{ letterSpacing: "0.06em" }}>
        new job
      </span>
    </button>
  );
}

/**
 * Edge-hover arrow + neighbour name. Clickable — same navigation
 * effect as a drag in that direction.
 */
function EdgeAffordance({
  edge,
  neighbourName,
  onClick,
}: {
  edge: "up" | "down" | "left" | "right";
  neighbourName: string;
  onClick: () => void;
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
      ? { top: 8, left: "50%", transform: "translateX(-50%)" }
      : edge === "down"
        ? { bottom: 8, left: "50%", transform: "translateX(-50%)" }
        : edge === "left"
          ? { left: 8, top: "50%", transform: "translateY(-50%)" }
          : { right: 8, top: "50%", transform: "translateY(-50%)" };
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="il-agents-cube-edge absolute z-10 flex items-center gap-1.5 rounded font-mono uppercase outline-none transition-transform hover:scale-105 focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
      style={{
        ...positionStyle,
        padding: "5px 10px",
        background: "color-mix(in oklch, var(--il-slate-elev) 90%, var(--il-blue) 12%)",
        border: "1px solid color-mix(in oklch, var(--il-blue) 40%, transparent)",
        color: "var(--il-blue)",
        fontSize: 10.5,
        letterSpacing: "0.06em",
        animation: "ilEdgePulse 1.4s ease-in-out infinite",
      }}
      aria-label={`Move to ${neighbourName}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate" style={{ maxWidth: 140 }}>
        {neighbourName}
      </span>
    </button>
  );
}

// ───────────── helpers (restored from prior Home renderer) ─────────────

/**
 * Derive the mono `→ <target>` line for an ActiveAgentCard. We
 * lack a real `currentTarget` data field, so we fall back to these
 * rules in order: starting → `working…`; running + parseable note
 * token → that token; running w/o token → `working…`; paused →
 * `paused`; otherwise → `queued`. Keeps the line silhouette
 * consistent across states without inventing a target path.
 */
function deriveTargetLine({
  live,
  paused,
  note,
  starting,
}: {
  live: boolean;
  paused: boolean;
  note: string | null;
  starting: boolean;
}): string {
  if (starting) return "working…";
  if (live) {
    const token = note ? extractPathToken(note) : null;
    return token ?? "working…";
  }
  if (paused) return "paused";
  return "queued";
}

/**
 * Pull the most likely file reference out of a free-text note.
 * Returns `null` when no path-ish token is found so the caller
 * falls through to the state placeholder.
 */
function extractPathToken(text: string): string | null {
  const slashMatch = text.match(/[\w.-]+\/[\w./-]+/g);
  if (slashMatch && slashMatch.length > 0) {
    return slashMatch[slashMatch.length - 1] ?? null;
  }
  const extMatch = text.match(/[\w-]+\.(?:md|mdx|ts|tsx|js|jsx|json|yaml|yml|toml|txt|csv)\b/g);
  if (extMatch && extMatch.length > 0) {
    return extMatch[extMatch.length - 1] ?? null;
  }
  return null;
}
