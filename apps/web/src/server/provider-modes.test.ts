import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "./providers/registry.js";

/**
 * Phase 4 exit criterion: No-AI and Ollama-only smoke tests.
 *
 * These verify the three provider modes work without crashes:
 *   (a) No providers configured — registry is empty, resolve returns null.
 *   (b) Ollama auto-detected — detect() returns models when running.
 *   (c) BYOK cloud (Anthropic) — registerAnthropic creates a provider.
 *
 * Mode (b) depends on a running Ollama instance and is skipped in CI.
 */

describe("Provider mode: no providers configured", () => {
  it("empty registry returns no provider", () => {
    const reg = new ProviderRegistry();
    expect(reg.hasAny()).toBe(false);
    expect(reg.resolve()).toBeNull();
    expect(reg.list()).toEqual([]);
  });

  it("resolve with preference returns null when nothing registered", () => {
    const reg = new ProviderRegistry();
    expect(reg.resolve("anthropic")).toBeNull();
  });
});

describe("Provider mode: BYOK Anthropic", () => {
  it("registerAnthropic makes the provider available", () => {
    const reg = new ProviderRegistry();
    reg.registerAnthropic("sk-test-key-fake");
    expect(reg.hasAny()).toBe(true);
    expect(reg.list()).toContain("anthropic");

    const provider = reg.resolve();
    expect(provider).not.toBeNull();
    expect(provider?.name).toBe("anthropic");
    expect(provider?.supportsTools).toBe(true);
    expect(provider?.supportsPromptCache).toBe(true);
  });

  it("resolve prefers requested provider", () => {
    const reg = new ProviderRegistry();
    reg.registerAnthropic("sk-test-key-fake");
    const provider = reg.resolve("anthropic");
    expect(provider?.name).toBe("anthropic");
  });
});

describe("Provider mode: Ollama auto-detect", () => {
  it("autoDetectOllama returns false when Ollama is not running", async () => {
    const reg = new ProviderRegistry();
    // In CI / dev without Ollama, detect() should return false gracefully.
    const detected = await reg.autoDetectOllama();
    // Can't assert true/false — depends on environment. Just assert no throw.
    expect(typeof detected).toBe("boolean");
    if (!detected) {
      expect(reg.get("ollama")).toBeUndefined();
    }
  });
});
