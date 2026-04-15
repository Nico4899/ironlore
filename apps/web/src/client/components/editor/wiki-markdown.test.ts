import { describe, expect, it } from "vitest";
import { wikiMarkdownParser, wikiMarkdownSerializer } from "./wiki-markdown.js";

function roundtrip(md: string): string {
  const doc = wikiMarkdownParser.parse(md);
  if (!doc) throw new Error("parse failed");
  return wikiMarkdownSerializer.serialize(doc);
}

describe("wiki-markdown", () => {
  it("preserves a simple wiki-link", () => {
    expect(roundtrip("See [[Foo]] for details.")).toBe("See [[Foo]] for details.");
  });

  it("preserves a block-ref wiki-link", () => {
    expect(roundtrip("See [[Foo#blk_01HABC]] there.")).toBe("See [[Foo#blk_01HABC]] there.");
  });

  it("preserves a piped display alias", () => {
    expect(roundtrip("See [[Foo|the foo page]].")).toBe("See [[Foo|the foo page]].");
  });

  it("leaves plain [bracket] links alone", () => {
    expect(roundtrip("[not a wikilink] and [link](url)")).toContain("[link](url)");
  });

  it("does not consume unterminated [[", () => {
    const md = "Incomplete [[ marker here.";
    // Round-tripping must not crash; serialized output may escape the brackets
    // but must preserve text content.
    const out = roundtrip(md);
    expect(out).toContain("Incomplete");
    expect(out).toContain("marker here");
  });

  it("handles multiple wiki-links in one paragraph", () => {
    const md = "Both [[A]] and [[B|bee]] are linked.";
    expect(roundtrip(md)).toBe("Both [[A]] and [[B|bee]] are linked.");
  });
});
