import { describe, expect, it } from "vitest";
import {
  type GlobalProviderDefaults,
  type ProviderOverride,
  resolveProvider,
} from "./provider-resolution.js";

const GLOBAL: GlobalProviderDefaults = {
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  effort: "medium",
};

describe("resolveProvider — level precedence", () => {
  it("falls through to global when nothing overrides", () => {
    const r = resolveProvider({
      action: null,
      runtime: null,
      persona: null,
      global: GLOBAL,
    });
    expect(r.provider).toBe("anthropic");
    expect(r.model).toBe("claude-sonnet-4-20250514");
    expect(r.effort).toBe("medium");
    expect(r.source.provider).toBe("global");
    expect(r.source.model).toBe("global");
    expect(r.source.effort).toBe("global");
    expect(r.notes).toEqual([]);
  });

  it("picks persona over global", () => {
    const persona: ProviderOverride = { provider: "ollama", model: "llama3.2" };
    const r = resolveProvider({ action: null, runtime: null, persona, global: GLOBAL });
    expect(r.provider).toBe("ollama");
    expect(r.model).toBe("llama3.2");
    expect(r.effort).toBe("medium"); // not overridden — falls through to global
    expect(r.source.provider).toBe("persona");
    expect(r.source.model).toBe("persona");
    expect(r.source.effort).toBe("global");
  });

  it("picks runtime over persona", () => {
    const persona: ProviderOverride = { effort: "low" };
    const runtime: ProviderOverride = { effort: "high" };
    const r = resolveProvider({ action: null, runtime, persona, global: GLOBAL });
    expect(r.effort).toBe("high");
    expect(r.source.effort).toBe("runtime");
  });

  it("picks action over runtime + persona", () => {
    const persona: ProviderOverride = { provider: "ollama", model: "llama3.2", effort: "low" };
    const runtime: ProviderOverride = { effort: "high" };
    const action: ProviderOverride = { model: "claude-opus-4-1-20250805" };
    const r = resolveProvider({ action, runtime, persona, global: GLOBAL });
    expect(r.provider).toBe("ollama"); // persona wins (action didn't set it)
    expect(r.model).toBe("claude-opus-4-1-20250805"); // action wins
    expect(r.effort).toBe("high"); // runtime wins (action didn't set it)
    expect(r.source.provider).toBe("persona");
    expect(r.source.model).toBe("action");
    expect(r.source.effort).toBe("runtime");
  });

  it("each field resolves independently", () => {
    const action: ProviderOverride = { effort: "high" };
    const persona: ProviderOverride = { provider: "anthropic", model: "claude-haiku-4-5" };
    const r = resolveProvider({
      action,
      runtime: null,
      persona,
      global: { provider: "openai", model: "gpt-4o", effort: "low" },
    });
    expect(r.provider).toBe("anthropic");
    expect(r.model).toBe("claude-haiku-4-5");
    expect(r.source.provider).toBe("persona");
    expect(r.source.model).toBe("persona");
    // action set effort=high but Haiku normalization fires (see below)
    expect(r.source.effort).toBe("action");
  });
});

describe("resolveProvider — normalization rules", () => {
  it("drops effort on Anthropic Haiku models with a note", () => {
    const r = resolveProvider({
      action: { effort: "high" },
      runtime: null,
      persona: { provider: "anthropic", model: "claude-haiku-4-5" },
      global: GLOBAL,
    });
    expect(r.effort).toBe("medium");
    expect(r.notes).toContain(
      "effort 'high' dropped — Anthropic Haiku models do not honor reasoning effort",
    );
  });

  it("does not strip effort on Sonnet (Haiku rule scoped)", () => {
    const r = resolveProvider({
      action: { effort: "high" },
      runtime: null,
      persona: { provider: "anthropic", model: "claude-sonnet-4-7" },
      global: GLOBAL,
    });
    expect(r.effort).toBe("high");
    expect(r.notes).toEqual([]);
  });

  it("does not strip effort on Ollama models", () => {
    const r = resolveProvider({
      action: { effort: "high" },
      runtime: null,
      persona: { provider: "ollama", model: "haiku-finetune" },
      global: GLOBAL,
    });
    // Note: even though the model name contains "haiku", the rule
    // only fires for Anthropic — Ollama maps effort → temperature.
    expect(r.effort).toBe("high");
    expect(r.notes).toEqual([]);
  });

  it("Haiku rule passes through 'medium' silently (already the dropped value)", () => {
    const r = resolveProvider({
      action: { effort: "medium" },
      runtime: null,
      persona: { provider: "anthropic", model: "claude-haiku-4-5" },
      global: GLOBAL,
    });
    expect(r.effort).toBe("medium");
    expect(r.notes).toEqual([]); // no note when effort was already medium
  });
});

describe("resolveProvider — partial overrides", () => {
  it("ignores undefined fields in an override (treats as not-set)", () => {
    const persona: ProviderOverride = { provider: undefined, model: "claude-opus-4-1-20250805" };
    const r = resolveProvider({ action: null, runtime: null, persona, global: GLOBAL });
    expect(r.provider).toBe("anthropic"); // global, since persona's provider is undefined
    expect(r.model).toBe("claude-opus-4-1-20250805");
    expect(r.source.provider).toBe("global");
  });

  it("treats null layer as fully absent", () => {
    const r = resolveProvider({
      action: null,
      runtime: null,
      persona: null,
      global: GLOBAL,
    });
    expect(r.source.provider).toBe("global");
  });

  it("empty-object layer is identical to null", () => {
    const r = resolveProvider({
      action: {},
      runtime: {},
      persona: {},
      global: GLOBAL,
    });
    expect(r.source.provider).toBe("global");
    expect(r.source.model).toBe("global");
    expect(r.source.effort).toBe("global");
  });
});
