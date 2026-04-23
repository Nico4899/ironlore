import type { SearchIndex } from "../search-index.js";
import type { ToolCallContext, ToolImplementation } from "./types.js";

/**
 * kb.lint_orphans — enumerate markdown pages with zero inbound
 * wiki-links.
 *
 * Backs the orphan check in the Wiki Gardener's `lint.md` workflow
 * skill (see `.agents/.shared/skills/lint.md`). The tool is
 * read-only — the gardener pipes the result into its lint report
 * page rather than auto-fixing anything.
 *
 * `_maintenance/`, `getting-started/`, and `.agents/` are excluded
 * by default because they are self-documentation or agent-scoped and
 * not expected to have inbound wiki-links. Callers can override the
 * prefix list via `excludePrefixes` on the tool input.
 */
export function createKbLintOrphans(searchIndex: SearchIndex): ToolImplementation {
  return {
    definition: {
      name: "kb.lint_orphans",
      description:
        "Find markdown pages with zero inbound wiki-links — the orphan check used by the lint workflow skill. " +
        "Returns an array of { path, updatedAt } rows. Read-only. Call this before composing the 'Orphans' section of a lint report.",
      inputSchema: {
        type: "object",
        properties: {
          excludePrefixes: {
            type: "array",
            items: { type: "string" },
            description:
              "Path prefixes to skip. Defaults to ['_maintenance/', 'getting-started/', '.agents/']. Pass [] to include every page.",
          },
        },
      },
    },
    async execute(args: unknown, _ctx: ToolCallContext): Promise<string> {
      const input = (args as { excludePrefixes?: unknown }) ?? {};
      const excludePrefixes = Array.isArray(input.excludePrefixes)
        ? (input.excludePrefixes.filter((p): p is string => typeof p === "string") as string[])
        : undefined;

      const orphans = searchIndex.findOrphans(
        excludePrefixes !== undefined ? { excludePrefixes } : undefined,
      );
      if (orphans.length === 0) {
        return JSON.stringify({ count: 0, orphans: [] });
      }
      return JSON.stringify({ count: orphans.length, orphans });
    },
  };
}
