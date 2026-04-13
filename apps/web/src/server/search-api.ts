import { Hono } from "hono";
import type { SearchIndex } from "./search-index.js";

/**
 * Create search API routes for a project.
 *
 * Routes:
 *   GET /search?q=...&limit=20  → { results: SearchResult[] }
 *   GET /backlinks?path=...     → { backlinks: BacklinkEntry[] }
 *   GET /recent?limit=20        → { pages: RecentEdit[] }
 */
export function createSearchApi(searchIndex: SearchIndex): Hono {
  const api = new Hono();

  api.get("/search", (c) => {
    const query = c.req.query("q") ?? "";
    const limit = Number(c.req.query("limit") ?? "20");

    if (!query.trim()) {
      return c.json({ results: [] });
    }

    try {
      const results = searchIndex.search(query, limit);
      return c.json({ results });
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
