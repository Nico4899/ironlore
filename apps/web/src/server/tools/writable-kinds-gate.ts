import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_DIR } from "@ironlore/core";
import type { ToolCallContext } from "./types.js";

/**
 * `writable_kinds` runtime gate for kb.* mutation tools.
 *
 * Reads the calling persona's `writable_kinds` from
 * `data/.agents/<slug>/persona.md` and throws when the target page's
 * `kind` isn't permitted. The check closes the gap docstring'd in
 * `kb.replace_block`: "The agent's `writable_kinds` permit mutation
 * (403 if denied)."
 *
 * Permissive defaults — the gate never throws when:
 *   - the persona file is missing (e.g. test fixtures, agents with no
 *     persona on disk yet),
 *   - the persona has no `writable_kinds` field (legacy / not yet
 *     scoped — preserved for backward compatibility),
 *   - the page's `kind` is null (un-classified pages are treated as
 *     `page` for the purposes of the check).
 *
 * The gate is read every call rather than cached: persona files are
 * tiny, the read is on the same disk as the markdown the tool is about
 * to mutate, and the user can edit a persona between tool calls.
 *
 * See docs/04-ai-and-agents.md §Default agents and
 * docs/06-implementation-roadmap.md §Phase 11 → security hardening.
 */
const ALL_KINDS = ["page", "source", "wiki"] as const;
type Kind = (typeof ALL_KINDS)[number];

export class WritableKindsViolation extends Error {
  readonly status = 403 as const;
  constructor(
    readonly agentSlug: string,
    readonly pageKind: Kind,
    readonly writableKinds: readonly Kind[],
  ) {
    super(
      `writable_kinds violation: agent '${agentSlug}' may not mutate kind:${pageKind} ` +
        `(scope allows: ${writableKinds.length === 0 ? "<none>" : writableKinds.join(", ")})`,
    );
    this.name = "WritableKindsViolation";
  }
}

/**
 * Throws `WritableKindsViolation` when the agent's persona doesn't
 * permit mutating a page of `pageKind`. Returns void on permit and on
 * the permissive cases above.
 */
export function assertWritableKind(ctx: ToolCallContext, pageKind: Kind | null): void {
  const writableKinds = readPersonaWritableKinds(ctx.dataRoot, ctx.agentSlug);
  if (writableKinds === null) return; // missing persona / no scope → permissive
  const effective: Kind = pageKind ?? "page";
  if (!writableKinds.includes(effective)) {
    throw new WritableKindsViolation(ctx.agentSlug, effective, writableKinds);
  }
}

/**
 * Two-regex frontmatter sweep — same fast path the executor and
 * heartbeat scheduler use. Returns:
 *   - `null` when the persona file is missing, or `writable_kinds` is
 *     absent / unparseable (caller treats as permissive).
 *   - the parsed `Kind[]` otherwise. Empty array is meaningful: the
 *     persona explicitly opts out of every mutation.
 */
function readPersonaWritableKinds(dataRoot: string, agentSlug: string): readonly Kind[] | null {
  if (!agentSlug) return null;
  const personaPath = join(dataRoot, AGENTS_DIR, agentSlug, "persona.md");
  if (!existsSync(personaPath)) return null;

  let raw: string;
  try {
    raw = readFileSync(personaPath, "utf-8");
  } catch {
    return null;
  }

  const fmMatch = /^---[^\n]*\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!fmMatch?.[1]) return null;
  const fm = fmMatch[1];

  // `writable_kinds` lives under `scope:` in the documented schema.
  // Accept both flow form (`writable_kinds: [page, wiki]`) and block
  // form (`writable_kinds:\n  - page\n  - wiki`) since the seeded
  // personas use both styles.
  const flow = /^\s*writable_kinds\s*:\s*\[([^\]]*)\]\s*$/m.exec(fm);
  if (flow?.[1] !== undefined) {
    return narrowKinds(
      flow[1]
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean),
    );
  }
  const block = /^\s*writable_kinds\s*:\s*\r?\n((?:[ \t]+-[^\n]*\r?\n?)+)/m.exec(fm);
  if (block?.[1]) {
    return narrowKinds(
      block[1]
        .split(/\r?\n/)
        .map((line) => /^\s*-\s*(.+?)\s*$/.exec(line)?.[1])
        .filter((s): s is string => Boolean(s))
        .map((s) => s.replace(/^["']|["']$/g, "")),
    );
  }
  return null;
}

function narrowKinds(values: string[]): readonly Kind[] {
  return values.filter((v): v is Kind => (ALL_KINDS as readonly string[]).includes(v));
}
