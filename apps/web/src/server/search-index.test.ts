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
  it("extracts basic wiki links", () => {
    expect(extractWikiLinks("See [[Page One]] and [[Page Two]]")).toEqual(["Page One", "Page Two"]);
  });

  it("extracts embed links (![[...]])", () => {
    expect(extractWikiLinks("![[Embedded Page]]")).toEqual(["Embedded Page"]);
  });

  it("extracts mention links (@[[...]])", () => {
    expect(extractWikiLinks("@[[User Page]]")).toEqual(["User Page"]);
  });

  it("extracts block references without anchor", () => {
    expect(extractWikiLinks("[[Page#blk_01HY]]")).toEqual(["Page"]);
  });

  it("deduplicates links", () => {
    expect(extractWikiLinks("[[A]] then [[A]] again")).toEqual(["A"]);
  });

  it("returns empty for no links", () => {
    expect(extractWikiLinks("No links here")).toEqual([]);
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

  it("reindexAll rebuilds from filesystem", () => {
    const { index, projectDir } = createIndex();
    const dataRoot = join(projectDir, "data");
    writeFileSync(join(dataRoot, "page-a.md"), "# Page A\n\nLinks to [[Page B]].\n");
    writeFileSync(join(dataRoot, "page-b.md"), "# Page B\n\nHello world.\n");

    const { indexed } = index.reindexAll(dataRoot);
    expect(indexed).toBe(2);

    expect(index.search("hello")).toHaveLength(1);
    expect(index.getBacklinks("Page B")).toHaveLength(1);
  });

  it("reindexAll clears stale entries", () => {
    const { index, projectDir } = createIndex();
    const dataRoot = join(projectDir, "data");

    // Index a page then delete it from disk
    index.indexPage("stale.md", "# Stale", "user");
    expect(index.search("stale")).toHaveLength(1);

    // Reindex from disk (stale.md doesn't exist on disk)
    writeFileSync(join(dataRoot, "fresh.md"), "# Fresh\n");
    index.reindexAll(dataRoot);

    expect(index.search("stale")).toHaveLength(0);
    expect(index.search("fresh")).toHaveLength(1);
  });
});
