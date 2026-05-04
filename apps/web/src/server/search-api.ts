import { Hono } from "hono";
import { canAccess, isDefaultAcl, loadEffectiveAcl, parsePageAcl } from "./acl.js";
import { fetchForProject } from "./fetch-for-project.js";
import type { EmbeddingProvider } from "./providers/embedding-types.js";
import { ProviderRegistry } from "./providers/registry.js";
import type { ProjectContext, Provider } from "./providers/types.js";
import { expandQuery, searchWithExpansion } from "./search/query-expansion.js";
import { rerankResults } from "./search/rerank.js";
import type { SearchIndex, SearchResult } from "./search-index.js";
import type { StorageWriter } from "./storage-writer.js";

export interface SearchApiOptions {
  provider?: Provider | null;
  /** Project ID used to build the egress-aware ProjectContext for LLM calls. */
  projectId?: string;
  /** Project directory used by `fetchForProject` for egress allowlist. */
  projectDir?: string;
  /** Default model for query expansion + rerank LLM calls. */
  defaultModel?: string;
  /**
   * Per-project mode + writer for ACL filtering. In `multi-user`
   * projects the route filters every result list against the calling
   * user's ACL — pages they can't read don't appear in results, and
   * the visible count reflects the filtered total (per
   * docs/08-projects-and-isolation.md §Search scope: "results the
   * caller can't read don't appear, not even in counts"). The
   * `writer` is used to read each candidate page's frontmatter +
   * inherit ACL from ancestor `index.md`. Single-user mode skips the
   * filter entirely; the cost is zero.
   */
  mode?: "single-user" | "multi-user";
  writer?: StorageWriter;
  /**
   * When configured, enables the Phase-11 hybrid-retrieval path:
   * `vec` + `hyde` query rewrites are embedded and fused into the
   * BM25 ranking via RRF. Absent → two-channel (original + lex) merge.
   */
  embeddingProvider?: EmbeddingProvider | null;
  /**
   * Snapshot of every registered project's `SearchIndex`, keyed by
   * project ID. Used only by the `?scope=all` branch of `GET /search`
   * — single-project queries never touch this map. Returning a fresh
   * map per call lets the host pass a closure that reads its live
   * `servicesById` registry, so projects added at runtime become
   * searchable without restarting the route.
   *
   * The agent tool path (`kb.search`) intentionally never sees this:
   * cross-project blending happens only in the user's UI, never in a
   * tool that an agent could invoke. See docs/08 §What this does not
   * try to do.
   */
  getAllProjectIndexes?: () => Map<string, SearchIndex>;
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

  // Whether semantic search is reachable for this project — surfaced
  // on every response so the Cmd+K toggle can disable itself when no
  // provider is configured. Resolved once at factory time; the
  // embedding-registry lookup never changes per request.
  const semanticAvailable = Boolean(opts?.embeddingProvider);

  const aclMode = opts?.mode ?? "single-user";
  const aclWriter = opts?.writer ?? null;

  /**
   * Filter a result list against the calling user's ACL when this
   * project is in multi-user mode. No-op (returns input) in
   * single-user mode or when no writer is wired (e.g. early-boot
   * surface; the writer is always present on the per-project mount).
   *
   * Per docs/08-projects-and-isolation.md §Search scope, the count
   * the user sees must reflect the filtered total — so callers run
   * this BEFORE the final `.slice(0, limit)`, not after.
   */
  function aclFilter<T extends { path: string }>(
    c: { get: (key: string) => unknown },
    hits: readonly T[],
  ): T[] {
    if (aclMode === "single-user" || !aclWriter) return [...hits];
    const userId = (c.get("userId") as string | undefined) ?? "";
    const username = (c.get("username") as string | undefined) ?? "";
    if (!userId && !username) return [...hits];

    const reader = (path: string): string | null => {
      try {
        return aclWriter.read(path).content;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        return null;
      }
    };

    const out: T[] = [];
    for (const hit of hits) {
      const own = reader(hit.path);
      if (own === null) continue;
      const ownAcl = parsePageAcl(own);
      const acl = isDefaultAcl(ownAcl) ? loadEffectiveAcl(hit.path, reader) : ownAcl;
      if (canAccess(acl, userId, username, "read")) out.push(hit);
    }
    return out;
  }

