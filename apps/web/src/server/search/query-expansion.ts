import type { ProjectContext, Provider } from "../providers/types.js";
import type { SearchIndex, SearchResult } from "../search-index.js";

/**
 * Query expansion with strong-signal skip.
 *
 * Before calling the LLM for expansion, run a fast BM25 probe. If the
 * top-1 result scores ≥ 0.4 (normalized) with a 2× gap over top-2,
 * skip the LLM call entirely — the query was already confident.
 *
 * When expansion runs, a single LLM call emits a keyword-rewrite
 * (`lex`) variant for BM25. `vec` and `hyde` variants are Phase 6
 * (gated on `kb.semantic_search`).
 *
 * See docs/04-ai-and-agents.md §Retrieval pipeline.
 */

const STRONG_SIGNAL_THRESHOLD = 0.4;
const STRONG_SIGNAL_GAP = 2.0;

export interface ExpandedQuery {
  original: string;
  lexRewrite: string | null;
  skipped: boolean;
}

/**
 * Expand a search query. Returns the original + optional keyword
 * rewrite. If the strong-signal check passes, `skipped: true` and
 * no LLM call was made.
 */
export async function expandQuery(
  query: string,
  searchIndex: SearchIndex,
  provider: Provider | null,
  ctx: ProjectContext | null,
  model?: string,
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
      return { original: query, lexRewrite: null, skipped: true };
    }
  }

  // Stage 2: LLM keyword rewrite (Phase 4 — lex only).
  if (!provider || !ctx || !model) {
    return { original: query, lexRewrite: null, skipped: false };
  }

  try {
    const expansionPrompt = `Rewrite this search query as a keyword-rich BM25 search string. Return ONLY the rewritten query, nothing else. Keep it under 30 words.\n\nQuery: "${query}"`;

    let rewrite = "";
    for await (const event of provider.chat(
      {
        model,
        systemPrompt: "You are a search query optimizer. Output only the rewritten query.",
        messages: [{ role: "user", content: expansionPrompt }],
        maxTokens: 64,
        temperature: 0.3,
      },
      ctx,
    )) {
      if (event.type === "text") rewrite += event.text;
      if (event.type === "error") break;
    }

    const trimmed = rewrite.trim().replace(/^["']|["']$/g, "");
    return {
      original: query,
      lexRewrite: trimmed.length > 0 ? trimmed : null,
      skipped: false,
    };
  } catch {
    return { original: query, lexRewrite: null, skipped: false };
  }
}

/**
 * Search with expansion: run BM25 on the original + the lex rewrite,
 * merge via simple RRF (reciprocal rank fusion).
 */
export function searchWithExpansion(
  expanded: ExpandedQuery,
  searchIndex: SearchIndex,
  limit = 10,
): SearchResult[] {
  const originalResults = searchIndex.search(expanded.original, limit * 2);

  if (!expanded.lexRewrite) {
    return originalResults.slice(0, limit);
  }

  const lexResults = searchIndex.search(expanded.lexRewrite, limit * 2);

  // RRF merge: score = sum of 1/(k + rank) across both result lists.
  const k = 60;
  const scores = new Map<string, { score: number; result: SearchResult }>();

  for (let i = 0; i < originalResults.length; i++) {
    const r = originalResults[i];
    if (!r) continue;
    const existing = scores.get(r.path);
    const rrf = 1 / (k + i + 1);
    if (existing) {
      existing.score += rrf;
    } else {
      scores.set(r.path, { score: rrf, result: r });
    }
  }

  for (let i = 0; i < lexResults.length; i++) {
    const r = lexResults[i];
    if (!r) continue;
    const existing = scores.get(r.path);
    const rrf = 1 / (k + i + 1);
    if (existing) {
      existing.score += rrf;
    } else {
      scores.set(r.path, { score: rrf, result: r });
    }
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.result);
}
