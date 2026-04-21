import { AUTH_RATE_LIMIT } from "@ironlore/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { agentRateLimiter, authRateLimiter } from "./rate-limit.js";

describe("authRateLimiter", () => {
  it("allows requests within the limit", async () => {
    const app = new Hono();
    app.use("*", authRateLimiter());
    app.post("/login", (c) => c.json({ ok: true }));

    // All requests within the cap should pass — read from the shared
    //  constant so future tuning (we recently raised this from 5 to
    //  20 after Cmd+R reload lockouts) doesn't break the test.
    for (let i = 0; i < AUTH_RATE_LIMIT; i++) {
      const res = await app.request("/login", { method: "POST" });
      expect(res.status).toBe(200);
    }
  });

  it("blocks requests exceeding the limit", async () => {
    const app = new Hono();
    app.use("*", authRateLimiter());
    app.post("/login", (c) => c.json({ ok: true }));

    // Exhaust the bucket at whatever the current limit is.
    for (let i = 0; i < AUTH_RATE_LIMIT; i++) {
      await app.request("/login", { method: "POST" });
    }

    // Next request should be rate-limited.
    const res = await app.request("/login", { method: "POST" });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain("Too many login attempts");
  });

  it("exempts /me from the limiter", async () => {
    // Session probes hit this path on every page reload. Gating it
    //  caused spurious logouts after a few fast Cmd+R reloads.
    const app = new Hono();
    app.use("/api/auth/*", authRateLimiter());
    app.get("/api/auth/me", (c) => c.json({ ok: true }));

    // Many more than AUTH_RATE_LIMIT, all must pass.
    for (let i = 0; i < AUTH_RATE_LIMIT + 5; i++) {
      const res = await app.request("/api/auth/me");
      expect(res.status).toBe(200);
    }
  });
});

describe("agentRateLimiter", () => {
  it("allows requests within the agent limit", async () => {
    const app = new Hono();
    app.use("*", agentRateLimiter());
    app.post("/tool", (c) => c.json({ ok: true }));

    // AGENT_RATE_LIMIT is 60 — first several should pass
    for (let i = 0; i < 10; i++) {
      const res = await app.request("/tool", {
        method: "POST",
        headers: { "x-ironlore-agent": "test-agent" },
      });
      expect(res.status).toBe(200);
    }
  });
});
