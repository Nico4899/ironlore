import { describe, expect, it } from "vitest";
import { ulid } from "./ulid.js";

describe("ulid", () => {
  it("generates a 26-character string", () => {
    const id = ulid();
    expect(id).toHaveLength(26);
  });

  it("uses only Crockford Base32 characters", () => {
    const id = ulid();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => ulid()));
    expect(ids.size).toBe(1000);
  });

  it("is k-sortable by time", () => {
    const early = ulid(1000);
    const late = ulid(2000);
    expect(early < late).toBe(true);
  });

  it("accepts a seed time for deterministic prefix", () => {
    const a = ulid(1700000000000);
    const b = ulid(1700000000000);
    // Same timestamp → same 10-char prefix, different random suffix
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
    expect(a).not.toBe(b); // random suffix differs
  });
});
