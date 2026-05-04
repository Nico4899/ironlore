import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-project cluster organisation for the §01 Active runs cube on
 * Home. Six named slots, each holding an ordered list of agent slugs.
 * Persisted as a single JSON file in the project's `.ironlore/`
 * derived-state directory so the layout survives reload, restart,
 * and (eventually) sync between clients on a shared install.
 *
 * The shape mirrors `useAgentClustersStore` 1:1 — keeping the wire
 * format identical to the in-memory model lets the client store
 * round-trip without translation.
 */

export type ClusterFaceId = "front" | "right" | "back" | "left" | "top" | "bottom";

export interface AgentClustersDoc {
  names: Record<ClusterFaceId, string>;
  agents: Record<ClusterFaceId, string[]>;
  bootstrapped: boolean;
  /** Server-side last-write timestamp; used by the client to skip
   *  the localStorage cache when the server has fresher state. */
  updatedAt: number;
}

const FACES: ClusterFaceId[] = ["front", "right", "back", "left", "top", "bottom"];

const DEFAULT_NAMES: Record<ClusterFaceId, string> = {
  front: "Defaults",
  right: "Cluster B",
  back: "Cluster C",
  left: "Cluster D",
  top: "Cluster E",
  bottom: "Cluster F",
};

const FILENAME = "agent-clusters.json";

function clustersPath(projectDir: string): string {
  return join(projectDir, ".ironlore", FILENAME);
}

function defaultDoc(): AgentClustersDoc {
  const agents: Record<ClusterFaceId, string[]> = {
    front: [],
    right: [],
    back: [],
    left: [],
    top: [],
    bottom: [],
  };
  return { names: { ...DEFAULT_NAMES }, agents, bootstrapped: false, updatedAt: 0 };
}

/**
 * Best-effort sanitise — accepts anything claimed to be a clusters
 * doc, drops unknown faces, coerces missing keys to defaults, and
 * caps slug arrays so a malicious client can't write 10 MB of JSON
 * via repeated PUTs. The cap (24 = 6 faces × 4 max) matches the UI
 * `MAX_AGENTS_PER_FACE` invariant.
 */
function sanitiseDoc(input: unknown): AgentClustersDoc {
  const fallback = defaultDoc();
  if (!input || typeof input !== "object") return fallback;
  const raw = input as Partial<AgentClustersDoc>;

  const names: Record<ClusterFaceId, string> = { ...DEFAULT_NAMES };
  if (raw.names && typeof raw.names === "object") {
    for (const f of FACES) {
      const v = (raw.names as Record<string, unknown>)[f];
      if (typeof v === "string" && v.length > 0 && v.length <= 64) names[f] = v;
    }
  }

  const agents: Record<ClusterFaceId, string[]> = {
    front: [],
    right: [],
    back: [],
    left: [],
    top: [],
    bottom: [],
  };
  if (raw.agents && typeof raw.agents === "object") {
    for (const f of FACES) {
      const arr = (raw.agents as Record<string, unknown>)[f];
      if (Array.isArray(arr)) {
        const cleaned: string[] = [];
        for (const slug of arr) {
          if (typeof slug !== "string") continue;
          if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(slug)) continue;
          if (cleaned.includes(slug)) continue;
          cleaned.push(slug);
          if (cleaned.length >= 4) break;
        }
        agents[f] = cleaned;
      }
    }
  }

  return {
    names,
    agents,
    bootstrapped: Boolean(raw.bootstrapped),
    updatedAt: Date.now(),
  };
}

/**
 * Read the cluster doc for a project. Returns the default shape
 * (empty cluster, default names, `bootstrapped: false`) if the
 * file is missing or corrupted — the client treats that as a
 * first-run signal and runs `ensureBootstrap()` on its end.
 */
export function loadClusters(projectDir: string): AgentClustersDoc {
  const path = clustersPath(projectDir);
  if (!existsSync(path)) return defaultDoc();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    return sanitiseDoc(parsed);
  } catch {
    return defaultDoc();
  }
}

/**
 * Atomic-ish write: serialise, write, fsync isn't required here —
 * the file is derived state and lossy writes during a crash are
 * acceptable. The client re-runs the migration on the next start.
 */
export function saveClusters(projectDir: string, input: unknown): AgentClustersDoc {
  const doc = sanitiseDoc(input);
  const dir = join(projectDir, ".ironlore");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(clustersPath(projectDir), JSON.stringify(doc, null, 2), "utf8");
  return doc;
}
