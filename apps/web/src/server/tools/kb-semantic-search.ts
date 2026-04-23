import { fetchForProject } from "../fetch-for-project.js";
import type { EmbeddingProvider } from "../providers/embedding-types.js";
import { ProviderRegistry } from "../providers/registry.js";
import type { SearchIndex } from "../search-index.js";
import type { ToolCallContext, ToolImplementation } from "./types.js";

/**
 * kb.semantic_search — Phase-11 hybrid retrieval.
 *
 * Available only when an embedding provider is configured (see
 * docs/04-ai-and-agents.md §Phase 11 additions). When the registry
 * can't resolve a provider, the tool isn't registered, so the agent
 * gracefully falls back to `kb.search` without knowing the difference.
 *
 * Pipeline per call:
 *   1. **BM25 prefilter** — chunk-level FTS5 against the query.
 *      Top ~50 distinct page paths become the vector-search candidate
 *      set, keeping cosine sweep size O(1) in vault growth.
 *   2. **Embed query** — one call to the provider (egress-aware).
 *      Failures fall back to BM25-only results rather than raising —
 *      a provider hiccup should not poison the agent's turn.
 *   3. **Vector search** — cosine against `chunk_vectors`, restricted
 *      to the prefilter's candidates.
 *   4. **RRF merge** — K=60, standard Reciprocal Rank Fusion over
 *      the BM25 and vector rank lists. Pages surfaced by both
 *      channels float to the top.
 *   5. **Hydrate** — enrich top results with title + snippet from the
 *      chunk FTS table so the agent's citation carries block-ID
 *      context (e.g. `[[path#blk_…]]`).
 *
 * Input: `{ query: string, limit?: number }`. Output matches
 * `kb.search` so a caller can treat the tools interchangeably.
 */

const RRF_K = 60;
const BM25_PREFILTER_SIZE = 50;

interface SemanticSearchResult {
  path: string;
  title: string;
  snippet: string;
  blockIdStart: string | null;
  blockIdEnd: string | null;
}

export function createKbSemanticSearch(
  searchIndex: SearchIndex,
  embeddingProvider: EmbeddingProvider,
  projectId: string,
  projectDir: string,
): ToolImplementation {
  const fetchFn = (url: string | URL, init?: RequestInit) => fetchForProject(projectDir, url, init);
  const ctx = ProviderRegistry.buildContext(projectId, fetchFn);

  return {
    definition: {
      name: "kb.semantic_search",
      description:
        "Semantic search over the knowledge base using hybrid retrieval (BM25 prefilter + cosine similarity over chunk embeddings). " +
        "Use this when the user's question is about concepts or meaning — wording differences matter less than semantic overlap. " +
        "Returns pages ranked by fused BM25 + vector score, each with a chunk-level snippet and block-ID citation.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language query" },
          limit: {
            type: "number",
            description: "Max results (default 10).",
          },
        },
        required: ["query"],
      },
    },

    async execute(args: unknown, _toolCtx: ToolCallContext): Promise<string> {
      const { query, limit = 10 } = args as { query: string; limit?: number };
      if (!query?.trim()) return JSON.stringify({ results: [] });

      const bm25Ranks = searchIndex.bm25PrefilterPaths(query, BM25_PREFILTER_SIZE);
      if (bm25Ranks.size === 0) return JSON.stringify({ results: [] });
      const candidates = [...bm25Ranks.keys()];

      // Embed the query. A provider failure must not poison the agent's
      // turn — fall back to BM25-ranked prefilter results. The caller's
      // system prompt says "use kb.search for keyword lookups" so
      // degraded results are still useful.
      let queryEmbedding: number[] | null = null;
      try {
        const embedded = await embeddingProvider.embed([query], ctx);
        queryEmbedding = embedded[0] ?? null;
      } catch (err) {
        console.warn(
          `[kb.semantic_search] embed failed, falling back to BM25-only: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      const vectorRanks = queryEmbedding
        ? searchIndex.vectorSearch(queryEmbedding, candidates, limit * 3)
        : [];

      // RRF merge: each ranking contributes 1/(K + rank + 1). Paths in
      // both lists aggregate naturally.
      const fused = new Map<string, number>();
      for (const [path, rank] of bm25Ranks) {
        fused.set(path, (fused.get(path) ?? 0) + 1 / (RRF_K + rank + 1));
      }
      vectorRanks.forEach((hit, i) => {
        fused.set(hit.path, (fused.get(hit.path) ?? 0) + 1 / (RRF_K + i + 1));
      });

      const ordered = [...fused.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([path]) => path);

      if (ordered.length === 0) return JSON.stringify({ results: [] });

      const results = hydrate(searchIndex, ordered, vectorRanks);
      return JSON.stringify({ results });
    },
  };
}

/**
 * Turn a list of ranked paths into user-facing rows. Prefers the
 * chunk-level snippet from the vector hit (when present) since those
 * carry block-ID citations; falls back to the best BM25 chunk match
 * on that path for paths that only surfaced via the prefilter.
 */
function hydrate(
  searchIndex: SearchIndex,
  paths: string[],
  vectorRanks: ReturnType<SearchIndex["vectorSearch"]>,
): SemanticSearchResult[] {
  const vectorByPath = new Map<string, (typeof vectorRanks)[number]>();
  for (const hit of vectorRanks) {
    if (!vectorByPath.has(hit.path)) vectorByPath.set(hit.path, hit);
  }

  const titleByPath = searchIndex.getPageTitles(paths);
  const out: SemanticSearchResult[] = [];
  for (const path of paths) {
    const vec = vectorByPath.get(path);
    const chunkRef = vec
      ? { chunkIdx: vec.chunkIdx, blockIdStart: vec.blockIdStart, blockIdEnd: vec.blockIdEnd }
      : searchIndex.getBestChunk(path);
    const snippet = chunkRef ? searchIndex.getChunkText(path, chunkRef.chunkIdx) : "";
    out.push({
      path,
      title: titleByPath.get(path) ?? path,
      snippet: truncate(snippet, 240),
      blockIdStart: chunkRef?.blockIdStart ?? null,
      blockIdEnd: chunkRef?.blockIdEnd ?? null,
    });
  }
  return out;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}
