import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_DIR, AGENTS_LIBRARY_DIR, AGENTS_SHARED_DIR } from "@ironlore/core";
import type Database from "better-sqlite3";

/**
 * Seed the agent filesystem layout and agent_state rows for the
 * default General + Editor agents.
 *
 * Called on startup alongside the existing `seed()` function. The
 * agent layout is:
 *
 *   data/.agents/general/persona.md + memory/ + sessions/
 *   data/.agents/editor/persona.md + memory/ + sessions/
 *   data/.agents/.library/<templates>
 *   data/.agents/.shared/skills/
 *
 * See docs/04-ai-and-agents.md §Agent filesystem layout and
 * §Default agents.
 */
export function seedAgents(dataDir: string, jobsDb: Database.Database): void {
  const now = Date.now();

  // General agent — read-only Ask mode, no mutation tools.
  seedAgentDir(dataDir, "general", {
    name: "General",
    emoji: "🔍",
    role: "Read-only assistant — searches pages, cites block-level sources, never mutates content",
    provider: "anthropic",
    active: true,
    scope: { pages: ["/**"] },
  });

  // Editor agent — full mutation tools, dry-run by default.
  seedAgentDir(dataDir, "editor", {
    name: "Editor",
    emoji: "✏️",
    role: "Page editor — structured edits with dry-run preview",
    provider: "anthropic",
    active: true,
    scope: { pages: ["/**"] },
    writable_kinds: ["page", "wiki"],
  });

  // Library template: Researcher with thesis skill.
  seedLibraryTemplate(dataDir, "researcher", {
    name: "Researcher",
    emoji: "🔬",
    role: "Thesis-driven research — decomposes claims, searches for evidence, produces verdicts",
    active: false,
    scope: { pages: ["/**"] },
    writable_kinds: ["source", "wiki"],
  });

  // Shared skills directory.
  const sharedSkillsDir = join(dataDir, AGENTS_SHARED_DIR, "skills");
  mkdirSync(sharedSkillsDir, { recursive: true });

  // Ensure agent_state rows exist.
  const ensureState = jobsDb.prepare(
    `INSERT OR IGNORE INTO agent_state (project_id, slug, status, updated_at)
     VALUES (?, ?, 'active', ?)`,
  );
  ensureState.run("main", "general", now);
  ensureState.run("main", "editor", now);
}

function seedAgentDir(dataDir: string, slug: string, meta: Record<string, unknown>): void {
  const agentDir = join(dataDir, AGENTS_DIR, slug);
  const personaPath = join(agentDir, "persona.md");

  if (existsSync(personaPath)) return; // Non-destructive.

  mkdirSync(join(agentDir, "memory"), { recursive: true });
  mkdirSync(join(agentDir, "sessions"), { recursive: true });
  mkdirSync(join(agentDir, "skills"), { recursive: true });

  const frontmatter = buildFrontmatter(slug, meta);
  const body =
    typeof meta.role === "string"
      ? `\nYou are the ${meta.name} assistant for this Ironlore knowledge base.\n${meta.role}.\n`
      : "";
  writeFileSync(personaPath, `${frontmatter}\n${body}`, "utf-8");
}

function seedLibraryTemplate(dataDir: string, slug: string, meta: Record<string, unknown>): void {
  const templateDir = join(dataDir, AGENTS_LIBRARY_DIR, slug);
  const personaPath = join(templateDir, "persona.md");

  if (existsSync(personaPath)) return;

  mkdirSync(templateDir, { recursive: true });

  const frontmatter = buildFrontmatter(slug, meta);
  writeFileSync(personaPath, frontmatter, "utf-8");
}

function buildFrontmatter(slug: string, meta: Record<string, unknown>): string {
  const lines = ["---"];
  lines.push(`name: ${meta.name ?? slug}`);
  lines.push(`slug: ${slug}`);
  if (meta.emoji) lines.push(`emoji: "${meta.emoji}"`);
  if (meta.role) lines.push(`role: "${meta.role}"`);
  if (meta.provider) lines.push(`provider: ${meta.provider}`);
  lines.push(`active: ${meta.active ?? false}`);
  if (meta.scope)
    lines.push(`scope:\n  pages: ${JSON.stringify((meta.scope as { pages: string[] }).pages)}`);
  if (meta.writable_kinds) lines.push(`writable_kinds: ${JSON.stringify(meta.writable_kinds)}`);
  lines.push("---");
  return lines.join("\n");
}
