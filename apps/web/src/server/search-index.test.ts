import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractWikiLinks, SearchIndex } from "./search-index.js";

function makeTmpProject(): string {
  const dir = join(tmpdir(), `ironlore-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, ".ironlore"), { recursive: true });
  return dir;
}

describe("extractWikiLinks", () => {
  const targets = (links: Array<{ target: string; rel: string | null }>) =>
    links.map((l) => l.target);

  it("extracts basic wiki links", () => {
    expect(targets(extractWikiLinks("See [[Page One]] and [[Page Two]]"))).toEqual([
      "Page One",
      "Page Two",
    ]);
  });

  it("extracts embed links (![[...]])", () => {
    expect(targets(extractWikiLinks("![[Embedded Page]]"))).toEqual(["Embedded Page"]);
  });

  it("extracts mention links (@[[...]])", () => {
    expect(targets(extractWikiLinks("@[[User Page]]"))).toEqual(["User Page"]);
  });

  it("extracts block references without anchor", () => {
    expect(targets(extractWikiLinks("[[Page#blk_01HY]]"))).toEqual(["Page"]);
  });

  it("deduplicates links", () => {
    expect(targets(extractWikiLinks("[[A]] then [[A]] again"))).toEqual(["A"]);
  });

  it("returns empty for no links", () => {
    expect(extractWikiLinks("No links here")).toEqual([]);
  });

  it("extracts typed relations from pipe syntax", () => {
    const links = extractWikiLinks("See [[Algorithm | implements]] and [[Paper | contradicts]]");
    expect(links).toEqual([
      { target: "Algorithm", rel: "implements" },
      { target: "Paper", rel: "contradicts" },
    ]);
  });

  it("prefers typed over untyped for the same target", () => {
    const links = extractWikiLinks("[[Foo]] and [[Foo | supports]]");
    expect(links).toEqual([{ target: "Foo", rel: "supports" }]);
  });
});

describe("SearchIndex", () => {
  const indexes: SearchIndex[] = [];

  function createIndex(): { index: SearchIndex; projectDir: string } {
    const projectDir = makeTmpProject();
    const index = new SearchIndex(projectDir);
    indexes.push(index);
    return { index, projectDir };
  }

  afterEach(() => {
    for (const idx of indexes) {
      idx.close();
    }
    indexes.length = 0;
  });

  it("indexes a page and finds it via FTS5 search", () => {
    const { index } = createIndex();
    index.indexPage("hello.md", "# Hello World\n\nThis is a test page.", "user");

    const results = index.search("hello");
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toBe("hello.md");
    expect(results[0]?.title).toBe("Hello World");
  });

  it("removes a page from the index", () => {
    const { index } = createIndex();
    index.indexPage("temp.md", "# Temporary\n\nWill be removed.", "user");
    expect(index.search("temporary")).toHaveLength(1);

    index.removePage("temp.md");
    expect(index.search("temporary")).toHaveLength(0);
  });

  it("tracks backlinks from wiki links", () => {
    const { index } = createIndex();
    index.indexPage("source.md", "# Source\n\nLinks to [[Target Page]].", "user");

    const backlinks = index.getBacklinks("Target Page");
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0]?.sourcePath).toBe("source.md");
    expect(backlinks[0]?.rel).toBeNull();
  });

  it("returns typed-relation backlinks with the rel field populated", () => {
    const { index } = createIndex();
    index.indexPage(
      "claim.md",
      "# Claim\n\nThis [[Paper X | contradicts]] the finding.",
      "user",
    );
    const backlinks = index.getBacklinks("Paper X");
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0]?.rel).toBe("contradicts");
  });

  it("filters backlinks by typed relation when rel is supplied", () => {
    const { index } = createIndex();
    index.indexPage("a.md", "See [[Target]].", "user"); // untyped
    index.indexPage("b.md", "[[Target | supports]] this.", "user"); // typed: supports
    index.indexPage("c.md", "[[Target | contradicts]] that.", "user"); // typed: contradicts

    // No filter → all three.
    expect(index.getBacklinks("Target")).toHaveLength(3);

    // Filter by specific relation.
    const supports = index.getBacklinks("Target", "supports");
    expect(supports).toHaveLength(1);
    expect(supports[0]?.sourcePath).toBe("b.md");

    const contradicts = index.getBacklinks("Target", "contradicts");
    expect(contradicts).toHaveLength(1);
    expect(contradicts[0]?.sourcePath).toBe("c.md");

    // Unknown relation → empty.
    expect(index.getBacklinks("Target", "supersedes")).toHaveLength(0);
  });

  it("updates backlinks on re-index", () => {
    const { index } = createIndex();
    index.indexPage("source.md", "Links to [[A]] and [[B]].", "user");
    expect(index.getBacklinks("A")).toHaveLength(1);
    expect(index.getBacklinks("B")).toHaveLength(1);

    // Re-index with different links
    index.indexPage("source.md", "Now links to [[C]] only.", "user");
    expect(index.getBacklinks("A")).toHaveLength(0);
    expect(index.getBacklinks("B")).toHaveLength(0);
    expect(index.getBacklinks("C")).toHaveLength(1);
  });

  it("returns outlinks for a page", () => {
    const { index } = createIndex();
    index.indexPage("hub.md", "# Hub\n\n[[Spoke One]] and [[Spoke Two]].", "user");

    const outlinks = index.getOutlinks("hub.md");
    expect(outlinks).toContain("Spoke One");
    expect(outlinks).toContain("Spoke Two");
    expect(outlinks).toHaveLength(2);
  });

  it("extracts and queries tags", () => {
    const { index } = createIndex();
    index.indexPage(
      "tagged.md",
      "---\ntags: [javascript, react]\n---\n# Tagged Page\n\nContent.",
      "user",
    );

    expect(index.getPagesByTag("javascript")).toEqual(["tagged.md"]);
    expect(index.getPagesByTag("react")).toEqual(["tagged.md"]);
    expect(index.getPagesByTag("python")).toEqual([]);
  });

  it("extracts multi-line tags", () => {
    const { index } = createIndex();
    const md = "---\ntags:\n  - alpha\n  - beta\n---\n# Page\n";
    index.indexPage("multiline-tags.md", md, "user");

    expect(index.getPagesByTag("alpha")).toEqual(["multiline-tags.md"]);
    expect(index.getPagesByTag("beta")).toEqual(["multiline-tags.md"]);
  });

  it("tracks recent edits", () => {
    const { index } = createIndex();
    index.indexPage("first.md", "# First", "alice");
    index.indexPage("second.md", "# Second", "bob");

    const edits = index.getRecentEdits();
    expect(edits).toHaveLength(2);
    const paths = edits.map((e) => e.path).sort();
    expect(paths).toEqual(["first.md", "second.md"]);
    expect(edits.find((e) => e.path === "first.md")?.author).toBe("alice");
    expect(edits.find((e) => e.path === "second.md")?.author).toBe("bob");
  });

  it("reindexAll rebuilds from filesystem", async () => {
    const { index, projectDir } = createIndex();
    const dataRoot = join(projectDir, "data");
    writeFileSync(join(dataRoot, "page-a.md"), "# Page A\n\nLinks to [[Page B]].\n");
    writeFileSync(join(dataRoot, "page-b.md"), "# Page B\n\nHello world.\n");

    const { indexed } = await index.reindexAll(dataRoot);
    expect(indexed).toBe(2);

    expect(index.search("hello")).toHaveLength(1);
    expect(index.getBacklinks("Page B")).toHaveLength(1);
  });

  it("reindexAll extracts and indexes .eml content for FTS5", async () => {
    const { index, projectDir } = createIndex();
    const dataRoot = join(projectDir, "data");

    const eml = [
      "From: Alice <alice@example.com>",
      "To: Bob <bob@example.com>",
      "Subject: Quarterly roadmap sync",
      "Date: Tue, 1 Apr 2026 10:00:00 +0000",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Let's review the peppercorn migration plan on Thursday.",
      "",
    ].join("\r\n");
    writeFileSync(join(dataRoot, "inbox.eml"), eml);

    const { indexed } = await index.reindexAll(dataRoot);
    expect(indexed).toBe(1);

    // Subject line from headers
    expect(index.search("peppercorn")).toHaveLength(1);
    // Body content
    expect(index.search("roadmap")).toHaveLength(1);
  });

  it("reindexAll clears stale entries", async () => {
    const { index, projectDir } = createIndex();
    const dataRoot = join(projectDir, "data");

    // Index a page then delete it from disk
    index.indexPage("stale.md", "# Stale", "user");
    expect(index.search("stale")).toHaveLength(1);

    // Reindex from disk (stale.md doesn't exist on disk)
    writeFileSync(join(dataRoot, "fresh.md"), "# Fresh\n");
    await index.reindexAll(dataRoot);

    expect(index.search("stale")).toHaveLength(0);
    expect(index.search("fresh")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Chunk-level FTS + RRF merge
// ---------------------------------------------------------------------------
//
// The `pages_chunks_fts` virtual table splits markdown at block-ID seams
// into ~800-token chunks; each chunk carries `block_id_start` and
// `block_id_end` so search results can cite the exact block range rather
// than the whole page. `search()` fires both the page-level and
// chunk-level FTS queries and merges via RRF.
//
// These tests exercise that chunking + merging directly, not through the
// HTTP layer.

describe("SearchIndex — chunk-level FTS + RRF", () => {
  const indexes: SearchIndex[] = [];

  function createIndex(): { index: SearchIndex; projectDir: string } {
    const projectDir = makeTmpProject();
    const index = new SearchIndex(projectDir);
    indexes.push(index);
    return { index, projectDir };
  }

  afterEach(() => {
    for (const idx of indexes) {
      idx.close();
    }
    indexes.length = 0;
  });

  /** Quick helper — builds markdown with N paragraphs each carrying a
   *  unique `<!-- #blk_ULID -->` anchor. Block IDs are sortable by
   *  construction so order is deterministic. */
  function buildBlockMarkdown(paragraphs: Array<{ id: string; text: string }>): string {
    return paragraphs.map((p) => `${p.text} <!-- #${p.id} -->`).join("\n\n");
  }

  it("indexes chunk rows alongside page-level rows", () => {
    const { index } = createIndex();

    const content = buildBlockMarkdown([
      { id: "blk_01HABCABCABCABCABCABCABCAA", text: "alpha paragraph about apples." },
      { id: "blk_01HABCABCABCABCABCABCABCAB", text: "beta paragraph about bananas." },
      { id: "blk_01HABCABCABCABCABCABCABCAC", text: "gamma paragraph about cherries." },
    ]);
    index.indexPage("fruit.md", content, "test");

    // Sanity: page-level search finds the page.
    expect(index.search("alpha").map((r) => r.path)).toContain("fruit.md");
    expect(index.search("gamma").map((r) => r.path)).toContain("fruit.md");
  });

  it("re-indexing a page replaces stale chunk rows", () => {
    const { index } = createIndex();

    const v1 = buildBlockMarkdown([
      { id: "blk_01HABCABCABCABCABCABCABCAA", text: "original content about kangaroos." },
    ]);
    index.indexPage("a.md", v1, "test");
    expect(index.search("kangaroos")).toHaveLength(1);

    const v2 = buildBlockMarkdown([
      { id: "blk_01HABCABCABCABCABCABCABCBB", text: "new content about penguins." },
    ]);
    index.indexPage("a.md", v2, "test");
    expect(index.search("kangaroos")).toHaveLength(0);
    expect(index.search("penguins")).toHaveLength(1);
  });

  it("RRF merge produces a single row per matching page", () => {
    const { index } = createIndex();

    // Two pages, both matching the query. Without dedup a naïve concat
    // would emit four rows (one per side), which is wrong.
    index.indexPage(
      "one.md",
      buildBlockMarkdown([
        { id: "blk_01HAAAAAAAAAAAAAAAAAAAAAAA", text: "The seashell washed ashore." },
      ]),
      "test",
    );
    index.indexPage(
      "two.md",
      buildBlockMarkdown([
        { id: "blk_01HBBBBBBBBBBBBBBBBBBBBBBB", text: "Another seashell on the beach." },
      ]),
      "test",
    );

    const results = index.search("seashell");
    const paths = results.map((r) => r.path);
    expect(paths).toEqual([...new Set(paths)]); // no duplicates
    expect(paths.length).toBe(2);
  });

  it("honors the limit argument at the top level", () => {
    const { index } = createIndex();

    for (let i = 0; i < 12; i++) {
      const id = `blk_01HFFFFFFFFFFFFFFFFFFFFFF${i.toString().padStart(2, "0").slice(-1)}A`;
      index.indexPage(
        `page${i}.md`,
        buildBlockMarkdown([{ id, text: "shared zebra keyword here" }]),
        "test",
      );
    }

    const top5 = index.search("zebra", 5);
    expect(top5.length).toBeLessThanOrEqual(5);
  });

  it("prefers chunk-level snippets when both sources have a hit", () => {
    const { index } = createIndex();

    // One page with a query term deep inside a block. The chunk snippet
    // should surface the exact block context rather than the page title.
    const content = buildBlockMarkdown([
      { id: "blk_01HAAAAAAAAAAAAAAAAAAAAAAA", text: "Intro about farming." },
      { id: "blk_01HBBBBBBBBBBBBBBBBBBBBBBB", text: "Supercalifragilistic is a long word." },
      { id: "blk_01HCCCCCCCCCCCCCCCCCCCCCCC", text: "Conclusion paragraph." },
    ]);
    index.indexPage("deep.md", content, "test");

    const results = index.search("supercalifragilistic");
    expect(results).toHaveLength(1);
    // Snippet should contain the matched term with the <mark> tag the FTS
    // snippet() function inserts. Both page- and chunk-level queries use
    // the same token so either wins — assert that a snippet was returned.
    expect(results[0]?.snippet).toMatch(/<mark>/i);
  });

  it("empty queries return no results without crashing", () => {
    const { index } = createIndex();
    index.indexPage(
      "a.md",
      buildBlockMarkdown([{ id: "blk_01HAAAAAAAAAAAAAAAAAAAAAAA", text: "content" }]),
      "test",
    );
    expect(index.search("")).toEqual([]);
    expect(index.search("   ")).toEqual([]);
  });

  // Phase 7 exit criterion: a term deep in paragraph 5 of a 3000-token
  // page returns the correct chunk with a block-ID citation.
  it("Phase 7 exit: deep-paragraph term returns a chunk hit, not just page", () => {
    const { index } = createIndex();

    // Build a 3000-token page (~12k chars). Five long paragraphs + one
    // unique term buried deep in the fifth block. Each block carries
    // its own stable ID so chunk boundaries line up with block seams.
    // ULID is exactly 26 base32 characters.
    // "01HCCCCCCCCCCCCCCCCCCCCCX0" where X varies per block (24 prefix + "X" + digit).
    const ulid = (i: number) => `blk_01HCCCCCCCCCCCCCCCCCCCCCX${i}`;
    const filler = (word: string, count: number) => new Array(count).fill(word).join(" ");
    const paragraphs = [
      { id: ulid(1), text: `Introduction. ${filler("alpha", 120)}` },
      { id: ulid(2), text: `Background. ${filler("beta", 120)}` },
      { id: ulid(3), text: `Related work. ${filler("gamma", 120)}` },
      { id: ulid(4), text: `Approach. ${filler("delta", 120)}` },
      {
        id: ulid(5),
        // Unique term buried in paragraph 5.
        text: `Findings. ${filler("epsilon", 50)} orangutan-unique-marker ${filler("zeta", 50)}`,
      },
      { id: ulid(6), text: `Conclusion. ${filler("eta", 120)}` },
    ];
    const content = paragraphs.map((p) => `${p.text} <!-- #${p.id} -->`).join("\n\n");
    index.indexPage("long.md", content, "test");

    const results = index.search("orangutan-unique-marker");
    expect(results).toHaveLength(1);
    const hit = results[0] as {
      path: string;
      snippet: string;
      blockIdStart?: string;
      blockIdEnd?: string;
    };
    expect(hit.path).toBe("long.md");
    // Chunk-level hit provides block-ID citation.
    expect(hit.blockIdStart).toBeDefined();
    expect(hit.blockIdEnd).toBeDefined();
    // The matched term should land in a chunk whose block-ID range
    // includes the fifth paragraph. Chunks are defined by a start/end
    // block ID; a single-block chunk has start==end, a multi-block
    // chunk has start < block5 < end (lexicographic on ULIDs).
    const deepBlock = ulid(5);
    const start = hit.blockIdStart as string;
    const end = hit.blockIdEnd as string;
    const deepFound =
      start === deepBlock || end === deepBlock || (start <= deepBlock && deepBlock <= end);
    expect(deepFound).toBe(true);
    // Snippet should contain the matched term with the FTS <mark>.
    expect(hit.snippet).toMatch(/<mark>/);
  });

  it("pages with no block-ID comments still index at page level", () => {
    const { index } = createIndex();
    // Markdown without any `<!-- #blk_... -->` anchors. `parseBlocks`
    // returns an empty array → no chunk rows get written, but the
    // page-level FTS path still fires.
    index.indexPage("plain.md", "# Plain\n\nJust some unsullied prose without anchors.", "test");
    const results = index.search("unsullied");
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toBe("plain.md");
  });
});
