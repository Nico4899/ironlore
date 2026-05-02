import type { SearchIndex } from "../search-index.js";
import type { StorageWriter } from "../storage-writer.js";
import { filterReadableForTool } from "./acl-gate.js";
import type { ToolCallContext, ToolImplementation } from "./types.js";

/**
 * kb.search — FTS5 search scoped to the current project.
 *
 * Returns page IDs + snippets. When chunk-level indexing is available
 * (Step 9), results include block-ID citations for paragraph-level
 * precision.
 *
 * Phase-9 multi-user: results are filtered by read-ACL through
 * `filterReadableForTool`. A page the calling user can't read drops
 * out of the result list silently — same semantics as the HTTP
 * `pages-api.ts` gate, just applied to the agent surface.
 * Single-user runs and runs without a user identity (heartbeats /
 * cron) skip the filter entirely.
 */
export function createKbSearch(
  searchIndex: SearchIndex,
  writer: StorageWriter,
): ToolImplementation {
  return {
    definition: {
      name: "kb.search",
      description:
        "Search the knowledge base. Returns pages ranked by relevance with snippets. " +
        "Use this to find existing content before creating new pages or answering questions.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "number", description: "Max results (default 10)" },
        },
        required: ["query"],
      },
    },
    async execute(args: unknown, ctx: ToolCallContext): Promise<string> {
      const { query, limit } = args as { query: string; limit?: number };
      const cap = limit ?? 10;
      // Pull a wider slice from FTS to absorb ACL-filtered drops, so
      //  the model still sees `cap` results when the vault has a few
      //  ACL-restricted pages near the top of the rank list. The
      //  multiplier matches the HTTP-side bm25Prefilter's behaviour
      //  (limit * 3 candidates → top `limit` after merge).
      const fanout = ctx.acl ? cap * 3 : cap;
      const results = searchIndex.search(query, fanout);
      const permitted = filterReadableForTool(ctx, writer, results).slice(0, cap);
      // Always return a JSON array — the empty case used to return
      // the prose string `"No results found."`, which forced
      // downstream consumers (the AI panel's result-count chip, the
      // model's own JSON-parse path) to handle two shapes for the
      // same logical answer. The empty array is unambiguous: zero
      // results, JSON-parseable, same code path either way.
      return JSON.stringify(
        permitted.map((r) => ({ path: r.path, title: r.title, snippet: r.snippet })),
      );
    },
  };
}
