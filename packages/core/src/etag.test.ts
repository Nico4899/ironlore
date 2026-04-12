import { describe, expect, it } from "vitest";
import { computeEtag, parseEtag } from "./etag.js";

describe("computeEtag", () => {
  it("returns a quoted sha256 hash", () => {
    const etag = computeEtag("hello world");
    expect(etag).toMatch(/^"sha256-[a-f0-9]{64}"$/);
  });

  it("returns the same hash for the same content", () => {
    const a = computeEtag("test content");
    const b = computeEtag("test content");
    expect(a).toBe(b);
  });

  it("returns different hashes for different content", () => {
    const a = computeEtag("content A");
    const b = computeEtag("content B");
    expect(a).not.toBe(b);
  });

  it("works with Buffer input", () => {
    const str = computeEtag("hello");
    const buf = computeEtag(Buffer.from("hello"));
    expect(str).toBe(buf);
  });
});

describe("parseEtag", () => {
  it("strips surrounding quotes", () => {
    expect(parseEtag('"sha256-abc123"')).toBe("sha256-abc123");
  });

  it("returns unquoted strings as-is", () => {
    expect(parseEtag("sha256-abc123")).toBe("sha256-abc123");
  });
});
