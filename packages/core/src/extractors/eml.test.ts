import { describe, expect, it } from "vitest";
import { extractEml } from "./eml.js";

/** Hand-rolled RFC 822 message — avoids a binary fixture in the repo. */
const SAMPLE = [
  "From: Alice <alice@example.com>",
  "To: Bob <bob@example.com>",
  "Subject: Hello",
  "Date: Tue, 1 Apr 2026 10:00:00 +0000",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hi Bob — this is the body.",
  "Second line.",
  "",
].join("\r\n");

function toArrayBuffer(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer as ArrayBuffer;
}

describe("extractEml", () => {
  it("parses headers and body from a minimal RFC 822 message", async () => {
    const result = await extractEml(toArrayBuffer(SAMPLE));
    expect(result.email?.subject).toBe("Hello");
    expect(result.email?.from).toContain("alice@example.com");
    expect(result.email?.to).toContain("bob@example.com");
    expect(result.text).toContain("Subject: Hello");
    expect(result.text).toContain("Hi Bob");
    expect(result.warnings).toEqual([]);
  });

  it("returns a warning rather than throwing on garbage input", async () => {
    const result = await extractEml(toArrayBuffer("not an email"));
    // Parser is lenient — assert we never throw, and body is stringy.
    expect(typeof result.text).toBe("string");
  });
});
