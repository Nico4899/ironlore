import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("allows 0.0.0.0 when IRONLORE_TRUST_NETWORK_BIND=1 (container escape hatch)", () => {
    // Used by the bundled Docker compose — the container's own
    // network namespace is the trust boundary, the host's
    // `-p 127.0.0.1:3000:3000` mapping is the actual exposure
    // control. Outside a container the env stays unset and the
    // strict HTTPS rail still applies.
    delete process.env.IRONLORE_PUBLIC_URL;
    process.env.IRONLORE_TRUST_NETWORK_BIND = "1";
    validateBind("0.0.0.0");
    expect(exitCalled).toBeUndefined();
  });
});
