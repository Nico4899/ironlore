import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackpressureController } from "./backpressure.js";

/**
 * BackpressureController tests.
 *
 * Verifies:
 *   - canProceed returns true under the cap, false at/over
 *   - acquire/release track active counts
 *   - onRateLimit halves the cap to 1 minimum
 *   - Per-provider isolation (one throttled doesn't affect others)
 *   - Recovery doubles cap, capped by maxParallel
 */

describe("BackpressureController — active counting", () => {
  let bp: BackpressureController;

  beforeEach(() => {
    bp = new BackpressureController(10);
  });

  afterEach(() => {
    bp.stop();
  });

  it("allows requests under the cap", () => {
    expect(bp.canProceed("anthropic")).toBe(true);
    bp.acquire("anthropic");
    expect(bp.canProceed("anthropic")).toBe(true);
  });

  it("blocks requests at the cap", () => {
    for (let i = 0; i < 10; i++) bp.acquire("anthropic");
    expect(bp.canProceed("anthropic")).toBe(false);
  });

  it("release frees capacity", () => {
    for (let i = 0; i < 10; i++) bp.acquire("anthropic");
    expect(bp.canProceed("anthropic")).toBe(false);
    bp.release("anthropic");
    expect(bp.canProceed("anthropic")).toBe(true);
  });

  it("release does not go below zero", () => {
    bp.release("anthropic");
    bp.release("anthropic");
    expect(bp.getActive("anthropic")).toBe(0);
  });
});

describe("BackpressureController — rate limiting", () => {
  let bp: BackpressureController;

  beforeEach(() => {
    bp = new BackpressureController(20);
  });

  afterEach(() => {
    bp.stop();
  });

  it("halves cap on 429", () => {
    expect(bp.getCap("anthropic")).toBe(20);
    bp.onRateLimit("anthropic");
    expect(bp.getCap("anthropic")).toBe(10);
  });

  it("halves again on second 429", () => {
    bp.onRateLimit("anthropic");
    bp.onRateLimit("anthropic");
    expect(bp.getCap("anthropic")).toBe(5);
  });

  it("never drops below 1", () => {
    for (let i = 0; i < 20; i++) bp.onRateLimit("anthropic");
    expect(bp.getCap("anthropic")).toBe(1);
  });

  it("per-provider isolation: Anthropic throttled does not affect OpenAI", () => {
    bp.onRateLimit("anthropic");
    expect(bp.getCap("anthropic")).toBe(10);
    expect(bp.getCap("openai")).toBe(20);
  });
});

describe("BackpressureController — recovery", () => {
  let bp: BackpressureController;

  beforeEach(() => {
    bp = new BackpressureController(16);
  });

  afterEach(() => {
    bp.stop();
  });

  it("recovery doubles cap when last throttle was >60s ago", () => {
    bp.onRateLimit("anthropic");
    expect(bp.getCap("anthropic")).toBe(8);

    // Simulate 60s passing by mutating the internal lastThrottle.
    // biome-ignore lint/suspicious/noExplicitAny: private field access for test
    (bp as any).lastThrottle.set("anthropic", Date.now() - 61_000);

    // biome-ignore lint/suspicious/noExplicitAny: private method invocation for test
    (bp as any).recover();
    expect(bp.getCap("anthropic")).toBe(16);
  });

  it("recovery is capped at maxParallel", () => {
    bp.onRateLimit("anthropic");
    // biome-ignore lint/suspicious/noExplicitAny: private field access for test
    (bp as any).lastThrottle.set("anthropic", Date.now() - 61_000);
    // biome-ignore lint/suspicious/noExplicitAny: private method invocation for test
    (bp as any).recover();
    // biome-ignore lint/suspicious/noExplicitAny: private method invocation for test
    (bp as any).recover();
    expect(bp.getCap("anthropic")).toBeLessThanOrEqual(16);
  });

  it("recovery does not trigger for recently-throttled providers", () => {
    bp.onRateLimit("anthropic");
    // lastThrottle is now — recovery should not run.
    // biome-ignore lint/suspicious/noExplicitAny: private method invocation for test
    (bp as any).recover();
    expect(bp.getCap("anthropic")).toBe(8); // unchanged
  });
});
