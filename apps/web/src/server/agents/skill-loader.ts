import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_DIR, AGENTS_SHARED_DIR, SKILLS_SUBDIR } from "@ironlore/core";

/**
 * Read the markdown bodies of the skills declared in an agent's
 * persona frontmatter, returning a single block ready to append to the
 * agent's system prompt.
 *
 * Resolution order (per docs/04-ai-and-agents.md §Agent filesystem
 * layout): **agent-local first, then `.shared/`**. A skill named
 * `brand-voice.md` in an agent's own `skills/` shadows the project-wide
 * one.
 *
 * Declaration is **opt-in**: a persona must explicitly list skill
 * names under `skills:` frontmatter to load them. Loading every
 * markdown file in `.shared/skills/` by default would bloat prompts
 * and confuse agents with guidance meant for other roles.
 *
 * Missing skills are silently dropped — the prompt survives; a
 * misnamed or unshipped skill does not tank the run. Callers that
 * want to surface the miss can compare `declaredSkills.length` to the
 * number of blocks in the returned string.
 *
 * Skill names are matched to files by appending `.md` if the caller
 * didn't, so `skills: [lint]` and `skills: [lint.md]` both resolve.
 */
export function loadSkills(
  dataRoot: string,
  agentSlug: string,
  declaredSkills: readonly string[] | null | undefined,
): string {
  if (!declaredSkills || declaredSkills.length === 0) return "";

  const localDir = join(dataRoot, AGENTS_DIR, agentSlug, SKILLS_SUBDIR);
  const sharedDir = join(dataRoot, AGENTS_SHARED_DIR, SKILLS_SUBDIR);

  const blocks: string[] = [];
  for (const declared of declaredSkills) {
    const filename = declared.endsWith(".md") ? declared : `${declared}.md`;
    const body = readSkill(join(localDir, filename)) ?? readSkill(join(sharedDir, filename));
    if (body !== null) blocks.push(body);
  }

  if (blocks.length === 0) return "";

  // Heading gives the model a clear delimiter between persona voice
  // and loaded skill guidance. The trailing newline is intentional so
  // downstream concatenation (`persona\n${skills}`) doesn't collapse.
  return `\n\n# Loaded skills\n\n${blocks.join("\n\n")}\n`;
}

/** Read a skill file and strip its YAML frontmatter. Returns null if absent. */
function readSkill(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8");
  const stripped = raw.replace(/^---[\s\S]*?^---\r?\n?/m, "").trim();
  return stripped || null;
}
