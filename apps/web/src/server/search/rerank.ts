import type { Provider, ProjectContext } from "../providers/types.js";
import type { SearchResult } from "../search-index.js";

/**
 * LLM re-ranking with position-aware blending.
 *
 * Top-15 candidates scored in a single batched LLM call. Each
 * candidate truncated to 400 tokens; total budget ≤ 8 KB.
 * Blend weights are configurable (default 75/25 → 60/40 → 40/60).
 * Feature-flagged off for local / Ollama providers.
 *
 * See docs/04-ai-and-agents.md §Retrieval pipeline.
 */

const MAX_CANDIDATES = 15;
const MAX_SNIPPET_CHARS = 1600; // ~400 tokens
const MAX_PROMPT_CHARS = 32_000; // ~8k tokens

interface BlendWeights {
  tier1: { retrieval: number; rerank: number }; // ranks 1-3
  tier2: { retrieval: number; rerank: number }; // ranks 4-10
  tier3: { retrieval: number; rerank: number }; // ranks 11+
}

const DEFAULT_WEIGHTS: BlendWeights = {
  tier1: { retrieval: 0.75, rerank: 0.25 },
  tier2: { retrieval: 0.6, rerank: 0.4 },
  tier3: { retrieval: 0.4, rerank: 0.6 },
};

/**
 * Re-rank search results using the LLM. Returns the results in
 * blended order.
 *
 * If the provider is null or doesn't support tools (local/Ollama),
 * returns the input unchanged — re-ranking degrades gracefully.
 */
export async function rerankResults(
  query: string,
  results: SearchResult[],
  provider: Provider | null,
  ctx: ProjectContext | null,
  model?: string,
  weights: BlendWeights = DEFAULT_WEIGHTS,
): Promise<SearchResult[]> {
  if (!provider || !ctx || !model) return results;
  if (results.length <= 1) return results;

  const candidates = results.slice(0, MAX_CANDIDATES);

  // Build the scoring prompt.
  let totalChars = 0;
  const snippets: string[] = [];
  for (const r of candidates) {
    const snippet = r.snippet.slice(0, MAX_SNIPPET_CHARS);
    totalChars += snippet.length;
    if (totalChars > MAX_PROMPT_CHARS) break;
    snippets.push(snippet);
  }

  const candidateBlock = snippets
    .map((s, i) => `[${i + 1}] ${candidates[i]?.title ?? ""}\n${s}`)
    .join("\n\n---\n\n");

  const prompt = `Rate each candidate's relevance to the query on a scale of 0-10. Return ONLY a JSON array of numbers, one per candidate, in order. No explanation.\n\nQuery: "${query}"\n\nCandidates:\n${candidateBlock}`;

  try {
    let response = "";
    for await (const event of provider.chat(
      {
        model,
        systemPrompt: "You are a search result re-ranker. Output only a JSON array of relevance scores.",
        messages: [{ role: "user", content: prompt }],
        maxTokens: 128,
        temperature: 0,
      },
      ctx,
    )) {
      if (event.type === "text") response += event.text;
      if (event.type === "error") return results; // Degrade gracefully.
    }

    // Parse the scores.
    const match = /\[[\d\s,.-]+\]/.exec(response);
    if (!match) return results;

    const scores: number[] = JSON.parse(match[0]) as number[];
    if (!Array.isArray(scores) || scores.length === 0) return results;

    // Position-aware blending.
    const blended = candidates.map((r, i) => {
      const retrievalRank = i + 1;
      const rerankScore = (scores[i] ?? 0) / 10; // Normalize to 0-1.
      const retrievalScore = 1 - i / candidates.length; // Linear decay.

      const w =
        retrievalRank <= 3
          ? weights.tier1
          : retrievalRank <= 10
            ? weights.tier2
            : weights.tier3;

      const blendedScore =
        w.retrieval * retrievalScore + w.rerank * rerankScore;

      return { result: r, score: blendedScore };
    });

    blended.sort((a, b) => b.score - a.score);
    return blended.map((b) => b.result);
  } catch {
    return results; // Degrade gracefully.
  }
}
