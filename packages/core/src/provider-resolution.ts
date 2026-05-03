/**
 * Per-run provider resolution — the four-level chain that decides
 * which provider, model, and effort an agent run actually uses.
 *
 * The chain (highest precedence first):
 *
 *   1. **action**   — per-message override from the AI panel composer
 *                     (e.g. user typed `/model haiku` before sending).
 *   2. **runtime**  — per-conversation default the user pinned for the
 *                     session (composer's effort slider, persisted in
 *                     `useAIPanelStore.runtimeOverride`).
 *   3. **persona**  — frontmatter defaults on `.agents/<slug>/persona.md`
 *                     (`provider:`, `model:`, `effort:`).
 *   4. **global**   — server-side fallbacks the host installs at startup
 *                     (default model per provider; "medium" effort).
 *
 * The resolver is **pure**: it returns a single `ProviderResolution`
 * object recording both the chosen value AND the source level for each
 * field, plus a `notes[]` log of any normalization that fired (e.g.
 * "effort dropped — Haiku doesn't support reasoning effort"). Side
 * effects (DB writes, logging, provider lookups) live at the call site.
 *
 * Normalization rules applied AFTER level resolution:
 *   - Anthropic Haiku models drop `effort` (they don't accept the param).
 *   - Ollama maps `effort` to a temperature offset, but the executor
 *     handles that — the resolver only validates the field still has
 *     a meaningful value for the chosen provider.
 *
 * See [docs/04-ai-and-agents.md §Provider override chain](../../../docs/04-ai-and-agents.md).
 */

import type { ProviderId } from "./types.js";

export type Effort = "low" | "medium" | "high";
export type ResolutionLevel = "action" | "runtime" | "persona" | "global";

/**
 * One level's contribution to the chain. Every field is optional;
 * `undefined` means "this level does not opine," which is how the
 * resolver knows to fall through to the next level.
 */
export interface ProviderOverride {
  provider?: ProviderId;
  model?: string;
  effort?: Effort;
}

/** Server-side fallback. Same shape as override, but every field is required. */
export interface GlobalProviderDefaults {
  provider: ProviderId;
  model: string;
  effort: Effort;
}

/**
 * Resolved triple plus per-field source labels and a normalization
 * log. Persisted into `agent_runs` so the Agent detail page can show
 * "Run 0042: anthropic / claude-sonnet-4-7 / medium (from persona)".
 */
export interface ProviderResolution {
  provider: ProviderId;
  model: string;
  effort: Effort;
  source: {
    provider: ResolutionLevel;
    model: ResolutionLevel;
    effort: ResolutionLevel;
  };
  /**
   * Human-readable normalization notes — empty for the common case;
   * non-empty when a rule fired (e.g. effort dropped on Haiku). The
   * UI can surface these as a tooltip on the resolution chip.
   */
  notes: string[];
}

const ORDER: readonly ResolutionLevel[] = ["action", "runtime", "persona", "global"] as const;

interface LevelInputs {
  action: ProviderOverride | null | undefined;
  runtime: ProviderOverride | null | undefined;
  persona: ProviderOverride | null | undefined;
  global: GlobalProviderDefaults;
}

/**
 * Resolve the per-run provider triple by walking the four levels
 * top-down. Each field independently picks the first level that
 * defined it; `provider`, `model`, and `effort` can each come from
 * different levels (e.g., persona pins the provider, the user
 * overrides only the effort).
 */
export function resolveProvider(inputs: LevelInputs): ProviderResolution {
  const provider = pickField(inputs, "provider", inputs.global.provider);
  const model = pickField(inputs, "model", inputs.global.model);
  const effort = pickField(inputs, "effort", inputs.global.effort);

  const notes: string[] = [];
  let finalEffort: Effort = effort.value;

  // Anthropic Haiku models silently ignore the reasoning-effort
  //  parameter on the server. Stripping it locally keeps the
  //  executor's request body honest and the diagnostics chip
  //  truthful — surfacing "high" when the model can't act on it
  //  would mislead the user.
  if (provider.value === "anthropic" && /haiku/i.test(model.value) && finalEffort !== "medium") {
    notes.push(
      `effort '${finalEffort}' dropped — Anthropic Haiku models do not honor reasoning effort`,
    );
    finalEffort = "medium";
  }

  return {
    provider: provider.value,
    model: model.value,
    effort: finalEffort,
    source: {
      provider: provider.source,
      model: model.source,
      effort: effort.source,
    },
    notes,
  };
}

/**
 * Walk the four levels for a single field, returning both the chosen
 * value and the level it came from. The global level is required, so
 * we never fall through past it — `globalFallback` is the terminal
 * value when no override level opined.
 */
function pickField<K extends keyof ProviderOverride>(
  inputs: LevelInputs,
  field: K,
  globalFallback: NonNullable<ProviderOverride[K]>,
): { value: NonNullable<ProviderOverride[K]>; source: ResolutionLevel } {
  for (const level of ORDER) {
    if (level === "global") continue;
    const layer = inputs[level];
    const v = layer?.[field];
    if (v !== undefined) {
      return { value: v as NonNullable<ProviderOverride[K]>, source: level };
    }
  }
  return { value: globalFallback, source: "global" };
}
