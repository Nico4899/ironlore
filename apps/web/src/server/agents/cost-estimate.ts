/**
 * Pre-run cost estimation for BYOK safety.
 *
 * Before an autonomous heartbeat runs, estimate the token cost from a
 * lookup table of provider prices. Show a dialog, user confirms.
 * Opt-out via `estimate_before: false` in the agent's persona.
 *
 * See docs/04-ai-and-agents.md §Cost safety rails.
 */

/** Per-million token prices — built-in defaults, overridable in project.yaml. */
const DEFAULT_PRICES: Record<string, { input: number; output: number }> = {
  // Anthropic
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-haiku-4-20250514": { input: 0.8, output: 4.0 },
  "claude-opus-4-20250514": { input: 15.0, output: 75.0 },
  // OpenAI
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  // Gemini
  "gemini-2.5-flash": { input: 0.15, output: 0.6 },
  "gemini-2.5-pro": { input: 1.25, output: 10.0 },
};

export interface CostEstimate {
  model: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
  pricePerMillionInput: number;
  pricePerMillionOutput: number;
}

/**
 * Estimate the cost of an agent run.
 *
 * Uses a rough heuristic: system prompt tokens + conversation context
 * tokens for input, per-run output cap for output. Prices come from
 * the built-in table or per-project overrides.
 */
export function estimateRunCost(
  model: string,
  systemPromptTokens: number,
  contextTokens: number,
  outputCapTokens: number,
  priceOverrides?: Record<string, { input: number; output: number }>,
): CostEstimate {
  const prices = priceOverrides?.[model] ?? DEFAULT_PRICES[model] ?? { input: 1.0, output: 5.0 };

  const inputTokens = systemPromptTokens + contextTokens;
  const outputTokens = outputCapTokens;
  const cost =
    (inputTokens / 1_000_000) * prices.input + (outputTokens / 1_000_000) * prices.output;

  return {
    model,
    estimatedInputTokens: inputTokens,
    estimatedOutputTokens: outputTokens,
    estimatedCostUsd: Math.round(cost * 10000) / 10000,
    pricePerMillionInput: prices.input,
    pricePerMillionOutput: prices.output,
  };
}

/**
 * Format a cost estimate as a human-readable string.
 */
export function formatCostEstimate(est: CostEstimate): string {
  return [
    `Model: ${est.model}`,
    `Estimated tokens: ~${est.estimatedInputTokens.toLocaleString()} input + ~${est.estimatedOutputTokens.toLocaleString()} output`,
    `Estimated cost: $${est.estimatedCostUsd.toFixed(4)}`,
    `Price: $${est.pricePerMillionInput}/M input, $${est.pricePerMillionOutput}/M output`,
  ].join("\n");
}
