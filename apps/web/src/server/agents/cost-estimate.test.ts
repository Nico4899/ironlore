import { describe, expect, it } from "vitest";
import { estimateRunCost, formatCostEstimate } from "./cost-estimate.js";

/**
 * Cost estimate tests.
 *
 * Verifies the built-in price table, the input+output summation, and
 * the override mechanism for per-project pricing.
 */

describe("estimateRunCost — Anthropic defaults", () => {
  it("computes Sonnet cost correctly", () => {
    // 1000 in + 500 out tokens at $3/M in + $15/M out.
    // = (1000/1e6)*3 + (500/1e6)*15 = 0.003 + 0.0075 = 0.0105
    const est = estimateRunCost("claude-sonnet-4-20250514", 500, 500, 500);
    expect(est.model).toBe("claude-sonnet-4-20250514");
    expect(est.estimatedInputTokens).toBe(1000);
    expect(est.estimatedOutputTokens).toBe(500);
    expect(est.pricePerMillionInput).toBe(3);
    expect(est.pricePerMillionOutput).toBe(15);
    expect(est.estimatedCostUsd).toBeCloseTo(0.0105, 4);
  });

  it("computes Haiku (cheaper) correctly", () => {
    const est = estimateRunCost("claude-haiku-4-20250514", 1000, 1000, 1000);
    // (2000/1e6)*0.8 + (1000/1e6)*4 = 0.0016 + 0.004 = 0.0056
    expect(est.estimatedCostUsd).toBeCloseTo(0.0056, 4);
  });

  it("computes Opus (expensive) correctly", () => {
    const est = estimateRunCost("claude-opus-4-20250514", 1000, 1000, 1000);
    // (2000/1e6)*15 + (1000/1e6)*75 = 0.03 + 0.075 = 0.105
    expect(est.estimatedCostUsd).toBeCloseTo(0.105, 4);
  });
});

describe("estimateRunCost — OpenAI + Gemini", () => {
  it("handles gpt-4o", () => {
    const est = estimateRunCost("gpt-4o", 1000, 1000, 1000);
    expect(est.pricePerMillionInput).toBe(2.5);
    expect(est.pricePerMillionOutput).toBe(10);
  });

  it("handles gpt-4o-mini", () => {
    const est = estimateRunCost("gpt-4o-mini", 1000, 1000, 1000);
    expect(est.pricePerMillionInput).toBe(0.15);
    expect(est.pricePerMillionOutput).toBe(0.6);
  });

  it("handles gemini-2.5-pro", () => {
    const est = estimateRunCost("gemini-2.5-pro", 1000, 1000, 1000);
    expect(est.pricePerMillionInput).toBe(1.25);
  });
});

describe("estimateRunCost — fallback + overrides", () => {
  it("falls back to safe default for unknown models", () => {
    const est = estimateRunCost("made-up-model-v99", 1000, 1000, 1000);
    expect(est.pricePerMillionInput).toBe(1.0);
    expect(est.pricePerMillionOutput).toBe(5.0);
  });

  it("applies per-project price override", () => {
    const overrides = { "custom-model": { input: 0.5, output: 2.0 } };
    const est = estimateRunCost("custom-model", 1000, 1000, 1000, overrides);
    expect(est.pricePerMillionInput).toBe(0.5);
    expect(est.pricePerMillionOutput).toBe(2.0);
  });

  it("override takes precedence over built-in price", () => {
    const overrides = { "gpt-4o": { input: 0.01, output: 0.02 } };
    const est = estimateRunCost("gpt-4o", 1000, 1000, 1000, overrides);
    expect(est.pricePerMillionInput).toBe(0.01);
  });
});

describe("estimateRunCost — edge cases", () => {
  it("handles zero tokens", () => {
    const est = estimateRunCost("gpt-4o", 0, 0, 0);
    expect(est.estimatedCostUsd).toBe(0);
  });

  it("rounds cost to 4 decimal places", () => {
    const est = estimateRunCost("gpt-4o", 1, 1, 1);
    // Very small number — should be rounded.
    const rounded = Math.round(est.estimatedCostUsd * 10000) / 10000;
    expect(est.estimatedCostUsd).toBe(rounded);
  });

  it("sums systemPrompt + context for input", () => {
    const est = estimateRunCost("gpt-4o", 1000, 2000, 0);
    expect(est.estimatedInputTokens).toBe(3000);
  });
});

describe("formatCostEstimate", () => {
  it("includes model, tokens, cost, and prices", () => {
    const est = estimateRunCost("gpt-4o-mini", 500, 500, 500);
    const formatted = formatCostEstimate(est);
    expect(formatted).toContain("gpt-4o-mini");
    expect(formatted).toContain("1,000");
    expect(formatted).toContain("500");
    expect(formatted).toContain("$");
  });
});
