import type { SearchIndex } from "../search-index.js";
import type { ToolCallContext, ToolImplementation } from "./types.js";

/**
 * kb.search — FTS5 search scoped to the current project.
 *
 * Returns page IDs + snippets. When chunk-level indexing is available
 * (Step 9), results include block-ID citations for paragraph-level
 * precision.
 */
export function createKbSearch(searchIndex: SearchIndex): ToolImplementation {
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
    async execute(args: unknown, _ctx: ToolCallContext): Promise<string> {
      const { query, limit } = args as { query: string; limit?: number };
      const results = searchIndex.search(query, limit ?? 10);
      if (results.length === 0) {
        return "No results found.";
      }
      return JSON.stringify(
        results.map((r) => ({ path: r.path, title: r.title, snippet: r.snippet })),
      );
    },
  };
}
