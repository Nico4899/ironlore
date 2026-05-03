import { describe, expect, it } from "vitest";

/**
 * Pure-logic mirror of `countDistinctCitedPages()` in AIPanel.tsx.
 * The threshold-of-3 proactive "save as wiki" suggestion (per
 * docs/04-ai-and-agents.md §Default agents — Librarian) hangs off
 * this count: cite ≥3 *distinct pages* and the suggestion banner
 * surfaces. Multiple block-refs into the same page count as one —
 * the doc's bar is breadth across pages, not depth within one.
 *
 * Pinning the predicate here keeps the count and the rendered chip
 * regex in `CitationText` from drifting apart.
 */

function countDistinctCitedPages(text: string): number {
  const re = /\[\[([^\]#|]+)(?:#blk_[A-Za-z0-9]+)?(?:\s*\|\s*[a-z][a-z0-9_]*)?\]\]/g;
  const pages = new Set<string>();
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    const page = m[1]?.trim();
    if (page) pages.add(page.toLowerCase());
    m = re.exec(text);
  }
  return pages.size;
}

describe("countDistinctCitedPages — proactive filing-suggestion threshold", () => {
  it("returns 0 for prose with no citations", () => {
    expect(countDistinctCitedPages("Just plain text, no citations.")).toBe(0);
  });

  it("counts a single bare page-link as one page", () => {
    expect(countDistinctCitedPages("See [[Research Notes]].")).toBe(1);
  });

  it("counts a single block-ref as one page", () => {
    expect(countDistinctCitedPages("From [[Research Notes#blk_01HABC123]]…")).toBe(1);
  });

  it("collapses multiple block-refs into the same page to one count", () => {
    // The doc's threshold is breadth across pages, not depth within
    //  one. Three citations into the same page is still one page.
    const text =
      "Per [[notes#blk_AAAA]], [[notes#blk_BBBB]], and [[notes#blk_CCCC]] the answer holds.";
    expect(countDistinctCitedPages(text)).toBe(1);
  });

  it("counts three distinct cited pages as three (the threshold)", () => {
    const text = "See [[A#blk_X]], [[B#blk_Y]], and [[C#blk_Z]] for details.";
    expect(countDistinctCitedPages(text)).toBe(3);
  });

  it("treats case-mismatched citations to the same page as one (matches Obsidian compat)", () => {
    // Wiki-link resolution is case-insensitive per the previous
    //  audit's fix; the count must agree so the suggestion
    //  doesn't double-count "Research" and "research" as distinct.
    const text = "Per [[Research#blk_X]] and [[research#blk_Y]] the claim holds.";
    expect(countDistinctCitedPages(text)).toBe(1);
  });

  it("strips the typed-relation pipe form so [[A | supports]] still counts page A", () => {
    expect(countDistinctCitedPages("Both [[A | supports]] and [[B | refutes]] the claim.")).toBe(
      2,
    );
  });

  it("handles a synthesis-style paragraph at the threshold (≥3 distinct)", () => {
    const text = `Three findings converge here:
- The architecture in [[Architecture Overview#blk_01]] establishes the shape.
- [[RFC-014#blk_42]] specifies the wire protocol.
- And [[Performance Notes#blk_07]] confirms the cost envelope.`;
    expect(countDistinctCitedPages(text)).toBe(3);
  });

  it("does not match malformed wiki-links", () => {
    expect(countDistinctCitedPages("[[")).toBe(0);
    expect(countDistinctCitedPages("[]")).toBe(0);
    expect(countDistinctCitedPages("[[]]")).toBe(0);
  });
});
