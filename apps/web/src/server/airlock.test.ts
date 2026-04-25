import { describe, expect, it, vi } from "vitest";
import { createAirlockSession, EgressDowngradedError } from "./airlock.js";

/**
 * Airlock primitive — pre/post-downgrade fetch behaviour, the
 * one-way invariant, and the `onDowngrade` notification hook.
 * The actual cross-project search trigger lives in
 * `kb-global-search.test.ts`; this file only exercises the
 * downgradable-fetch wrapper itself.
 */

describe("createAirlockSession", () => {
  it("forwards through to the base fetch pre-downgrade", async () => {
    const baseFetch = vi
      .fn(async (url: string | URL, _init?: RequestInit) => new Response(`hit:${String(url)}`))
      .mockName("base");
    const session = createAirlockSession(baseFetch);
    const res = await session.fetch("https://example.com/x");
    expect(await res.text()).toBe("hit:https://example.com/x");
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it("post-downgrade fetches throw EgressDowngradedError without touching base", async () => {
    const baseFetch = vi.fn(async () => new Response("nope"));
    const session = createAirlockSession(baseFetch);
    session.downgrade("read a foreign block");
    await expect(session.fetch("https://example.com/")).rejects.toBeInstanceOf(
      EgressDowngradedError,
    );
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it("downgrade is one-way + idempotent — first reason wins", async () => {
    const onDowngrade = vi.fn();
    const session = createAirlockSession(async () => new Response(""), onDowngrade);
    session.downgrade("first reason");
    session.downgrade("second reason"); // no-op
    expect(session.getStatus().reason).toBe("first reason");
    expect(onDowngrade).toHaveBeenCalledTimes(1);
  });

  it("getStatus() reflects the downgraded flag + at timestamp", async () => {
    const session = createAirlockSession(async () => new Response(""));
    expect(session.getStatus().downgraded).toBe(false);
    expect(session.getStatus().reason).toBeNull();

    session.downgrade("airlock fired");

    const status = session.getStatus();
    expect(status.downgraded).toBe(true);
    expect(status.reason).toBe("airlock fired");
    expect(status.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("EgressDowngradedError carries status 451 + reason for audit", () => {
    const err = new EgressDowngradedError("test reason");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("EgressDowngradedError");
    expect(err.status).toBe(451);
    expect(err.reason).toBe("test reason");
    expect(err.message).toContain("test reason");
  });

  it("onDowngrade callback receives the populated status snapshot", async () => {
    const captured: Array<{ downgraded: boolean; reason: string | null }> = [];
    const session = createAirlockSession(
      async () => new Response(""),
      (status) => captured.push({ downgraded: status.downgraded, reason: status.reason }),
    );
    session.downgrade("malicious page detected");
    expect(captured).toEqual([{ downgraded: true, reason: "malicious page detected" }]);
  });
});
