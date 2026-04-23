import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_DIR, AGENTS_LIBRARY_DIR } from "@ironlore/core";

/**
 * One library-template row surfaced to the client's Settings → Agents
 * "Library" section. Every field is optional except `slug` — personas
 * written by hand may omit department, emoji, or a polished
 * description, and a sparse row is still better than hiding the
 * template entirely.
 */
export interface LibraryTemplate {
  slug: string;
  name: string | null;
  emoji: string | null;
  role: string | null;
  department: string | null;
  heartbeat: string | null;
  /** One-liner for the card body. Falls back to `role` when absent. */
  description: string | null;
}

/**
 * Enumerate every library persona template available for activation.
 *
 * Walks both layouts shipped by `seed.ts` and `seed-agents.ts`:
 *   - flat: `data/.agents/.library/<slug>.md`
 *   - directory: `data/.agents/.library/<slug>/persona.md`
 *
 * Filters out templates whose activated counterpart already exists at
 * `data/.agents/<slug>/persona.md` — once an agent is running, trying
 * to activate the template again would 409 through `activateAgent()`,
 * so the UI shouldn't offer it.
 *
 * Parsing is a minimal regex sweep — the same fast path the executor
 * and heartbeat scheduler use — to avoid pulling `js-yaml` into the
 * Settings route. A malformed persona yields all-null fields rather
 * than crashing the endpoint; the slug alone is enough for the user
 * to recognize it.
 */
export function listLibraryTemplates(dataDir: string): LibraryTemplate[] {
  const libDir = join(dataDir, AGENTS_LIBRARY_DIR);
  if (!existsSync(libDir)) return [];

  const activatedDir = join(dataDir, AGENTS_DIR);
  const activated = new Set<string>();
  if (existsSync(activatedDir)) {
    for (const entry of readdirSync(activatedDir)) {
      if (entry.startsWith(".")) continue;
      if (existsSync(join(activatedDir, entry, "persona.md"))) activated.add(entry);
    }
  }

  const templates: LibraryTemplate[] = [];
  for (const entry of readdirSync(libDir)) {
    // Resolve both layouts to a single (slug, file path) pair.
    const full = join(libDir, entry);
    let slug: string;
    let filePath: string;
    if (entry.endsWith(".md")) {
      slug = entry.slice(0, -".md".length);
      filePath = full;
    } else if (statSync(full).isDirectory()) {
      slug = entry;
      filePath = join(full, "persona.md");
      if (!existsSync(filePath)) continue;
    } else {
      continue;
    }
    if (activated.has(slug)) continue;

    templates.push(parseTemplate(slug, filePath));
  }

  // Stable order: department first, then slug. Department stays at the
  // top so the UI can group visually without another sort pass.
  templates.sort((a, b) => {
    const ad = a.department ?? "￿"; // unclassified last
    const bd = b.department ?? "￿";
    if (ad !== bd) return ad.localeCompare(bd);
    return a.slug.localeCompare(b.slug);
  });
  return templates;
}

function parseTemplate(slug: string, filePath: string): LibraryTemplate {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return emptyTemplate(slug);
  }
  const match = /^---[^\n]*\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match?.[1]) return emptyTemplate(slug);
  const fm = match[1];

  return {
    slug,
    name: pickField(fm, "name"),
    emoji: pickField(fm, "emoji"),
    role: pickField(fm, "role"),
    department: pickField(fm, "department"),
    heartbeat: pickField(fm, "heartbeat"),
    description: pickField(fm, "description") ?? pickField(fm, "role"),
  };
}

function emptyTemplate(slug: string): LibraryTemplate {
  return {
    slug,
    name: null,
    emoji: null,
    role: null,
    department: null,
    heartbeat: null,
    description: null,
  };
}

/**
 * Pull a top-level scalar field out of a YAML frontmatter block. Strips
 * matched quotes from the value and returns null when the key is
 * absent. Good enough for the handful of fields the Settings card
 * needs; the full YAML parser is only worth the cost on the
 * observability code path where the whole projection matters.
 */
function pickField(fm: string, key: string): string | null {
  const re = new RegExp(`^${key}\\s*:\\s*"?(.+?)"?\\s*$`, "m");
  const m = re.exec(fm);
  return m?.[1]?.trim() ?? null;
}
