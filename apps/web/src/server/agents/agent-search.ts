import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_DIR } from "@ironlore/core";

/**
 * One row of agent-search output. Mirrors the shape Settings → Agents
 * already consumes from `listLibraryTemplates`, with an additional
 * `slug` lookup so the Cmd+K dialog can show a stable identifier next
 * to the polished name. Every field beyond `slug` may be null (sparse
 * personas still surface so users can recognize hand-written ones).
 */
export interface AgentSearchHit {
  slug: string;
  name: string | null;
  emoji: string | null;
  role: string | null;
  description: string | null;
  /** True when the persona has `paused: true` or `active: false`. Lets the UI grey it out. */
  paused: boolean;
}

/**
 * Search installed agents by free-text query. Walks
 * `data/.agents/<slug>/persona.md` for every non-`.library` slug,
 * extracts a small frontmatter projection, and returns rows whose
 * slug / name / role / description contain the query (case-insensitive
 * substring match). Empty query → all agents, ordered by slug.
 *
 * Cheap parsing path — same regex sweep `library.ts` uses — so the
 * Cmd+K dialog can call this without pulling `js-yaml` into the
 * search hot path. A malformed persona yields all-null fields rather
 * than dropping the agent entirely; the user can still recognize it
 * by slug.
 */
export function searchInstalledAgents(dataDir: string, query: string): AgentSearchHit[] {
  const agentsDir = join(dataDir, AGENTS_DIR);
  if (!existsSync(agentsDir)) return [];

  const trimmed = query.trim().toLowerCase();
  const hits: AgentSearchHit[] = [];

  let entries: string[];
  try {
    entries = readdirSync(agentsDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    // Skip dotfiles (`.library`, `.shared`, `.evolver` queue dirs etc.).
    if (entry.startsWith(".")) continue;

    const slugDir = join(agentsDir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(slugDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    const persona = join(slugDir, "persona.md");
    if (!existsSync(persona)) continue;

    const hit = parsePersona(entry, persona);
    if (!matchesQuery(hit, trimmed)) continue;
    hits.push(hit);
  }

  // Stable order so the Cmd+K dialog presents the same list across
  //  identical queries. Slug-asc — the user's mental key.
  hits.sort((a, b) => a.slug.localeCompare(b.slug));
  return hits;
}

function matchesQuery(hit: AgentSearchHit, q: string): boolean {
  if (!q) return true;
  const haystack = [hit.slug, hit.name, hit.role, hit.description]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

function parsePersona(slug: string, filePath: string): AgentSearchHit {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return emptyHit(slug);
  }
  const match = /^---[^\n]*\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match?.[1]) return emptyHit(slug);
  const fm = match[1];

  return {
    slug,
    name: pickField(fm, "name"),
    emoji: pickField(fm, "emoji"),
    role: pickField(fm, "role"),
    description: pickField(fm, "description") ?? pickField(fm, "role"),
    paused: pickBool(fm, "paused") ?? !(pickBool(fm, "active") ?? true),
  };
}

function emptyHit(slug: string): AgentSearchHit {
  return {
    slug,
    name: null,
    emoji: null,
    role: null,
    description: null,
    paused: false,
  };
}

function pickField(fm: string, key: string): string | null {
  const re = new RegExp(`^${key}\\s*:\\s*"?(.+?)"?\\s*$`, "m");
  const m = re.exec(fm);
  return m?.[1]?.trim() ?? null;
}

function pickBool(fm: string, key: string): boolean | null {
  const re = new RegExp(`^${key}\\s*:\\s*(true|false)\\s*$`, "m");
  const m = re.exec(fm);
  if (!m) return null;
  return m[1] === "true";
}
