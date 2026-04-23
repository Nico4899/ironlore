import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_DIR, AGENTS_LIBRARY_DIR } from "@ironlore/core";
import type Database from "better-sqlite3";

/**
 * Activate a library persona template: copy `.library/<slug>.md` (or
 * `.library/<slug>/persona.md` for directory-style templates) into
 * `data/.agents/<slug>/persona.md`, flip `active: true` in the copy,
 * seed the agent's working directories, and create the `agent_state`
 * row so rate rails start tracking.
 *
 * Non-destructive: if the agent directory already exists, returns
 * `{ ok: false, code: 409 }` rather than overwriting the user's
 * activated copy. Callers who want to re-seed must delete the
 * directory first.
 *
 * See docs/04-ai-and-agents.md §Wiki-gardener agent and
 * §Agent filesystem layout. Tracked in the Phase 11 roadmap.
 */
export type ActivationResult =
  | { ok: true; personaPath: string }
  | { ok: false; code: 404 | 409; error: string };

export function activateAgent(
  dataDir: string,
  jobsDb: Database.Database,
  projectId: string,
  slug: string,
): ActivationResult {
  const templatePath = resolveTemplatePath(dataDir, slug);
  if (!templatePath) {
    return {
      ok: false,
      code: 404,
      error: `No library template found for '${slug}'. Expected ${AGENTS_LIBRARY_DIR}/${slug}.md or ${AGENTS_LIBRARY_DIR}/${slug}/persona.md.`,
    };
  }

  const agentDir = join(dataDir, AGENTS_DIR, slug);
  const personaPath = join(agentDir, "persona.md");
  if (existsSync(personaPath)) {
    return {
      ok: false,
      code: 409,
      error: `Agent '${slug}' is already activated at ${personaPath}.`,
    };
  }

  // Create the agent's working tree (memory/, sessions/, skills/).
  mkdirSync(join(agentDir, "memory"), { recursive: true });
  mkdirSync(join(agentDir, "sessions"), { recursive: true });
  mkdirSync(join(agentDir, "skills"), { recursive: true });

  // Copy the template body and flip active: true. The templates ship
  // with `active: false`; running them requires this flip so there's
  // no ambiguity about whether a library copy is live.
  const raw = readFileSync(templatePath, "utf-8");
  const activated = raw.replace(/^active:\s*false\s*$/m, "active: true");
  writeFileSync(personaPath, activated, "utf-8");

  // Create the agent_state row so rails.canEnqueue() has a target to
  // read from. INSERT OR IGNORE mirrors rails.ensureState(); we
  // duplicate the statement rather than importing AgentRails to keep
  // this module dependency-free for testing.
  jobsDb
    .prepare(
      `INSERT OR IGNORE INTO agent_state (project_id, slug, status, updated_at)
       VALUES (?, ?, 'active', ?)`,
    )
    .run(projectId, slug, Date.now());

  return { ok: true, personaPath };
}

/**
 * Return the on-disk path of the library template for a given slug,
 * or null if neither layout exists. Handles both the single-file and
 * directory template conventions shipped by `seed.ts`.
 */
function resolveTemplatePath(dataDir: string, slug: string): string | null {
  const flat = join(dataDir, AGENTS_LIBRARY_DIR, `${slug}.md`);
  if (existsSync(flat)) return flat;
  const dir = join(dataDir, AGENTS_LIBRARY_DIR, slug, "persona.md");
  if (existsSync(dir)) return dir;
  return null;
}
