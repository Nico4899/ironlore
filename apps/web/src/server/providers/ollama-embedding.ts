import type { EmbeddingProvider } from "./embedding-types.js";
import type { ProjectContext } from "./types.js";

/**
 * Ollama embedding provider — the no-cloud path for hybrid retrieval.
 *
 * Defaults to `nomic-embed-text` (768 dims, 1.5 GB on disk) — the
 * smallest local model that holds up on retrieval benchmarks. The
 * user runs Ollama locally; we route every request through the
 * project's egress-aware fetch so non-loopback Ollama deployments
 * still respect `project.yaml`'s allowlist.
 *
 * Ollama's `/api/embed` endpoint accepts an array of inputs and
 * returns `{ embeddings: number[][] }` — one row per input, in
 * order. No batching workaround needed (older Ollama exposed
 * `/api/embeddings` for single-string requests; the array form is
 * the supported path on every recent build).
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = "ollama" as const;
  readonly dimensions: number;
  readonly model: string;

  private baseUrl: string;

  constructor(opts?: {
    /** Override the default `nomic-embed-text` model. */
    model?: string;
    /**
     * Override the default 768-dim output. `nomic-embed-text` ships
     * at 768 dims; `mxbai-embed-large` at 1024; `all-minilm` at 384.
     * Must match what lands in `chunk_vectors`. The index rejects
     * cross-dim queries the same way the OpenAI provider does.
     */
    dimensions?: number;
    /** Override the default `http://127.0.0.1:11434` base URL. */
    baseUrl?: string;
  }) {
    this.model = opts?.model ?? "nomic-embed-text";
    this.dimensions = opts?.dimensions ?? 768;
    this.baseUrl = opts?.baseUrl ?? "http://127.0.0.1:11434";
  }

  /**
   * Probe Ollama for an embedding-capable model. Returns the first
   * model name that matches a known embedding-model prefix, or
   * `null` if nothing matches. Used by `index.ts` to auto-register
   * the provider when the user has an embedding model installed.
   *
   * The probe runs against `/api/tags` rather than embedding a
   * canary string — keeps the auto-detect cheap and avoids
   * generating a 768-float vector just to ask "is Ollama up?".
   */
  static async detectEmbeddingModel(
    fetchFn: (url: string) => Promise<Response> = globalThis.fetch,
  ): Promise<string | null> {
    try {
      const res = await fetchFn("http://127.0.0.1:11434/api/tags");
      if (!res.ok) return null;
      const body = (await res.json()) as { models?: Array<{ name: string }> };
      const models = (body.models ?? []).map((m) => m.name);
      // Prefix-matched against the standard Ollama embedding model
      // family. The first hit wins — order biased toward retrieval
      // quality (nomic > mxbai > minilm).
      const candidates = ["nomic-embed-text", "mxbai-embed-large", "all-minilm"];
      for (const candidate of candidates) {
        const match = models.find((name) => name === candidate || name.startsWith(`${candidate}:`));
        if (match) return match;
      }
      return null;
    } catch {
      return null;
    }
  }

  async embed(texts: readonly string[], ctx: ProjectContext): Promise<number[][]> {
    if (texts.length === 0) return [];

    const url = `${this.baseUrl}/api/embed`;
    const res = await ctx.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama embeddings ${res.status}: ${body}`);
    }

    const json = (await res.json()) as { embeddings?: number[][] };
    const embeddings = json.embeddings;
    if (!Array.isArray(embeddings)) {
      throw new Error("Ollama embeddings response missing `embeddings` array");
    }
    if (embeddings.length !== texts.length) {
      throw new Error(
        `Ollama returned ${embeddings.length} embeddings for ${texts.length} inputs`,
      );
    }
    // Validate dimensionality on the first row — Ollama doesn't
    // accept a `dimensions` parameter, so the only way to catch a
    // model swap (e.g. user reinstalls `nomic-embed-text` as
    // `mxbai-embed-large`) is to compare against `this.dimensions`
    // and fail loudly. Silently accepting a mismatch would corrupt
    // `chunk_vectors`.
    const first = embeddings[0];
    if (Array.isArray(first) && first.length !== this.dimensions) {
      throw new Error(
        `Ollama '${this.model}' returned ${first.length}-dim vectors; provider configured for ${this.dimensions}`,
      );
    }
    return embeddings;
  }
}
