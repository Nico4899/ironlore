import type { EmbeddingProvider, EmbeddingProviderId } from "./embedding-types.js";
import { OpenAIEmbeddingProvider } from "./openai-embedding.js";

/**
 * Embedding-provider registry — sibling to `ProviderRegistry` for
 * chat. Opt-in: when no embedding provider is registered, every
 * `kb.semantic_search` / hybrid-retrieval call degrades to BM25-only
 * (see docs/04-ai-and-agents.md §Graceful degradation).
 *
 * The registry is deliberately simple: one provider at a time, named
 * by `EmbeddingProviderId`. Cross-provider fallback doesn't make
 * sense for embeddings — a vault embedded with OpenAI's 1536-dim
 * space can't be queried with Ollama's 768-dim `nomic-embed-text`
 * without re-embedding everything, so picking the "first available"
 * would silently corrupt results.
 */
export class EmbeddingProviderRegistry {
  private providers = new Map<EmbeddingProviderId, EmbeddingProvider>();

  /** Register a named provider. Idempotent: re-registering overwrites. */
  register(provider: EmbeddingProvider): void {
    this.providers.set(provider.name, provider);
  }

  /**
   * Look up a provider by name. Callers typically prefer `resolve()`
   * which honors the project's configured preference.
   */
  get(name: EmbeddingProviderId): EmbeddingProvider | undefined {
    return this.providers.get(name);
  }

  list(): EmbeddingProviderId[] {
    return [...this.providers.keys()];
  }

  hasAny(): boolean {
    return this.providers.size > 0;
  }

  /**
   * Resolve the embedding provider for a caller. Returns null when
   * none is registered so the caller can gracefully skip the vector
   * path rather than throw — this is the crux of the opt-in contract.
   *
   * Like the chat registry, a `preferredName` lets the caller pin a
   * choice (e.g. from persona frontmatter or project config); absent
   * that, the first registered provider wins.
   */
  resolve(preferredName?: EmbeddingProviderId): EmbeddingProvider | null {
    if (preferredName) {
      const preferred = this.providers.get(preferredName);
      if (preferred) return preferred;
    }
    const first = this.providers.values().next();
    return first.done ? null : first.value;
  }

  /**
   * Register the OpenAI embedding provider from an API key. Mirrors
   * `ProviderRegistry.registerAnthropic` for discoverability.
   */
  registerOpenAI(opts: {
    apiKey: string;
    model?: string;
    dimensions?: number;
    baseUrl?: string;
  }): void {
    this.register(new OpenAIEmbeddingProvider(opts));
  }
}
