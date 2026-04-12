import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateBind } from "./network.js";

describe("validateBind", () => {
  const originalExit = process.exit;
  const originalEnv = { ...process.env };
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

  it("allows loopback 127.0.0.1", () => {
    validateBind("127.0.0.1");
    expect(exitCalled).toBeUndefined();
  });

  it("allows loopback ::1", () => {
    validateBind("::1");
    expect(exitCalled).toBeUndefined();
  });

  it("allows loopback localhost", () => {
    validateBind("localhost");
    expect(exitCalled).toBeUndefined();
  });

  it("rejects 0.0.0.0 without IRONLORE_PUBLIC_URL", () => {
    delete process.env.IRONLORE_PUBLIC_URL;
    validateBind("0.0.0.0");
    expect(exitCalled).toBe(1);
  });

  it("rejects 0.0.0.0 with non-https IRONLORE_PUBLIC_URL", () => {
    process.env.IRONLORE_PUBLIC_URL = "http://example.com";
    validateBind("0.0.0.0");
    expect(exitCalled).toBe(1);
  });

  it("allows 0.0.0.0 with https IRONLORE_PUBLIC_URL", () => {
    process.env.IRONLORE_PUBLIC_URL = "https://example.com";
    validateBind("0.0.0.0");
    expect(exitCalled).toBeUndefined();
  });
});
