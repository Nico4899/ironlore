import type { SearchIndex } from "../search-index.js";
import type { ToolCallContext, ToolImplementation } from "./types.js";

/**
 * kb.lint_stale_sources — wiki pages whose cited sources have been
 * modified more recently than the wiki itself.
 *
 * Backs the stale-source check in the Wiki Gardener's `lint.md`
 * workflow skill. A wiki synthesizing from source pages goes stale
 * the moment a source it cites gets updated and the synthesis hasn't
 * been refreshed. This tool surfaces those pairs so the gardener
 * reports them for human review — read-only, never auto-fixes.
 *
 * One row per (wiki, source) pair. Shape matches what the lint
 * report's `Stale sources` table expects: source path, wiki path,
 * and both ISO timestamps so the model can phrase the delta
 * ("source updated 2 days after wiki").
 */
export function createKbLintStaleSources(searchIndex: SearchIndex): ToolImplementation {
  return {
    definition: {
      name: "kb.lint_stale_sources",
      description:
        "Find wiki pages whose cited sources have been modified more recently. Returns an array of { wikiPath, sourcePath, wikiUpdatedAt, sourceUpdatedAt } rows. Read-only. Call before composing the 'Stale sources' section of a lint report.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    async execute(_args: unknown, _ctx: ToolCallContext): Promise<string> {
      const stale = searchIndex.findStaleSources();
      return JSON.stringify({ count: stale.length, stale });
    },
  };
}
