import { Hono } from "hono";
import { fetchForProject } from "./fetch-for-project.js";
import { ProviderRegistry } from "./providers/registry.js";
import type { ProjectContext, Provider } from "./providers/types.js";
import { expandQuery } from "./search/query-expansion.js";
import { rerankResults } from "./search/rerank.js";
import type { SearchIndex } from "./search-index.js";

export interface SearchApiOptions {
  provider?: Provider | null;
  /** Project ID used to build the egress-aware ProjectContext for LLM calls. */
  projectId?: string;
  /** Project directory used by `fetchForProject` for egress allowlist. */
  projectDir?: string;
  /** Default model for query expansion + rerank LLM calls. */
  defaultModel?: string;
}

/**
 * Create search API routes for a project.
 *
 * Routes:
 *   GET /search?q=...&limit=20  → { results: SearchResult[] }
 *   GET /backlinks?path=...     → { backlinks: BacklinkEntry[] }
 *   GET /recent?limit=20        → { pages: RecentEdit[] }
 *
 * LLM expansion + reranking are enabled only when `projectId`, `projectDir`,
 * `defaultModel`, and a tool-capable provider are all supplied. Without
 * them the route degrades to plain BM25 + strong-signal skip.
 */
export function createSearchApi(searchIndex: SearchIndex, opts?: SearchApiOptions): Hono {
  const api = new Hono();

  const provider = opts?.provider ?? null;
  const canCallLlm = Boolean(
    provider?.supportsTools && opts?.projectId && opts?.projectDir && opts?.defaultModel,
  );

  // Build the ProjectContext once — fetchForProject reads config eagerly,
  // but the wrapper closure stays cheap and can be reused across requests.
  const projectContext: ProjectContext | null =
    canCallLlm && opts?.projectId && opts?.projectDir
      ? ProviderRegistry.buildContext(opts.projectId, (url, init) =>
          fetchForProject(opts.projectDir as string, url, init),
        )
      : null;

  api.get("/search", async (c) => {
    const query = c.req.query("q") ?? "";
    const limit = Number(c.req.query("limit") ?? "20");
    const expand = c.req.query("expand") !== "false";
    const rerank = c.req.query("rerank") !== "false";

    if (!query.trim()) {
      return c.json({ results: [] });
    }

    try {
      // Stage 1: direct FTS5 search.
      let results = searchIndex.search(query, limit);

      // Stage 2: optional query expansion (LLM keyword rewrite).
      if (expand && canCallLlm && provider && projectContext && opts?.defaultModel) {
        const expanded = await expandQuery(
          query,
          searchIndex,
          provider,
          projectContext,
          opts.defaultModel,
        );
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
      if (
        rerank &&
        canCallLlm &&
        provider &&
        projectContext &&
        opts?.defaultModel &&
        results.length > 3
      ) {
        results = await rerankResults(query, results, provider, projectContext, opts.defaultModel);
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
