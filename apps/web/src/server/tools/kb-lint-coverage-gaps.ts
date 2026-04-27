import type { SearchIndex } from "../search-index.js";
import type { ToolCallContext, ToolImplementation } from "./types.js";

/**
 * kb.lint_coverage_gaps — find concept labels the vault keeps
 * citing through `[[wiki-links]]` that don't resolve to any
 * existing page. The fifth check in the Wiki Gardener's `lint.md`
 * workflow skill, alongside orphans / stale-sources / contradictions
 * / provenance-gaps.
 *
 * Threshold defaults to **3 distinct citing pages** — single stray
 * references are usually typos or one-off ideas, while three or
 * more citations across distinct pages reads as "this concept
 * deserves its own page." Callers can override.
 *
 * Read-only — the gardener composes the findings into the lint
 * report rather than auto-creating the missing pages (creating
 * concept stubs is the user's call, not the agent's).
 */
export function createKbLintCoverageGaps(searchIndex: SearchIndex): ToolImplementation {
  return {
    definition: {
      name: "kb.lint_coverage_gaps",
      description:
        "Find wiki-link target labels that ≥3 distinct pages cite but no page exists for. " +
        "Returns rows of { target, mentionedBy[], citationCount } sorted by citationCount desc. " +
        "Read-only. Call this before composing the 'Coverage gaps' section of a lint report.",
      inputSchema: {
        type: "object",
        properties: {
          minMentions: {
            type: "number",
            description:
              "Minimum number of distinct citing pages required to flag a target as a coverage gap. Default 3.",
          },
          excludePrefixes: {
            type: "array",
            items: { type: "string" },
            description:
              "Path prefixes to skip on the *citing* side so reports etc. don't push targets over the threshold. Defaults to ['_maintenance/', 'getting-started/', '.agents/']. Pass [] to include every page.",
          },
        },
      },
    },
    async execute(args: unknown, _ctx: ToolCallContext): Promise<string> {
      const input = (args as { minMentions?: unknown; excludePrefixes?: unknown }) ?? {};
      const minMentions =
        typeof input.minMentions === "number" && input.minMentions > 0 ? input.minMentions : 3;
      const excludePrefixes = Array.isArray(input.excludePrefixes)
        ? (input.excludePrefixes.filter((p): p is string => typeof p === "string") as string[])
        : undefined;

      const gaps = searchIndex.findCoverageGaps(
        minMentions,
        excludePrefixes !== undefined ? { excludePrefixes } : undefined,
      );
      return JSON.stringify({ count: gaps.length, gaps });
    },
  };
}
