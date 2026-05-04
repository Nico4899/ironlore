import { create } from "zustand";
import { fetchAgentClusters, saveAgentClusters } from "../lib/api.js";

/**
 * Agent clusters — the per-face state for the Home §01 Active-runs
 * cube (`AgentsCube.tsx`). Six named slots, each holding up to four
 * agent slugs.
 *
 * **Persistence (Phase 2).** Server-backed: the canonical layout
 * lives in `<projectDir>/.ironlore/agent-clusters.json`. The client
 * fetches it once on first read (`syncFromServer()`) and PUTs the
 * whole doc back on a 600 ms debounce after any local mutation.
 * localStorage stays as a tiny startup-paint cache so the cube
 * doesn't flash with default names while the network round-trip
 * lands.
 *
 * Cube topology — from each face, the 4 swipe directions point at
 * specific neighbours (think of unfolding a die). The graph below
 * is "swipe carousel" semantics: drag right = navigate to the
 * right-neighbour face (cube rotates so right-neighbour becomes
 * the visible front).
 */

export type FaceId = "front" | "right" | "back" | "left" | "top" | "bottom";
export const FACES: FaceId[] = ["front", "right", "back", "left", "top", "bottom"];

/**
 * Direction-to-neighbour graph. Maps `(currentFace, direction) →
 * neighbourFace`. Mirrors a real cube unfolded with Front facing
 * the camera, Top above, etc. Verified by hand-rolling each
 * orientation.
 */
export const NEIGHBORS: Record<FaceId, Record<"up" | "down" | "left" | "right", FaceId>> = {
  front: { up: "top", down: "bottom", left: "left", right: "right" },
  right: { up: "top", down: "bottom", left: "front", right: "back" },
  back: { up: "top", down: "bottom", left: "right", right: "left" },
  left: { up: "top", down: "bottom", left: "back", right: "front" },
  top: { up: "back", down: "front", left: "left", right: "right" },
  bottom: { up: "front", down: "back", left: "left", right: "right" },
};

export const MAX_AGENTS_PER_FACE = 4;

interface ClustersStore {
  /** Cluster names keyed by face id. */
  names: Record<FaceId, string>;
  /** Agent slugs assigned to each face, in display order. */
  agents: Record<FaceId, string[]>;
  /** Has the migration of "all current agents → front face" run? */
  bootstrapped: boolean;

  setName: (face: FaceId, name: string) => void;
  /**
   * Place an agent on a face (appends; no-op if already on that
   * face; bumps off the previous face if the agent was elsewhere).
   * Cap at `MAX_AGENTS_PER_FACE` per face — extras spill back to
   * the unassigned set (UI can surface them as "needs a home").
   */
  assign: (face: FaceId, slug: string) => void;
  /**
   * Migration sink — call once installed-agents are known. Every
   * slug not currently on any face is appended to the front face
   * (or the next face that has a free slot if front is full). No-op
   * after `bootstrapped` flips to `true`.
   */
  ensureBootstrap: (allInstalledSlugs: string[]) => void;
  /** Remove an agent from whatever face it's on. */
  remove: (slug: string) => void;
  /**
   * Hydrate from the server. Idempotent — safe to call on every
   * mount; the in-memory state is replaced wholesale with the
   * server's view (which is itself the last value the client wrote
   * via the debounced PUT).
   */
  syncFromServer: () => Promise<void>;
}

const STORAGE_KEY = "ironlore.agentClusters.v1";

const DEFAULT_NAMES: Record<FaceId, string> = {
  front: "Defaults",
  right: "Cluster B",
  back: "Cluster C",
  left: "Cluster D",
  top: "Cluster E",
  bottom: "Cluster F",
};

interface PersistedShape {
  names: Record<FaceId, string>;
  agents: Record<FaceId, string[]>;
  bootstrapped: boolean;
}

function loadFromStorage(): PersistedShape | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedShape;
    // Sanity-check the shape — a partial / corrupted blob falls
    //  through to defaults rather than throwing on first read.
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.names !== "object" ||
      typeof parsed.agents !== "object"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveToStorage(state: PersistedShape): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* localStorage unavailable / quota exceeded — silently drop */
  }
}

/**
 * Debounced server PUT — every mutation calls `schedulePush()` which
 * resets a 600 ms timer; the actual round-trip fires once the user
 * has stopped editing. Failures are silent: the localStorage cache
 * already has the new state, and the next mutation will re-attempt
 * the PUT.
 */
let pushTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePush(state: PersistedShape): void {
  if (typeof window === "undefined") return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    void saveAgentClusters(state).catch(() => {
      /* network failed — localStorage holds the change; the next
       *  edit will retry. Not surfaced to the user since the cube
       *  itself reflects the new state immediately. */
    });
  }, 600);
}

const initialAgents: Record<FaceId, string[]> = {
  front: [],
  right: [],
  back: [],
  left: [],
  top: [],
  bottom: [],
};

const persisted = typeof window === "undefined" ? null : loadFromStorage();

export const useAgentClustersStore = create<ClustersStore>((set, get) => ({
  names: persisted?.names ?? { ...DEFAULT_NAMES },
  agents: persisted?.agents ?? { ...initialAgents },
  bootstrapped: persisted?.bootstrapped ?? false,

  setName: (face, name) => {
    set((s) => {
      const nextNames = { ...s.names, [face]: name };
      const persisted = { names: nextNames, agents: s.agents, bootstrapped: s.bootstrapped };
      saveToStorage(persisted);
      schedulePush(persisted);
      return { names: nextNames };
    });
  },

  assign: (face, slug) => {
    set((s) => {
      // Bump off any prior face first.
      const stripped: Record<FaceId, string[]> = { ...s.agents };
      for (const f of FACES) {
        stripped[f] = stripped[f].filter((sl) => sl !== slug);
      }
      const targetList = stripped[face];
      if (targetList.length >= MAX_AGENTS_PER_FACE) {
        // No free slot — leave the agent unassigned. The cube's
        //  "needs a home" surface can later prompt the user.
        return { agents: stripped };
      }
      stripped[face] = [...targetList, slug];
      const persisted = { names: s.names, agents: stripped, bootstrapped: s.bootstrapped };
      saveToStorage(persisted);
      schedulePush(persisted);
      return { agents: stripped };
    });
  },

  ensureBootstrap: (allInstalledSlugs) => {
    const s = get();
    if (s.bootstrapped) return;
    const placed = new Set<string>();
    for (const f of FACES) for (const sl of s.agents[f]) placed.add(sl);
    const remaining = allInstalledSlugs.filter((sl) => !placed.has(sl));
    const nextAgents: Record<FaceId, string[]> = {
      front: [...s.agents.front],
      right: [...s.agents.right],
      back: [...s.agents.back],
      left: [...s.agents.left],
      top: [...s.agents.top],
      bottom: [...s.agents.bottom],
    };
    for (const slug of remaining) {
      // Walk faces in order, drop the slug on the first one with
      //  a free slot. Defaults dump onto Front first; overflow
      //  spills sequentially.
      const target = FACES.find((f) => nextAgents[f].length < MAX_AGENTS_PER_FACE);
      if (target) nextAgents[target].push(slug);
      // No room across all 6 faces (24 agents): silently drop. The
      //  user can still see the agent through Settings → Agents
      //  even if it's not on the cube.
    }
    const nextState = { names: s.names, agents: nextAgents, bootstrapped: true };
    saveToStorage(nextState);
    schedulePush(nextState);
    set({ agents: nextAgents, bootstrapped: true });
  },

  remove: (slug) => {
    set((s) => {
      const next: Record<FaceId, string[]> = { ...s.agents };
      for (const f of FACES) {
        next[f] = next[f].filter((sl) => sl !== slug);
      }
      const persisted = { names: s.names, agents: next, bootstrapped: s.bootstrapped };
      saveToStorage(persisted);
      schedulePush(persisted);
      return { agents: next };
    });
  },

  syncFromServer: async () => {
    try {
      const doc = await fetchAgentClusters();
      // Server is authoritative — replace in-memory state. The
      //  localStorage cache is rewritten so a subsequent reload
      //  paints with the freshest known layout before the next
      //  fetch lands.
      const persisted: PersistedShape = {
        names: doc.names,
        agents: doc.agents,
        bootstrapped: doc.bootstrapped,
      };
      saveToStorage(persisted);
      set({ names: doc.names, agents: doc.agents, bootstrapped: doc.bootstrapped });
    } catch {
      /* offline / 404 — keep whatever localStorage gave us. */
    }
  },
}));

/**
 * Canonical CSS rotation that brings a given face to the camera.
 * Used by `AgentsCube` to animate the cube via CSS transitions
 * between two of these target rotations.
 */
export const FACE_ROTATIONS: Record<FaceId, { x: number; y: number }> = {
  front: { x: 0, y: 0 },
  right: { x: 0, y: -90 },
  back: { x: 0, y: -180 },
  left: { x: 0, y: 90 },
  top: { x: -90, y: 0 },
  bottom: { x: 90, y: 0 },
};
