import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Effort,
  type GlobalProviderDefaults,
  type ProviderId,
  type ProviderOverride,
  type ProviderResolution,
  resolveProvider,
} from "@ironlore/core";
import { load as loadYaml } from "js-yaml";
import type { ProviderRegistry } from "./registry.js";
import type { Provider } from "./types.js";

/**
 * Server-side wrapper around the pure `resolveProvider` chain. Reads
 * the persona's frontmatter for level-3 overrides, combines with
 * any per-run action+runtime overrides, then walks the registry to
 * produce the final `(Provider, model, effort)` triple plus a
 * `ProviderResolution` audit record.
 *
 * Behavior when the resolved provider isn't registered (e.g.
 * persona pins `provider: openai` but no key is configured): falls
 * back to the registry's `resolve()` and adds a normalization note
 * to the result. The caller can decide whether to surface that as a
 * warning or hard-fail the run.
 */
export interface ResolvedProviderHandle {
  /** Concrete Provider instance to call `chat()` on. */
  provider: Provider;
  /** Model the executor should send. */
  model: string;
  /** Effort tier — Anthropic non-Haiku honors it; Ollama maps to temperature. */
  effort: Effort;
  /** Audit record for `agent_runs` + the AI-panel resolution chip. */
  resolution: ProviderResolution;
}

export function resolveProviderForRun(args: {
  registry: ProviderRegistry;
  globalDefaults: GlobalProviderDefaults;
  /** Project data root — used to read `data/.agents/<slug>/persona.md`. */
  dataRoot: string;
  /** Agent slug — selects the persona file. */
  agentSlug: string;
  /** Per-run action override (e.g. composer's `/effort high`). */
  actionOverride?: ProviderOverride | null;
  /** Per-conversation runtime override (composer's effort slider). */
  runtimeOverride?: ProviderOverride | null;
}): ResolvedProviderHandle {
  const personaOverride = readPersonaOverride(args.dataRoot, args.agentSlug);

  const resolution = resolveProvider({
    action: args.actionOverride ?? null,
    runtime: args.runtimeOverride ?? null,
    persona: personaOverride,
    global: args.globalDefaults,
  });

  // Look up the concrete Provider instance. If the resolver picked a
  //  provider name that isn't registered (persona pinned `openai` but
  //  no key configured), fall back to the registry's first available
  //  and append a note so the audit record reflects the swap.
  let provider = args.registry.get(resolution.provider) ?? null;
  let finalModel = resolution.model;
  if (!provider) {
    const fallback = args.registry.resolve();
    if (!fallback) {
      throw new Error(
        `No provider available for run: persona/global asked for '${resolution.provider}' but none are registered.`,
      );
    }
    resolution.notes.push(
      `provider '${resolution.provider}' not registered — fell back to '${fallback.name}'`,
    );
    resolution.provider = fallback.name as ProviderId;
    resolution.source.provider = "global";
    provider = fallback;
    // The previously-resolved model probably belonged to the missing
    //  provider. Swap to the fallback's default so we don't ship an
    //  Anthropic model name to Ollama (or vice-versa).
    if (provider.name === "anthropic" && !finalModel.startsWith("claude-")) {
      finalModel = args.globalDefaults.model;
      resolution.source.model = "global";
    }
    if (provider.name === "ollama" && finalModel.startsWith("claude-")) {
      finalModel = args.registry.getOllamaModels()[0] ?? "llama3";
      resolution.source.model = "global";
    }
    resolution.model = finalModel;
  }

  return {
    provider,
    model: resolution.model,
    effort: resolution.effort,
    resolution,
  };
}

/**
 * Read `data/.agents/<slug>/persona.md`, parse its YAML frontmatter,
 * and extract the three resolution fields. Returns `null` if the
 * file is missing or the frontmatter doesn't opine on any of them —
 * which is the common case (most personas inherit from global).
 */
function readPersonaOverride(dataRoot: string, slug: string): ProviderOverride | null {
  const personaPath = join(dataRoot, ".agents", slug, "persona.md");
  if (!existsSync(personaPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(personaPath, "utf-8");
  } catch {
    return null;
  }
  const match = /^---[^\n]*\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match?.[1]) return null;
  let doc: Record<string, unknown>;
  try {
    const parsed = loadYaml(match[1]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    doc = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const provider = pickProvider(doc.provider);
  const model = typeof doc.model === "string" && doc.model.trim() ? doc.model.trim() : undefined;
  const effort = pickEffort(doc.effort);

  if (provider === undefined && model === undefined && effort === undefined) return null;
  return { provider, model, effort };
}

function pickProvider(value: unknown): ProviderId | undefined {
  if (value !== "anthropic" && value !== "ollama" && value !== "openai" && value !== "claude-cli") {
    return undefined;
  }
  return value;
}

function pickEffort(value: unknown): Effort | undefined {
  if (value === "low" || value === "medium" || value === "high") return value;
  return undefined;
}
