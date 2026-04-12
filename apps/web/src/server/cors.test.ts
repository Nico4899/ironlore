import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCorsConfig } from "./cors.js";

describe("createCorsConfig", () => {
  const originalEnv = { ...process.env };
  const originalExit = process.exit;
  let exitCalled: number | undefined;

  beforeEach(() => {
    exitCalled = undefined;
    process.exit = ((code?: number) => {
      exitCalled = code ?? 0;
    }) as never;
  });

  afterEach(() => {
    process.exit = originalExit;
    process.env = { ...originalEnv };
  });

  it("returns null when IRONLORE_ALLOWED_ORIGINS is unset", () => {
    delete process.env.IRONLORE_ALLOWED_ORIGINS;
    expect(createCorsConfig()).toBeNull();
  });

  it("rejects wildcard *", () => {
    process.env.IRONLORE_ALLOWED_ORIGINS = "*";
    createCorsConfig();
    expect(exitCalled).toBe(1);
  });

  it("parses comma-separated origins", () => {
    process.env.IRONLORE_ALLOWED_ORIGINS = "https://a.com, https://b.com";
    const config = createCorsConfig();
    expect(config).not.toBeNull();
    expect(config?.origin).toEqual(["https://a.com", "https://b.com"]);
  });
});
