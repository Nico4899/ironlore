import type { EmbeddingProvider } from "../providers/embedding-types.js";
import type { ProjectContext, Provider } from "../providers/types.js";
import type { SearchIndex, SearchResult } from "../search-index.js";

/**
 * Query expansion with strong-signal skip.
 *
 * Before calling the LLM for expansion, run a fast BM25 probe. If the
 * top-1 result scores ≥ 0.4 (normalized) with a 2× gap over top-2,
 * skip the LLM call entirely — the query was already confident.
 *
 * When expansion runs, up to two LLM calls fire:
 *   - **lex**: a keyword-rich rewrite for BM25 (Phase 4 baseline).
 *   - **vec + hyde**: a paraphrased query (`vec`) and a hypothetical
 *     one-sentence answer (`hyde`), both intended to be embedded and
 *     used as vector probes. Only requested when an embedding provider
 *     is configured — otherwise the rewrites would go unused.
 *
 * See docs/04-ai-and-agents.md §Retrieval pipeline and §Phase 11
 * additions (gated on kb.semantic_search).
 */

const STRONG_SIGNAL_THRESHOLD = 0.4;
const STRONG_SIGNAL_GAP = 2.0;

export interface ExpandedQuery {
  original: string;
  lexRewrite: string | null;
  /**
   * Semantic paraphrase of the query — same meaning, different
   * wording. Embedded and used as a vector probe. Null when the
   * embedding provider is absent or the expansion LLM call failed.
   */
  vecRewrite: string | null;
  /**
   * HyDE-style (Hypothetical Document Embeddings) one-sentence
   * answer. Captures what a correct response *would look like* so
   * its embedding lands near real answer chunks in the store.
   */
  hydeAnswer: string | null;
  skipped: boolean;
}

/**
 * Expand a search query. Returns the original + optional rewrites.
 * If the strong-signal check passes, `skipped: true` and no LLM
 * call was made.
 *
 * When `embeddingProvider` is supplied alongside the chat provider,
 * a second LLM call requests the `vec` and `hyde` rewrites as JSON.
 * The embedding step itself happens later in `searchWithExpansion` —
 * this function just secures the text for downstream vector probes.
 */
export async function expandQuery(
  query: string,
  searchIndex: SearchIndex,
  provider: Provider | null,
  ctx: ProjectContext | null,
  model?: string,
  embeddingProvider?: EmbeddingProvider | null,
): Promise<ExpandedQuery> {
  // Stage 1: strong-signal probe.
  const probeResults = searchIndex.search(query, 3);

  if (probeResults.length >= 2) {
    // FTS5 rank is negative (lower = better). Convert to magnitude so
    // higher = better for the comparison below.
    const top1Magnitude = Math.abs(probeResults[0]?.rank ?? 0);
    const top2Magnitude = Math.abs(probeResults[1]?.rank ?? 0);

    // Strong signal: top-1 magnitude clears the threshold AND dominates
    // top-2 by the configured ratio. Both conditions guard against
    // "ambiguous but loud" queries where a long body contains many
    // keyword variants.
    if (
      top1Magnitude >= STRONG_SIGNAL_THRESHOLD &&
      top2Magnitude > 0 &&
      top1Magnitude / top2Magnitude >= STRONG_SIGNAL_GAP
    ) {
      return emptyExpansion(query, true);
    }
  }

  // Stage 2: LLM keyword rewrite (Phase 4 — lex only).
  if (!provider || !ctx || !model) {
    return emptyExpansion(query, false);
  }

  const lexRewrite = await requestLexRewrite(query, provider, ctx, model);

  // Stage 3 (Phase 11): vec + hyde rewrites. Only requested when an
  // embedding provider is configured — otherwise the text would go
  // unused and the LLM call would be pure waste. A JSON-parse or
  // transport failure silently yields null fields so lex + original
  // BM25 still works.
  const hybrid = embeddingProvider
    ? await requestHybridRewrites(query, provider, ctx, model)
    : { vec: null, hyde: null };

  return {
    original: query,
    lexRewrite,
    vecRewrite: hybrid.vec,
    hydeAnswer: hybrid.hyde,
    skipped: false,
  };
}