  api.get("/search", async (c) => {
    const query = c.req.query("q") ?? "";
    const limit = Number(c.req.query("limit") ?? "20");
    const expand = c.req.query("expand") !== "false";
    const rerank = c.req.query("rerank") !== "false";
    const scope = c.req.query("scope") === "all" ? "all" : "current";
    // Phase-11 user-facing semantic toggle. When `true` AND an
    // embedding provider is registered, run the same hybrid pipeline
    // `kb.semantic_search` uses (BM25 prefilter → embed query →
    // cosine → RRF) and merge those page-level results into the
    // existing FTS5+expansion+rerank set via a final RRF pass.
    // Silently a no-op when the provider isn't configured — the
    // `semanticAvailable: false` field on the response tells the UI
    // to grey out the toggle.
    const semantic = c.req.query("semantic") === "true";

    if (!query.trim()) {
      return c.json({ results: [], semanticAvailable });
    }

    // ?scope=all — fan out across every registered project's
    // SearchIndex, tag each hit with `projectId`, and merge by
    // position-RRF (each project's i-th result contributes
    // 1/(K+i+1)). The LLM expansion + rerank pipeline stays off in
    // this branch: those stages are project-scoped (they use the
    // active project's provider keys + egress allowlist) and don't
    // generalise to a heterogeneous result set. Without
    // `getAllProjectIndexes` configured, scope=all degrades to
    // current-project results.
    if (scope === "all" && opts?.getAllProjectIndexes) {
      try {
        const all = opts.getAllProjectIndexes();
        const K = 60;
        const merged = new Map<
          string,
          { score: number; result: SearchResult & { projectId: string } }
        >();
        for (const [pid, idx] of all) {
          let projectResults: SearchResult[];
          try {
            projectResults = idx.search(query, limit * 2);
          } catch {
            // FTS5 syntax error in one project shouldn't poison the
            // whole fan-out — just skip that project.
            continue;
          }
          for (let i = 0; i < projectResults.length; i++) {
            const r = projectResults[i];
            if (!r) continue;
            const key = `${pid}:${r.path}`;
            const rrfScore = 1 / (K + i + 1);
            merged.set(key, { score: rrfScore, result: { ...r, projectId: pid } });
          }
        }
        // Caller-project ACL filter on the merged set. We can only
        //  filter the current-project hits (the writer + session map to
        //  this project); foreign-project hits are surfaced as-is — the
        //  user's identity doesn't span projects (per
        //  docs/08-projects-and-isolation.md §Multi-user mode).
        const callerHits = [...merged.values()]
          .filter((e) => e.result.projectId === opts.projectId)
          .map((e) => e.result);
        const foreignHits = [...merged.values()]
          .filter((e) => e.result.projectId !== opts.projectId)
          .map((e) => e.result);
        const filteredCaller = aclFilter(c, callerHits);
        const filteredKeys = new Set(filteredCaller.map((r) => `${r.projectId}:${r.path}`));
        const results = [...merged.values()]
          .filter(
            (e) =>
              e.result.projectId !== opts.projectId ||
              filteredKeys.has(`${e.result.projectId}:${e.result.path}`),
          )
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map((e) => e.result);
        void foreignHits; // documented above; kept for clarity
        // semanticAvailable surfaced even on scope=all so the Cmd+K
        // toggle stays consistent across modes; semantic + scope=all
        // is documented future work — current-project only for v1.
        return c.json({ results, semanticAvailable });
      } catch {
        return c.json({ results: [], semanticAvailable });
      }
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

      // Stage 2b: Phase-11 user-facing semantic toggle. Independent of
      // the LLM-expansion stage above — runs whenever the user opts in
      // (?semantic=true) AND an embedding provider is registered. The
      // existing Stage 2 only does embedding-aware vec/hyde rewrites
      // when a chat provider is *also* present; this branch covers
      // the user with Ollama embeddings auto-detected but no chat
      // provider configured (the "FTS5 blindness to semantics" gap).
      if (semantic && opts?.embeddingProvider) {
        results = await runSemanticPass(
          query,
          searchIndex,
          opts.embeddingProvider,
          opts.projectId ?? "",
          opts.projectDir ?? "",
          results,
          limit,
        );
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

      // Stage 4: ACL filter (multi-user mode). Runs BEFORE the final
      //  slice so the visible count matches the filtered total — per
      //  docs/08 §Search scope ("results the caller can't read don't
      //  appear, not even in counts"). No-op in single-user mode.
      const filtered = aclFilter(c, results);

      return c.json({ results: filtered.slice(0, limit), semanticAvailable });
    } catch {
      // FTS5 query syntax error — return empty rather than 500
      return c.json({ results: [], semanticAvailable });
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

/**
 * Run the user-facing semantic-search pass and merge its hits with
 * the existing FTS5+expansion `results` set via RRF. Mirrors the
 * pipeline `kb.semantic_search` already uses — BM25 prefilter →
 * embed query → cosine over `chunk_vectors` → RRF — but layers the
 * page-level result onto the user's existing search-API output
 * shape (`SearchResult[]`) instead of the agent-tool snippet format.
 *
 * The merge: take both result lists, run a final RRF over their
 * positions (K=60 — the same constant the chunk-level RRF inside
 * `kb.semantic_search` uses), keep top `limit`. Pages surfaced by
 * both channels float to the top; pages only one channel saw still
 * make the cut at lower priority.
 *
 * Failure modes: any exception (embedding-provider down, FTS5
 * syntax error in the prefilter) returns the unchanged FTS5
 * results — semantic is enrichment, not a substitute. The user
 * sees the keyword path's results either way.
 */
async function runSemanticPass(
  query: string,
  searchIndex: SearchIndex,
  embeddingProvider: EmbeddingProvider,
  projectId: string,
  projectDir: string,
  baseResults: SearchResult[],
  limit: number,
): Promise<SearchResult[]> {
  const RRF_K = 60;
  const BM25_PREFILTER_SIZE = 50;

  try {
    const bm25Ranks = searchIndex.bm25PrefilterPaths(query, BM25_PREFILTER_SIZE);
    if (bm25Ranks.size === 0) return baseResults;
    const candidates = [...bm25Ranks.keys()];

    // Build the embedding fetch via the project's egress allowlist
    // — the user's Cmd+K query goes through the same chokepoint as
    // every other project network call.
    const embedCtx = ProviderRegistry.buildContext(projectId, (url, init) =>
      fetchForProject(projectDir, url, init),
    );
    const embedded = await embeddingProvider.embed([query], embedCtx);
    const queryEmbedding = embedded[0];
    if (!queryEmbedding) return baseResults;

    const vectorRanks = searchIndex.vectorSearch(queryEmbedding, candidates, limit * 3);

    // Page-level RRF over the semantic side: each cited page once,
    // first occurrence wins for chunk position.
    const semanticPagesByRank = new Map<string, number>();
    vectorRanks.forEach((hit, i) => {
      if (!semanticPagesByRank.has(hit.path)) semanticPagesByRank.set(hit.path, i);
    });
    if (semanticPagesByRank.size === 0) return baseResults;

    // Final RRF over baseResults (from FTS5/expansion) + semantic
    // page list. We need to rebuild title/snippet for pages that
    // only the semantic channel surfaced; reuse `getPageTitles` +
    // `getBestChunk` + `getChunkText` for that.
    const fused = new Map<string, { score: number; result: SearchResult }>();
    baseResults.forEach((r, i) => {
      fused.set(r.path, { score: 1 / (RRF_K + i + 1), result: r });
    });

    const semanticOnly = [...semanticPagesByRank.entries()].filter(([path]) => !fused.has(path));
    let titleByPath: Map<string, string> = new Map();
    if (semanticOnly.length > 0) {
      titleByPath = searchIndex.getPageTitles(semanticOnly.map(([p]) => p));
    }

    for (const [path, rank] of semanticPagesByRank) {
      const score = 1 / (RRF_K + rank + 1);
      const existing = fused.get(path);
      if (existing) {
        existing.score += score;
        continue;
      }
      // Pages only the semantic channel found — synthesize a
      // SearchResult shape so the UI doesn't have to branch.
      const chunkRef = searchIndex.getBestChunk(path);
      const snippet = chunkRef ? searchIndex.getChunkText(path, chunkRef.chunkIdx) : "";
      fused.set(path, {
        score,
        result: {
          path,
          title: titleByPath.get(path) ?? path,
          snippet: snippet.length > 240 ? `${snippet.slice(0, 240).trimEnd()}…` : snippet,
          rank: rank,
        },
      });
    }

    return [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((e) => e.result);
  } catch {
    return baseResults;
  }
}
