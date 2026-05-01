/**
 * Render a `## Boundaries` section that mirrors the structural
 * gates the runtime already enforces.
 *
 * The section is the human-readable receipt of `scope.pages`,
 * `writable_kinds`, `review_mode`, and `heartbeat` — not enforcement
 * itself. Enforcement lives in code (`assertWritableKind` in
 * `apps/web/src/server/tools/writable-kinds-gate.ts`, the
 * `review_mode` branch in the commit worker, the heartbeat scheduler).
 * The text exists so a non-technical user can read the agent's
 * persona.md and understand what the agent is and isn't allowed to
 * do, without having to read YAML or trace runtime gates.
 *
 * Used by:
 *   - The Visual Agent Builder server-side compiler (`buildPersona`
 *     in apps/web/src/server/agents/build-persona.ts) — every custom
 *     agent gets the section appended to its body.
 *   - The seeded default agents (`seedAgentDir` in
 *     apps/web/src/server/agents/seed-agents.ts) — Librarian + Editor
 *     get the same shape.
 *   - The AgentBuilderDialog preview block (client) — calls this at
 *     render time so the user sees the exact text that will land on
 *     disk before clicking Create.
 *   - SettingsDialog → SecurityTab — re-renders the Boundaries
 *     paragraph from each agent's persona.md so the audit surface
 *     and the persona file stay coherent.
 *
 * Lives in `packages/core/` because it must be importable from both
 * server and client; the function is pure and has no Node-only
 * dependencies.
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
 * Map a cron expression back to a plain-English label that mirrors
 * the Visual Agent Builder's Schedule dropdown. Custom cron strings
 * that don't match a known preset render as `Custom cron: \`<expr>\``
 * so the receipt is still honest about scheduling. Keep this list in
 * sync with `AgentBuilderDialog.tsx`'s schedule `<option>` values.
 */
function humanizeHeartbeat(cron: string | undefined): string {
  if (!cron) return "Manual only — runs only when you invoke the agent";
  const presets: Record<string, string> = {
    "0 * * * *": "Every hour",
    "0 6 * * *": "Daily at 06:00",
    "0 9 * * *": "Daily at 09:00",
    "0 9 * * 1-5": "Weekdays at 09:00",
    "0 9 * * 1": "Weekly (Mon 09:00)",
    "0 8 * * 1": "Weekly (Mon 08:00)",
    "0 6 * * 0": "Weekly (Sun 06:00)",
    "0 7 * * 0": "Weekly (Sun 07:00)",
  };
  return presets[cron] ?? `Custom cron: \`${cron}\``;
}
