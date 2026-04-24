import { Hono } from "hono";
import { fetchForProject } from "./fetch-for-project.js";
import type { EmbeddingProvider } from "./providers/embedding-types.js";
import { ProviderRegistry } from "./providers/registry.js";
import type { ProjectContext, Provider } from "./providers/types.js";
import { expandQuery, searchWithExpansion } from "./search/query-expansion.js";
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
  /**
   * When configured, enables the Phase-11 hybrid-retrieval path:
   * `vec` + `hyde` query rewrites are embedded and fused into the
   * BM25 ranking via RRF. Absent → two-channel (original + lex) merge.
   */
  embeddingProvider?: EmbeddingProvider | null;
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
      // Stage 1: direct FTS5 search as the no-LLM baseline.
      let results = searchIndex.search(query, limit);

      // Stage 2: query expansion + multi-channel fusion. Runs when an
      // LLM provider is available; the hybrid vec/hyde path layers on
      // when an embedding provider is also configured. Degrades to
      // the original BM25 results if anything upstream fails.
      if (expand && canCallLlm && provider && projectContext && opts?.defaultModel) {
        const embeddingProvider = opts?.embeddingProvider ?? null;
        const expanded = await expandQuery(
          query,
          searchIndex,
          provider,
          projectContext,
          opts.defaultModel,
          embeddingProvider,
        );
        if (!expanded.skipped) {
          results = await searchWithExpansion(expanded, searchIndex, {
            limit,
            embeddingProvider,
            ctx: projectContext,
          });
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
    // Optional ?rel=... filter for typed-relation backlinks
    // (e.g. `kb.backlinks(pageId, "contradicts")` → only returns
    // blocks that explicitly claim to contradict this page).
    const rel = c.req.query("rel");
    const backlinks = rel ? searchIndex.getBacklinks(path, rel) : searchIndex.getBacklinks(path);
    return c.json({ backlinks });
  });

  api.get("/recent", (c) => {
    const limit = Number(c.req.query("limit") ?? "20");
    const pages = searchIndex.getRecentEdits(limit);
    return c.json({ pages });
  });

  return api;
}
