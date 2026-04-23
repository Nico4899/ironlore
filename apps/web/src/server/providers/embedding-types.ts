import type { ProjectContext } from "./types.js";

/**
 * Embedding provider abstraction — sibling to the chat `Provider`
 * interface. Exists so the Phase-11 hybrid-retrieval path can swap
 * OpenAI / Ollama / future local models without changing callers.
 *
 * Every provider receives a `ProjectContext` whose `fetch` routes
 * through the per-project egress middleware — same rule the chat
 * provider follows. No direct network access.
 *
 * See docs/04-ai-and-agents.md §Phase 11 additions (gated on
 * kb.semantic_search) and docs/06-implementation-roadmap.md
 * §Phase 11 → Hybrid retrieval.
 */
export interface EmbeddingProvider {
  /** Stable id used for key-store lookup and registry resolution. */
  readonly name: EmbeddingProviderId;
  /**
   * Fixed embedding dimensionality. `kb.semantic_search` rejects
   * queries when the configured provider's dims don't match the
   * stored chunk embeddings' dims — the user must rebuild the index
   * after swapping provider/model.
   */
  readonly dimensions: number;
  /**
   * Provider-specific model identifier (e.g. `text-embedding-3-small`).
   * Surfaced to the UI so the user can see which model a given
   * `chunk_vectors` row was produced under.
   */
  readonly model: string;

  /**
   * Embed a batch of strings. Returns vectors in the same order the
   * caller supplied them; throws on transport / auth / rate-limit
   * errors so callers can fall back to BM25-only retrieval rather
   * than silently degrading.
   *
   * Batching is an implementation detail — OpenAI's API accepts
   * arrays natively; Ollama's does not and the concrete provider
   * fans out. Callers should still chunk to a reasonable batch size
   * (~100) to keep latency predictable.
   */
  embed(texts: readonly string[], ctx: ProjectContext): Promise<number[][]>;
}

/**
 * Registered embedding-provider identifiers. Narrow union so the
 * registry + key-store round-trip through the same set as the chat
 * providers. `claude-cli` isn't listed — Anthropic's Claude family
 * doesn't ship an embedding endpoint.
 */
export type EmbeddingProviderId = "openai" | "ollama";
