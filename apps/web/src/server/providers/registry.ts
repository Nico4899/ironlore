import type { Provider, ProjectContext } from "./types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OllamaProvider } from "./ollama.js";

export type { Provider, ProjectContext };

/**
 * Provider registry — resolves the right provider for a given
 * project + agent combination.
 *
 * Each project can configure multiple providers in `project.yaml`;
 * each agent persona may declare a preferred `provider` in its
 * frontmatter. The registry resolves: persona preference → project
 * default → first available → error.
 *
 * The registry is a lightweight lookup, not a singleton manager.
 * Providers are stateless (they don't hold connections); the only
 * state is the API key lookup from the per-project vault.
 */
export class ProviderRegistry {
  private providers = new Map<string, Provider>();
  private ollamaModels: string[] = [];

  /**
   * Register a named provider. Called at startup from config.
   */
  register(provider: Provider): void {
    this.providers.set(provider.name, provider);
  }

  /**
   * Get a provider by name. Returns undefined if not registered.
   */
  get(name: string): Provider | undefined {
    return this.providers.get(name);
  }

  /**
   * Get all registered provider names.
   */
  list(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Whether any provider is configured. Used by the AI panel to show
   * "connect a provider to enable" when no providers exist.
   */
  hasAny(): boolean {
    return this.providers.size > 0;
  }

  /**
   * Resolve a provider for an agent. Tries the agent's preferred
   * provider first, then falls back to the first registered one.
   */
  resolve(preferredName?: string): Provider | null {
    if (preferredName) {
      const preferred = this.providers.get(preferredName);
      if (preferred) return preferred;
    }
    // Fallback: first registered provider.
    const first = this.providers.values().next();
    return first.done ? null : first.value;
  }

  /**
   * Auto-detect Ollama and register it if running. Called at startup.
   */
  async autoDetectOllama(): Promise<boolean> {
    const result = await OllamaProvider.detect();
    if (!result) return false;
    this.ollamaModels = result.models;
    this.register(new OllamaProvider());
    return true;
  }

  /**
   * Get the list of auto-detected Ollama models.
   */
  getOllamaModels(): string[] {
    return this.ollamaModels;
  }

  /**
   * Register Anthropic from a project's API key configuration.
   */
  registerAnthropic(apiKey: string, baseUrl?: string): void {
    this.register(new AnthropicProvider({ apiKey, baseUrl }));
  }

  /**
   * Build a ProjectContext for a given project ID and its egress-aware
   * fetch function. Each provider call receives this context so HTTP
   * is routed through the per-project allowlist.
   */
  static buildContext(
    projectId: string,
    fetchFn: (url: string | URL, init?: RequestInit) => Promise<Response>,
  ): ProjectContext {
    return { projectId, fetch: fetchFn };
  }
}
