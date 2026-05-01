import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_DIR } from "@ironlore/core";
import type Database from "better-sqlite3";

/**
 * Visual Agent Builder — Phase-11 deliverable (proposal A.9.1).
 *
 * Compiles plain-language form inputs from the AgentBuilderDialog
 * UI into a `data/.agents/<slug>/persona.md` file with strictly
 * formatted YAML frontmatter, plus the working directories
 * (memory/, sessions/, skills/) and the `agent_state` rate-rail
 * row that activated library agents already get.
 *
 * Why this exists: the only path to a custom (non-library) agent
 * before Phase 11 was to hand-edit YAML frontmatter. Non-technical
 * users can't prompt-engineer the model with a blank text file —
 * they need a form that translates "Name", "Role", "constraints",
 * "scope" into a properly-shaped persona.
 *
 * Per Principle 5b (zero conversational memory) the resulting
 * agent runs against a stateless executor; per the design call in
 * Principle 5a, network egress stays project-level (this builder
 * does *not* expose a per-agent network toggle — that would
 * require a different architecture).
 */

export interface BuildPersonaInput {
  /** Display name shown in the UI (e.g. "Research Assistant"). */
  name: string;
  /** Lowercase-hyphen URL slug. Validated separately. */
  slug: string;
  /** One-line role description (frontmatter `role:`). */
  role: string;
  /**
   * "Never do this" rules from the form, one per entry. Lands as
   * a `## Constraints` section in the persona body so the model
   * sees them as part of its system prompt. Empty array → no
   * section emitted.
   */
  constraints: string[];
  /**
   * Optional path scope (frontmatter `scope.pages`). Default `/**`
   * when omitted = read/write the whole vault. Strings only — the
   * UI exposes a single text field, not glob arrays.
   */
  scopePath?: string;
  /**
   * Plain-English write-access toggle. `true` = persona can mutate
   * `kind: page` and `kind: wiki` pages; `false` = read-only
   * (writable_kinds: []). The wiki-gardener-style
   * "writable_kinds: [page, wiki]" lock is the default-on shape;
   * read-only mode is for agents that should only answer questions.
   */
  canEditPages: boolean;
  /**
   * Toggle for `review_mode: inbox`. When true, every autonomous
   * run lands on a staging branch the user reviews via the
   * existing Inbox. Off = direct-to-main commits (still gated by
   * ETag concurrency + git history, but no review step).
   */
  reviewBeforeMerge: boolean;
  /**
   * Optional cron-string heartbeat. The UI exposes presets
   * ("manual only" / "weekly" / "daily"); `undefined` means
   * manual-only (no heartbeat scheduler entry).
   */
  heartbeat?: string;
}

export type BuildPersonaResult =
  | { ok: true; personaPath: string; slug: string }
  | { ok: false; code: 400 | 409; error: string };

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
/** Reserved slugs that already have framework meaning. */
const RESERVED_SLUGS = new Set([".library", ".shared", "general", "editor"]);

export function buildPersona(
  dataDir: string,
  jobsDb: Database.Database,
  projectId: string,
  input: BuildPersonaInput,
): BuildPersonaResult {
  // ─── Validation ────────────────────────────────────────────────
  if (!input.name?.trim()) {
    return { ok: false, code: 400, error: "Name required." };
  }
  if (!input.role?.trim()) {
    return { ok: false, code: 400, error: "Role required." };
  }
  if (!SLUG_RE.test(input.slug)) {
    return {
      ok: false,
      code: 400,
      error:
        "Slug must be a lowercase-hyphen identifier (1-41 chars), starting with a letter or digit.",
    };
  }
  if (RESERVED_SLUGS.has(input.slug)) {
    return { ok: false, code: 400, error: `Slug '${input.slug}' is reserved.` };
  }

  const agentDir = join(dataDir, AGENTS_DIR, input.slug);
  const personaPath = join(agentDir, "persona.md");
  if (existsSync(personaPath)) {
    return {
      ok: false,
      code: 409,
      error: `An agent already exists at ${personaPath}. Pick a different slug.`,
    };
  }

  // ─── Compile frontmatter ───────────────────────────────────────
  const writableKinds = input.canEditPages ? "[page, wiki]" : "[]";
  const scopePath = input.scopePath?.trim() || "/**";
  const heartbeatLine = input.heartbeat ? `\nheartbeat: "${input.heartbeat}"` : "";
  const reviewLine = input.reviewBeforeMerge ? "\nreview_mode: inbox" : "";

  const frontmatter = [
    "---",
    `name: ${escapeYamlString(input.name)}`,
    `slug: ${input.slug}`,
    "type: custom",
    `role: "${escapeYamlString(input.role)}"`,
    "provider: anthropic",
    "budget: { period: monthly, runs: 40 }",
    `active: true${heartbeatLine}${reviewLine}`,
    "scope:",
    `  pages: ["${scopePath}"]`,
    "  tags: []",
    `  writable_kinds: ${writableKinds}`,
    "---",
  ].join("\n");

  // ─── Compile body ──────────────────────────────────────────────
  const boundariesSection = composeBoundariesSection({
    scopePages: [scopePath],
    canEditPages: input.canEditPages,
    reviewBeforeMerge: input.reviewBeforeMerge,
    heartbeat: input.heartbeat,
  });

  const constraintLines = input.constraints.map((c) => c.trim()).filter((c) => c.length > 0);
  const constraintsSection =
    constraintLines.length > 0
      ? `\n## Constraints\n\nThings this agent must NOT do:\n\n${constraintLines
          .map((c) => `- ${c}`)
          .join("\n")}\n`
      : "";

  const body = `
You are the ${input.name}. ${input.role}

## Responsibilities

${input.role}.

${boundariesSection}
## Guidelines

- Use structured \`kb.*\` tools for all edits
- File a journal entry at the end of each run
${constraintsSection}`;

  // ─── Write the file + create working tree + agent_state ───────
  mkdirSync(join(agentDir, "memory"), { recursive: true });
  mkdirSync(join(agentDir, "sessions"), { recursive: true });
  mkdirSync(join(agentDir, "skills"), { recursive: true });

  writeFileSync(personaPath, `${frontmatter}\n${body}`, "utf-8");

  jobsDb
    .prepare(
      `INSERT OR IGNORE INTO agent_state (project_id, slug, status, updated_at)
       VALUES (?, ?, 'active', ?)`,
    )
    .run(projectId, input.slug, Date.now());

  return { ok: true, personaPath, slug: input.slug };
}