function emptyExpansion(query: string, skipped: boolean): ExpandedQuery {
  return {
    original: query,
    lexRewrite: null,
    vecRewrite: null,
    hydeAnswer: null,
    skipped,
  };
}

/**
 * Single-turn keyword rewrite for BM25. Kept as a standalone call
 * so a JSON-parse failure in the hybrid-rewrite stage can't poison
 * the lex path — lex has been load-bearing since Phase 4.
 */
async function requestLexRewrite(
  query: string,
  provider: Provider,
  ctx: ProjectContext,
  model: string,
): Promise<string | null> {
  try {
    const prompt = `Rewrite this search query as a keyword-rich BM25 search string. Return ONLY the rewritten query, nothing else. Keep it under 30 words.\n\nQuery: "${query}"`;
    let out = "";
    for await (const event of provider.chat(
      {
        model,
        systemPrompt: "You are a search query optimizer. Output only the rewritten query.",
        messages: [{ role: "user", content: prompt }],
        maxTokens: 64,
        temperature: 0.3,
      },
      ctx,
    )) {
      if (event.type === "text") out += event.text;
      if (event.type === "error") break;
    }
    const trimmed = out.trim().replace(/^["']|["']$/g, "");
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * JSON-returning call for vec + hyde in one round-trip. Cost: one
 * LLM call, ~100 output tokens. Produces two short texts the caller
 * embeds and probes against the vector store.
 *
 * The prompt pins a strict JSON schema; on parse failure every field
 * returns null and the caller falls back to lex + BM25 only.
 */
async function requestHybridRewrites(
  query: string,
  provider: Provider,
  ctx: ProjectContext,
  model: string,
): Promise<{ vec: string | null; hyde: string | null }> {
  try {
    const prompt =
      `You rewrite search queries for a hybrid retrieval system. Given the user's query, emit a single JSON object with exactly these fields and no prose:\n` +
      `  "vec": a semantic paraphrase of the query — same intent, different wording. Keep under 20 words.\n` +
      `  "hyde": one or two sentences of a hypothetical answer to the query, as it would appear in an authoritative source. Plain prose, no hedging.\n\n` +
      `Query: "${query}"\n\nRespond with ONLY the JSON object.`;

    let raw = "";
    for await (const event of provider.chat(
      {
        model,
        systemPrompt:
          "You emit JSON objects matching the caller's schema. No markdown, no code fences, no commentary.",
        messages: [{ role: "user", content: prompt }],
        maxTokens: 256,
        temperature: 0.3,
      },
      ctx,
    )) {
      if (event.type === "text") raw += event.text;
      if (event.type === "error") break;
    }

    // Tolerate the occasional ```json fence even though we ask for plain JSON.
    const stripped = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```$/, "")
      .trim();
    if (!stripped.startsWith("{")) return { vec: null, hyde: null };

    const parsed = JSON.parse(stripped) as { vec?: unknown; hyde?: unknown };
    return {
      vec: typeof parsed.vec === "string" && parsed.vec.trim() ? parsed.vec.trim() : null,
      hyde: typeof parsed.hyde === "string" && parsed.hyde.trim() ? parsed.hyde.trim() : null,
    };
  } catch {
    return { vec: null, hyde: null };
  }
}

/**
 * Search with expansion: run BM25 on the original + lex rewrite,
 * optionally run vector search on the embedded `vec`/`hyde` rewrites,
 * merge all four rankings via RRF (Reciprocal Rank Fusion).
 *
 * The vector path only engages when `opts.embeddingProvider` +
 * `opts.ctx` are supplied AND the expanded query carries a `vec` or
 * `hyde` rewrite. Otherwise the result is identical to the Phase-4
 * two-channel merge (original + lex), preserving backward behavior.
 *
 * Candidate set for the vector probe is the union of paths surfaced
 * by the BM25 channels — the same O(1)-in-vault-growth prefilter
 * `kb.semantic_search` uses. Keeps cosine sweeps bounded even when
 * the vault grows.
 */
export async function searchWithExpansion(
  expanded: ExpandedQuery,
  searchIndex: SearchIndex,
  opts?: {
    limit?: number;
    embeddingProvider?: EmbeddingProvider | null;
    ctx?: ProjectContext | null;
  },
): Promise<SearchResult[]> {
  const limit = opts?.limit ?? 10;
  const originalResults = searchIndex.search(expanded.original, limit * 2);
  const lexResults = expanded.lexRewrite ? searchIndex.search(expanded.lexRewrite, limit * 2) : [];

  // Vector channels piggy-back on the BM25 candidate set so we don't
  // scan the entire vault's embeddings on every query.
  const candidatePaths = new Set<string>();
  for (const r of originalResults) candidatePaths.add(r.path);
  for (const r of lexResults) candidatePaths.add(r.path);

  const { vecRanks, hydeRanks } = await runVectorProbes(
    expanded,
    searchIndex,
    [...candidatePaths],
    limit,
    opts?.embeddingProvider ?? null,
    opts?.ctx ?? null,
  );

  // RRF merge across every non-empty ranked list. Each channel
  // contributes 1/(K + rank + 1) per path; paths surfaced by
  // multiple channels naturally float to the top.
  const K = 60;
  const scores = new Map<string, { score: number; result: SearchResult }>();

  const accumulate = (results: SearchResult[]) => {
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r) continue;
      const existing = scores.get(r.path);
      const rrf = 1 / (K + i + 1);
      if (existing) existing.score += rrf;
      else scores.set(r.path, { score: rrf, result: r });
    }
  };

  accumulate(originalResults);
  accumulate(lexResults);
  accumulate(vecRanks);
  accumulate(hydeRanks);

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.result);
}

/**
 * Batch-embed the `vec` + `hyde` rewrites in one provider call (OpenAI
 * and most peers accept arrays), then fan out into separate vector
 * searches. Missing rewrites are skipped; an embed failure degrades
 * the whole vector path to empty — callers still get the BM25
 * channels.
 */
async function runVectorProbes(
  expanded: ExpandedQuery,
  searchIndex: SearchIndex,
  candidatePaths: string[],
  limit: number,
  embeddingProvider: EmbeddingProvider | null,
  ctx: ProjectContext | null,
): Promise<{ vecRanks: SearchResult[]; hydeRanks: SearchResult[] }> {
  if (!embeddingProvider || !ctx || candidatePaths.length === 0) {
    return { vecRanks: [], hydeRanks: [] };
  }
  const texts: string[] = [];
  const slots: Array<"vec" | "hyde"> = [];
  if (expanded.vecRewrite) {
    texts.push(expanded.vecRewrite);
    slots.push("vec");
  }
  if (expanded.hydeAnswer) {
    texts.push(expanded.hydeAnswer);
    slots.push("hyde");
  }
  if (texts.length === 0) return { vecRanks: [], hydeRanks: [] };

  let embeddings: number[][];
  try {
    embeddings = await embeddingProvider.embed(texts, ctx);
  } catch (err) {
    console.warn(
      `[query-expansion] vec/hyde embed failed, BM25-only: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { vecRanks: [], hydeRanks: [] };
  }

  const vecRanks: SearchResult[] = [];
  const hydeRanks: SearchResult[] = [];
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const embedding = embeddings[i];
    if (!slot || !embedding) continue;
    const hits = searchIndex.vectorSearch(embedding, candidatePaths, limit * 2);
    // Map vectorSearch rows into SearchResult shape so the RRF merge
    // stays homogeneous. rank is synthesized — FTS5 rank semantics
    // don't apply, so we leave it zero.
    const asResults: SearchResult[] = hits.map((h) => ({
      path: h.path,
      title: h.path,
      snippet: "",
      rank: 0,
    }));
    if (slot === "vec") vecRanks.push(...asResults);
    else hydeRanks.push(...asResults);
  }
  return { vecRanks, hydeRanks };
}
