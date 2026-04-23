import type { EmbeddingProvider } from "./embedding-types.js";
import type { ProjectContext } from "./types.js";

/**
 * OpenAI embedding provider — `text-embedding-3-small` by default
 * (1536 dims, the cheapest OpenAI embedding model that still performs
 * well on retrieval benchmarks). Ships the hybrid-retrieval MVP of
 * Phase 11.
 *
 * Uses the project's egress-aware fetch — per-project allowlists
 * enforce that the user opted into reaching `api.openai.com`.
 *
 * Batches the OpenAI API supports arrays natively; callers are still
 * expected to chunk to a reasonable batch size (~100 inputs) to keep
 * request latency predictable and the batch below provider size caps.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai" as const;
  readonly dimensions: number;
  readonly model: string;

  private apiKey: string;
  private baseUrl: string;

  constructor(opts: {
    apiKey: string;
    /** Override the default `text-embedding-3-small` model. */
    model?: string;
    /**
     * Override the default 1536-dim output. When the caller picks
     * `text-embedding-3-large`, passing 3072 here matches the larger
     * model's native dimensionality. Must match what lands in
     * `chunk_vectors` — the index rejects cross-dim queries.
     */
    dimensions?: number;
    /** Override the default `https://api.openai.com` base URL. */
    baseUrl?: string;
  }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "text-embedding-3-small";
    this.dimensions = opts.dimensions ?? 1536;
    this.baseUrl = opts.baseUrl ?? "https://api.openai.com";
  }

  async embed(texts: readonly string[], ctx: ProjectContext): Promise<number[][]> {
    if (texts.length === 0) return [];

    const url = `${this.baseUrl}/v1/embeddings`;
    const res = await ctx.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        // `dimensions` is only accepted by text-embedding-3-* models.
        // Older ada-002 ignores it. Sending on every request is safe.
        dimensions: this.dimensions,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI embeddings ${res.status}: ${body}`);
    }

    const json = (await res.json()) as {
      data: Array<{ index: number; embedding: number[] }>;
    };

    // The API docs promise `data` is ordered by `index` matching
    // `input`, but sort defensively so a future change can't silently
    // misalign chunk_idx rows against their embeddings.
    const out = new Array<number[]>(texts.length);
    for (const row of json.data) {
      if (row.index < 0 || row.index >= texts.length) {
        throw new Error(`OpenAI returned out-of-range index ${row.index}`);
      }
      out[row.index] = row.embedding;
    }
    for (let i = 0; i < out.length; i++) {
      if (!out[i]) throw new Error(`OpenAI missing embedding at index ${i}`);
    }
    return out;
  }
}
