import { Hono } from "hono";
import type { Provider } from "./providers/types.js";
import { expandQuery } from "./search/query-expansion.js";
import { rerankResults } from "./search/rerank.js";
import type { SearchIndex } from "./search-index.js";

/**
 * Create search API routes for a project.
 *
 * Routes:
 *   GET /search?q=...&limit=20  → { results: SearchResult[] }
 *   GET /backlinks?path=...     → { backlinks: BacklinkEntry[] }
 *   GET /recent?limit=20        → { pages: RecentEdit[] }
 */
export function createSearchApi(
  searchIndex: SearchIndex,
  opts?: { provider?: Provider | null },
): Hono {
  const api = new Hono();

  api.get("/search", async (c) => {
    const query = c.req.query("q") ?? "";
    const limit = Number(c.req.query("limit") ?? "20");
    const expand = c.req.query("expand") !== "false";

    if (!query.trim()) {
      return c.json({ results: [] });
    }

    try {
      // Stage 1: direct FTS5 search.
      let results = searchIndex.search(query, limit);

      // Stage 2: optional query expansion (LLM keyword rewrite).
      const provider = opts?.provider ?? null;
      if (expand && provider?.supportsTools) {
        const expanded = await expandQuery(query, searchIndex, provider, null);
        if (!expanded.skipped && expanded.lexRewrite) {
          const rewritten = searchIndex.search(expanded.lexRewrite, limit);
          // RRF merge: interleave original + rewritten, dedup by path.
          const seen = new Set(results.map((r) => r.path));
          for (const r of rewritten) {
            if (!seen.has(r.path)) {
              results.push(r);
              seen.add(r.path);
            }
          }
        }
      }

      // Stage 3: optional LLM re-ranking.
      if (provider?.supportsTools && results.length > 3) {
        results = await rerankResults(query, results, provider, null);
      }

      return c.json({ results: results.slice(0, limit) });
    } catch {
      // FTS5 query syntax error — return empty rather than 500
      return c.json({ results: [] });
    }
  });

  api.get("/backlinks", (c) => {
    const path = c.req.query("path") ?? "";
    if (!path) {
      return c.json({ error: "path query parameter required" }, 400);
    }
    const backlinks = searchIndex.getBacklinks(path);
    return c.json({ backlinks });
  });

  api.get("/recent", (c) => {
    const limit = Number(c.req.query("limit") ?? "20");
    const pages = searchIndex.getRecentEdits(limit);
    return c.json({ pages });
  });

  return api;
}
