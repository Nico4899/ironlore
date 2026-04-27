import { describe, expect, it } from "vitest";
import { extractSourcePaths } from "./SaveAsWikiDialog.js";

/**
 * `extractSourcePaths` — the regex that backs the
 * "Save as wiki page" affordance's `source_ids` autofill.
 *
 * Pinning the citation grammar so a future refactor of the
 * `[[Page#blk_…]]` syntax that breaks the extractor is caught.
 * The same grammar is parsed server-side by `CitationText`
 * (AIPanel.tsx) for click-through, so both surfaces stay
 * coherent if this regex stays right.
 */

describe("extractSourcePaths", () => {
  it("returns [] when the markdown has no block-ref citations", () => {
    expect(extractSourcePaths("plain text only")).toEqual([]);
    expect(extractSourcePaths("[[no-block-id]] still no")).toEqual([]);
  });

  it("pulls a single page path out of a single citation", () => {
    expect(extractSourcePaths("see [[notes/spoke#blk_01HXYZ]]")).toEqual(["notes/spoke"]);
  });

  it("dedupes repeated citations of the same page (different blocks)", () => {
    // Three citations of two different blocks on the same source
    // page should resolve to one source_id — that's how
    // wiki-page frontmatter `source_ids` arrays are meant to read.
    const md =
      "see [[notes/spoke#blk_01HABC]] and also [[notes/spoke#blk_01HDEF]] and finally [[notes/spoke#blk_01HABC]] again";
    expect(extractSourcePaths(md)).toEqual(["notes/spoke"]);
  });

  it("preserves first-occurrence order across multiple distinct sources", () => {
    // Order matters — the user's wiki page reads top-to-bottom,
    // and the source_ids array should mirror the order the agent
    // introduced them.
    const md = "first [[a/one#blk_01]] then [[b/two#blk_02]] then [[a/one#blk_03]]";
    expect(extractSourcePaths(md)).toEqual(["a/one", "b/two"]);
  });

  it("ignores inline-code-fenced citations only as far as the regex sees them", () => {
    // The regex is intentionally simple — it doesn't strip code
    // fences. Pinning this so a future "make it smart about
    // code blocks" refactor is a deliberate decision, not an
    // accident. Today: a citation inside `\`\`\`` still counts.
    const md = "```\nsee [[in/code#blk_01]]\n```";
    expect(extractSourcePaths(md)).toEqual(["in/code"]);
  });

  it("trims whitespace around the page path before deduplication", () => {
    const md = "[[ notes/spoke #blk_01]] and [[notes/spoke#blk_02]]";
    // The regex captures everything before `#` non-greedily, so
    // " notes/spoke " becomes "notes/spoke" after trim — same
    // page-id, dedupes to one entry.
    const out = extractSourcePaths(md);
    expect(out).toEqual(["notes/spoke"]);
  });

  it("skips truly-malformed block-refs without crashing", () => {
    expect(extractSourcePaths("[[#blk_01]]")).toEqual([]); // empty page
    expect(extractSourcePaths("[[]]")).toEqual([]); // empty everything
    expect(extractSourcePaths("[[no-hash]]")).toEqual([]); // no #blk_
  });
});
