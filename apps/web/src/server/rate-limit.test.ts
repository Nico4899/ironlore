import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { agentRateLimiter, authRateLimiter } from "./rate-limit.js";

describe("authRateLimiter", () => {
  it("allows requests within the limit", async () => {
    const app = new Hono();
    app.use("*", authRateLimiter());
    app.post("/login", (c) => c.json({ ok: true }));

    // AUTH_RATE_LIMIT is 5 — all 5 should pass
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/login", { method: "POST" });
      expect(res.status).toBe(200);
    }
  });

  it("blocks requests exceeding the limit", async () => {
    const app = new Hono();
    app.use("*", authRateLimiter());
    app.post("/login", (c) => c.json({ ok: true }));

    // Exhaust the bucket (5 requests)
    for (let i = 0; i < 5; i++) {
      await app.request("/login", { method: "POST" });
    }

    // 6th request should be rate-limited
    const res = await app.request("/login", { method: "POST" });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain("Too many login attempts");
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