/**
 * Escape characters that would break out of a YAML string. We
 * keep input lines on one line + drop quotes — the form's text
 * fields are scalar by construction, so a stray quote or colon
 * is the worst case worth defending against.
 */
function escapeYamlString(value: string): string {
  return value
    .trim()
    .replace(/"/g, "'")
    .replace(/[\r\n]/g, " ");
}

/**
 * Normalised input for `composeBoundariesSection`. Both the form-
 * driven `buildPersona()` path and the seeded-agent path
 * (`seed-agents.ts`) translate their inputs to this shape so the
 * Boundaries paragraph reads identically in both surfaces.
 */
export interface BoundariesInput {
  /** Path globs from `scope.pages` — at least one entry; empty list defaults to `/**`. */
  scopePages: string[];
  /** Plain-English write-access toggle. False = read-only / `writable_kinds: []`. */
  canEditPages: boolean;
  /** True ↔ `review_mode: inbox`. */
  reviewBeforeMerge: boolean;
  /** Cron string from `heartbeat:`, or undefined for manual-only. */
  heartbeat?: string;
}

/**
 * Render a `## Boundaries` section that mirrors the structural
 * gates the runtime already enforces.
 *
 * The section is the human-readable receipt of `scope.pages`,
 * `writable_kinds`, `review_mode`, and `heartbeat` — not enforcement
 * itself. Enforcement lives in code (`assertWritableKind` in
 * tools/writable-kinds-gate.ts, the `review_mode` branch in the
 * commit worker, the heartbeat scheduler). The text exists so a
 * non-technical user can read the agent's persona.md and understand
 * what the agent is and isn't allowed to do, without having to read
 * YAML or trace runtime gates.
 *
 * Used by both the Visual Agent Builder (form-driven custom agents)
 * and `seedAgentDir` in seed-agents.ts (default Librarian + Editor)
 * so both surfaces produce the same shape.
 */
export function composeBoundariesSection(input: BoundariesInput): string {
  const scope =
    input.scopePages.length === 0
      ? "`/**` (whole vault)"
      : input.scopePages.map((p) => `\`${p}\``).join(", ");

  const writeAccess = input.canEditPages
    ? "Can edit `kind: page` and `kind: wiki` pages within scope. **Cannot** modify `kind: source` files — those are immutable to agents."
    : "Read-only. **No mutations** — the agent searches and cites; the user does the writing.";

  const review = input.reviewBeforeMerge
    ? "Every change lands on a staging branch (`agents/<slug>/<run-id>`) for **Inbox approval** before merging to `main`."
    : "Changes commit directly to `main` (still ETag-gated, still git-tracked, just no review step).";

  const schedule = humanizeHeartbeat(input.heartbeat);

  return `## Boundaries

- **Scope:** ${scope}
- **Write access:** ${writeAccess}
- **Review:** ${review}
- **Schedule:** ${schedule}

These boundaries are **enforced by the runtime**, not advisory text. The frontmatter \`scope.pages\`, \`writable_kinds\`, \`review_mode\`, and \`heartbeat\` fields above are the structural form; this section is the human-readable receipt.
`;
}

/**
 * Map a cron expression back to the same plain-English label the
 * Visual Agent Builder shows in its Schedule dropdown. Custom cron
 * strings that don't match a known preset render as `Custom cron:
 * \`<expr>\`` so the receipt is still honest about scheduling.
 */
function humanizeHeartbeat(cron: string | undefined): string {
  if (!cron) return "Manual only — runs only when you invoke the agent";
  const presets: Record<string, string> = {
    "0 * * * *": "Every hour",
    "0 9 * * *": "Daily at 09:00",
    "0 9 * * 1-5": "Weekdays at 09:00",
    "0 9 * * 1": "Weekly (Mon 09:00)",
    "0 8 * * 1": "Weekly (Mon 08:00)",
    "0 6 * * 0": "Weekly (Sun 06:00)",
    "0 7 * * 0": "Weekly (Sun 07:00)",
  };
  return presets[cron] ?? `Custom cron: \`${cron}\``;
}
