import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENTS_DIR,
  AGENTS_LIBRARY_DIR,
  AGENTS_SHARED_DIR,
  composeBoundariesSection,
} from "@ironlore/core";
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

  // Librarian — the read-mostly default agent. Slug stays "general"
  //  for the reserved routing key + back-compat; the user-facing
  //  name is "Librarian" because that's the actual role (find + cite,
  //  no mutations). Per docs/04-ai-and-agents.md §Default agents,
  //  this agent is seeded into every project and not deletable.
  seedAgentDir(dataDir, "general", {
    name: "Librarian",
    emoji: "📚",
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
    skills: ["thesis"],
  });

  // Researcher's agent-local `thesis.md` skill — the dedicated tooling
  //  that earns the persona its place in the curated library per
  //  docs/04-ai-and-agents.md §Default agents. Encodes thesis-driven
  //  investigation: decompose → search supporting → search opposing →
  //  compile with evidence tables → produce verdict. The
  //  anti-confirmation-bias rule is the load-bearing piece — without
  //  it the agent rationalises the prior round instead of stress-testing
  //  it.
  seedLibrarySkill(dataDir, "researcher", "thesis.md", THESIS_SKILL_BODY);

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
  const intro =
    typeof meta.role === "string"
      ? `\nYou are the ${meta.name} assistant for this Ironlore knowledge base.\n${meta.role}.\n\n`
      : "\n";

  // Boundaries section — same composer the Visual Agent Builder
  //  uses, so default agents and custom-built ones produce
  //  identically-shaped sections.
  const scopePages = Array.isArray((meta.scope as { pages?: string[] } | undefined)?.pages)
    ? ((meta.scope as { pages: string[] }).pages as string[])
    : ["/**"];
  const writableKinds = Array.isArray(meta.writable_kinds) ? (meta.writable_kinds as string[]) : [];
  const boundaries = composeBoundariesSection({
    scopePages,
    canEditPages: writableKinds.length > 0,
    reviewBeforeMerge: meta.review_mode === "inbox",
    heartbeat: typeof meta.heartbeat === "string" ? meta.heartbeat : undefined,
  });

  writeFileSync(personaPath, `${frontmatter}\n${intro}${boundaries}`, "utf-8");
}

function seedLibraryTemplate(dataDir: string, slug: string, meta: Record<string, unknown>): void {
  const templateDir = join(dataDir, AGENTS_LIBRARY_DIR, slug);
  const personaPath = join(templateDir, "persona.md");

  if (existsSync(personaPath)) return;

  mkdirSync(templateDir, { recursive: true });

  const frontmatter = buildFrontmatter(slug, meta);
  writeFileSync(personaPath, frontmatter, "utf-8");
}

/**
 * Seed an agent-local skill file under
 * `.agents/.library/<slug>/skills/<filename>`. Non-destructive: an
 * existing file is left untouched so a user's edits survive a restart.
 */
function seedLibrarySkill(dataDir: string, slug: string, filename: string, body: string): void {
  const skillsDir = join(dataDir, AGENTS_LIBRARY_DIR, slug, "skills");
  const skillPath = join(skillsDir, filename);
  if (existsSync(skillPath)) return;
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(skillPath, body, "utf-8");
}

function buildFrontmatter(slug: string, meta: Record<string, unknown>): string {
  const lines = ["---"];
  lines.push(`name: ${meta.name ?? slug}`);
  lines.push(`slug: ${slug}`);
  if (meta.emoji) lines.push(`emoji: "${meta.emoji}"`);
  if (meta.role) lines.push(`role: "${meta.role}"`);
  if (meta.provider) lines.push(`provider: ${meta.provider}`);
  lines.push(`active: ${meta.active ?? false}`);
  if (Array.isArray(meta.skills) && (meta.skills as string[]).length > 0) {
    lines.push(`skills: [${(meta.skills as string[]).join(", ")}]`);
  }
  if (meta.scope)
    lines.push(`scope:\n  pages: ${JSON.stringify((meta.scope as { pages: string[] }).pages)}`);
  if (meta.writable_kinds) lines.push(`writable_kinds: ${JSON.stringify(meta.writable_kinds)}`);
  lines.push("---");
  return lines.join("\n");
}

/**
 * `thesis.md` — the researcher persona's dedicated skill. Encodes
 * thesis-driven investigation per docs/04-ai-and-agents.md §Default
 * agents → Library trio:
 *
 *   "decompose a claim into key variables → search for supporting
 *    evidence → search for opposing evidence → compile with evidence
 *    tables → produce a verdict (`supported` / `contradicted` / `mixed`
 *    / `insufficient`). An anti-confirmation-bias rule … forces
 *    follow-up rounds to focus on the *weaker* side of the prior
 *    round's evidence."
 *
 * Non-destructive seeding: a user's edits to this file survive
 * restart — `seedLibrarySkill` no-ops when the file exists.
 */
const THESIS_SKILL_BODY = `---
name: Thesis-driven investigation
description: Decompose a claim → gather supporting + opposing evidence → produce a verdict.
---

# Thesis-driven investigation

The Researcher persona's working method. Use this skill when the user
poses a claim that needs grounding rather than a question with a
single factual answer.

## Workflow

1. **Decompose the claim** into 3–5 key variables. Each variable is a
   sub-claim that, taken together, decides the verdict. Write them
   as a short bulleted list at the top of your response so the user
   can see the shape of the investigation before any evidence
   arrives.

2. **Search for supporting evidence.** For each variable run
   \`kb.search\` (and \`kb.semantic_search\` when an embedding
   provider is configured) for blocks that argue *for* the claim.
   Cite each finding as \`[[page#blk_…]]\`. Stop at ~5 strong
   citations per variable — the goal is calibrated coverage, not
   exhaustive collection.

3. **Search for opposing evidence.** Same protocol, opposite stance.
   This is the load-bearing step — most failures of this skill come
   from skipping it because the supporting evidence "looked
   convincing." Spend at least as much retrieval budget here as on
   step 2.

4. **Compile evidence tables.** One per variable, with columns
   \`Claim\`, \`Source\`, \`Strength (low/medium/high)\`. Strength
   reflects the source's credibility (peer review > primary
   research > secondary synthesis > aggregator) crossed with the
   directness of the citation. Include opposing rows.

5. **Produce a verdict** with one of four labels:
   - \`supported\` — supporting evidence dominates and the strongest
     opposing citations have been addressed.
   - \`contradicted\` — opposing evidence dominates.
   - \`mixed\` — both sides carry strong citations; the claim depends
     on context the investigation surfaced explicitly.
   - \`insufficient\` — no side carries enough citations to ground a
     verdict; recommend specific sources to ingest.

## Anti-confirmation-bias rule

When the user asks a follow-up round on a claim you've already
investigated, **focus the round on the *weaker* side of the prior
verdict's evidence**. If the prior round landed \`supported\` with
8 supporting and 3 opposing citations, the follow-up reads opposing
sources first. Without this rule the persona drifts into
rationalising the prior round instead of stress-testing it.

## What this skill does NOT do

- Write new \`kind: source\` pages. Source ingestion is
  \`ingest.md\`'s job; this skill only *reads* sources and produces
  a synthesis page citing them.
- Resolve contradictions. When opposing evidence is itself in
  contradiction (Source A says X, Source B says ¬X, both look
  credible), surface both in the evidence table and label the
  verdict \`mixed\` — let the human reviewer decide.
- Run autonomously. The persona ships with \`active: false\` because
  thesis-driven investigation reads best as an interactive
  conversation, not a scheduled batch.
`;
