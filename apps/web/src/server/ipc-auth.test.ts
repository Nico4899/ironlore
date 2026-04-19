import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IPC_TOKEN_FILE } from "@ironlore/core";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIpcAuthMiddleware } from "./ipc-auth.js";

/**
 * IPC auth middleware tests.
 *
 * Verifies:
 *   - Non-loopback socket is rejected (403)
 *   - Missing token header is rejected (401)
 *   - Wrong token is rejected (401)
 *   - Correct loopback + matching token passes through
 *   - Forwarded headers cannot spoof loopback (security regression test)
 */

function makeInstallRoot(): string {
  const dir = join(tmpdir(), `ipc-auth-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function buildRequest(opts: { token?: string; remoteAddress: string; forwardedFor?: string }): {
  mockIncoming: { socket: { remoteAddress: string } };
} {
  return {
    mockIncoming: { socket: { remoteAddress: opts.remoteAddress } },
  };
}

describe("IPC auth middleware", () => {
  let installRoot: string;
  const token = "test-token-1234567890abcdef";

  beforeEach(() => {
    installRoot = makeInstallRoot();
    writeFileSync(join(installRoot, IPC_TOKEN_FILE), token, { mode: 0o600 });
  });

  afterEach(() => {
    // temp dirs are cleaned by OS
  });

  async function callMiddleware(opts: {
    remoteAddress: string;
    providedToken?: string;
    forwardedFor?: string;
  }): Promise<{ status: number; body: unknown }> {
    const app = new Hono();
    app.use("*", createIpcAuthMiddleware(installRoot));
    app.get("/", (c) => c.json({ ok: true }));

    const { mockIncoming } = buildRequest(opts);
    const headers: Record<string, string> = {};
    if (opts.providedToken) headers["X-Ironlore-Worker-Token"] = opts.providedToken;
    if (opts.forwardedFor) headers["x-forwarded-for"] = opts.forwardedFor;

    const res = await app.request("/", { headers }, { incoming: mockIncoming });
    const body = await res.json();
    return { status: res.status, body };
  }

  it("allows loopback + correct token", async () => {
    const res = await callMiddleware({
      remoteAddress: "127.0.0.1",
      providedToken: token,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("allows IPv6 loopback (::1)", async () => {
    const res = await callMiddleware({
      remoteAddress: "::1",
      providedToken: token,
    });
    expect(res.status).toBe(200);
  });

  it("allows IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)", async () => {
    const res = await callMiddleware({
      remoteAddress: "::ffff:127.0.0.1",
      providedToken: token,
    });
    expect(res.status).toBe(200);
  });

  it("rejects non-loopback socket (403)", async () => {
    const res = await callMiddleware({
      remoteAddress: "192.168.1.100",
      providedToken: token,
    });
    expect(res.status).toBe(403);
  });

  it("rejects missing token (401)", async () => {
    const res = await callMiddleware({
      remoteAddress: "127.0.0.1",
    });
    expect(res.status).toBe(401);
  });

  it("rejects wrong token (401)", async () => {
    const res = await callMiddleware({
      remoteAddress: "127.0.0.1",
      providedToken: "wrong-token",
    });
    expect(res.status).toBe(401);
  });

  it("rejects spoofed X-Forwarded-For from non-loopback socket", async () => {
    // Regression test: attacker claims loopback via header while
    // connecting from a real external IP. Middleware must not trust it.
    const res = await callMiddleware({
      remoteAddress: "203.0.113.42",
      forwardedFor: "127.0.0.1",
      providedToken: token,
    });
    expect(res.status).toBe(403);
  });

  it("rejects when socket remoteAddress is empty", async () => {
    const res = await callMiddleware({
      remoteAddress: "",
      providedToken: token,
    });
    expect(res.status).toBe(403);
  });
});
