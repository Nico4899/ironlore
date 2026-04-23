import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SearchIndex } from "./search-index.js";

/**
 * `SearchIndex` Phase-11 hybrid-retrieval storage + query path.
 * Exercises the `chunk_vectors` table round-trip, cosine ordering,
 * BM25-prefilter candidate filtering, and cross-dimensionality safety.
 *
 * Uses synthetic low-dimensional embeddings (4-dim) so assertions stay
 * readable; the production provider returns 1536-dim vectors but the
 * math is identical.
 */

function makeTmpProject(): string {
  const dir = join(tmpdir(), `vec-search-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, ".ironlore"), { recursive: true });
  return dir;
}

/**
 * Index a page so it has at least one chunk, then stamp a known
 * embedding at chunk 0. Returns the path so the test can reference it
 * in prefilter lists.
 */
function indexWithEmbedding(
  index: SearchIndex,
  path: string,
  content: string,
  embedding: number[],
  model = "test-4d",
): string {
  index.indexPage(path, content, "user");
  index.storeChunkEmbedding(path, 0, embedding, model);
  return path;
}

describe("SearchIndex.vectorSearch (Phase-11 hybrid retrieval)", () => {
  const indexes: SearchIndex[] = [];

  function createIndex(): SearchIndex {
    const projectDir = makeTmpProject();
    const index = new SearchIndex(projectDir);
    indexes.push(index);
    return index;
  }

  afterEach(() => {
    for (const idx of indexes) idx.close();
    indexes.length = 0;
  });

  it("round-trips a stored embedding through the chunk_vectors table", () => {
    const index = createIndex();
    indexWithEmbedding(index, "notes/a.md", "# A\n\nparagraph", [1, 0, 0, 0]);

    // A query identical to the stored vector gives cosine = 1.
    const hits = index.vectorSearch([1, 0, 0, 0], ["notes/a.md"], 1);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe("notes/a.md");
    expect(hits[0]?.score).toBeCloseTo(1, 5);
  });

  it("returns an empty array when candidatePaths is empty", () => {
    const index = createIndex();
    indexWithEmbedding(index, "notes/a.md", "# A", [1, 0, 0, 0]);
    expect(index.vectorSearch([1, 0, 0, 0], [], 5)).toEqual([]);
  });

  it("returns an empty array when the query embedding is empty", () => {
    const index = createIndex();
    indexWithEmbedding(index, "notes/a.md", "# A", [1, 0, 0, 0]);
    expect(index.vectorSearch([], ["notes/a.md"], 5)).toEqual([]);
  });

  it("ranks chunks by cosine similarity descending", () => {
    const index = createIndex();
    // Three chunks, each pointing in a different direction relative to
    // the query [1,0,0,0]. Expected cosine order: near > medium > far.
    indexWithEmbedding(index, "near.md", "# Near", [1, 0.1, 0, 0]);
    indexWithEmbedding(index, "medium.md", "# Medium", [0.5, 0.5, 0, 0]);
    indexWithEmbedding(index, "far.md", "# Far", [0, 1, 0, 0]);

    const hits = index.vectorSearch(
      [1, 0, 0, 0],
      ["near.md", "medium.md", "far.md"],
      3,
    );
    expect(hits.map((h) => h.path)).toEqual(["near.md", "medium.md", "far.md"]);
    // Scores strictly decreasing — the BM25 re-rank blend depends on it.
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]?.score).toBeGreaterThan(hits[i]?.score ?? 0);
    }
  });

  it("respects topK and caps the returned rows", () => {
    const index = createIndex();
    indexWithEmbedding(index, "a.md", "a", [1, 0, 0, 0]);
    indexWithEmbedding(index, "b.md", "b", [0.9, 0.1, 0, 0]);
    indexWithEmbedding(index, "c.md", "c", [0.8, 0.2, 0, 0]);

    const hits = index.vectorSearch([1, 0, 0, 0], ["a.md", "b.md", "c.md"], 2);
    expect(hits).toHaveLength(2);
  });

  it("restricts to the BM25-prefilter's candidate list", () => {
    const index = createIndex();
    indexWithEmbedding(index, "excluded.md", "x", [1, 0, 0, 0]);
    indexWithEmbedding(index, "included.md", "i", [0.5, 0.5, 0, 0]);

    // Even though "excluded.md" is a perfect match, it isn't in the
    // candidate list — the prefilter's job is to cap the working set.
    const hits = index.vectorSearch([1, 0, 0, 0], ["included.md"], 5);
    expect(hits.map((h) => h.path)).toEqual(["included.md"]);
  });

  it("skips chunks whose stored dims disagree with the query", () => {
    const index = createIndex();
    // Two different dimensionalities in the same table (simulates a
    // mid-backfill provider swap). The 3-dim chunk must not be compared
    // against a 4-dim query.
    indexWithEmbedding(index, "match.md", "m", [1, 0, 0, 0], "model-4d");
    index.indexPage("mismatch.md", "# Mismatch", "user");
    index.storeChunkEmbedding("mismatch.md", 0, [1, 0, 0], "model-3d");

    const hits = index.vectorSearch(
      [1, 0, 0, 0],
      ["match.md", "mismatch.md"],
      5,
    );
    expect(hits.map((h) => h.path)).toEqual(["match.md"]);
  });

  it("upserts: re-embedding a chunk overwrites its prior vector", () => {
    const index = createIndex();
    indexWithEmbedding(index, "a.md", "a", [1, 0, 0, 0]);
    // Re-embed with a wildly different vector.
    index.storeChunkEmbedding("a.md", 0, [0, 1, 0, 0], "test-4d");

    const stillMatchesOld = index.vectorSearch([1, 0, 0, 0], ["a.md"], 1);
    expect(stillMatchesOld[0]?.score).toBeCloseTo(0, 5);
    const matchesNew = index.vectorSearch([0, 1, 0, 0], ["a.md"], 1);
    expect(matchesNew[0]?.score).toBeCloseTo(1, 5);
  });

  it("cascades embeddings on removePage", () => {
    const index = createIndex();
    indexWithEmbedding(index, "a.md", "a", [1, 0, 0, 0]);
    expect(index.vectorSearch([1, 0, 0, 0], ["a.md"], 1)).toHaveLength(1);

    index.removePage("a.md");
    expect(index.vectorSearch([1, 0, 0, 0], ["a.md"], 1)).toEqual([]);
  });

  it("re-indexing a page drops its stale embeddings", () => {
    const index = createIndex();
    indexWithEmbedding(index, "a.md", "# A\n\nold content", [1, 0, 0, 0]);
    // Rewriting the page invalidates chunk boundaries → embeddings
    // must be cleared even though content still exists.
    index.indexPage("a.md", "# A\n\nnew content entirely", "user");

    expect(index.vectorSearch([1, 0, 0, 0], ["a.md"], 1)).toEqual([]);
  });

  it("reports pending embedding counts and enumerates missing chunks", () => {
    const index = createIndex();
    index.indexPage("a.md", "# A\n\nparagraph", "user");
    index.indexPage("b.md", "# B\n\nparagraph", "user");
    expect(index.countChunksMissingEmbeddings()).toBe(2);

    index.storeChunkEmbedding("a.md", 0, [1, 0, 0, 0], "test-4d");
    expect(index.countChunksMissingEmbeddings()).toBe(1);

    const missing = index.getChunksMissingEmbeddings(10);
    expect(missing.map((m) => m.path)).toEqual(["b.md"]);
    expect(missing[0]?.content).toBeTruthy();
  });

  it("returns empty when no chunk has been embedded yet", () => {
    const index = createIndex();
    index.indexPage("a.md", "# A\n\nparagraph", "user");
    // Chunks exist in pages_chunks_fts but nothing in chunk_vectors.
    expect(index.vectorSearch([1, 0, 0, 0], ["a.md"], 5)).toEqual([]);
  });

  it("carries block-ID citations through to the result rows", () => {
    const index = createIndex();
    // Content with an explicit block ID so parseBlocks produces a
    // non-null block_id_start on the chunk.
    const content = "# Overview\n\nParagraph one. <!-- #blk_01TEST -->";
    indexWithEmbedding(index, "w.md", content, [1, 0, 0, 0]);

    const hits = index.vectorSearch([1, 0, 0, 0], ["w.md"], 1);
    expect(hits[0]?.blockIdStart).toBeTruthy();
  });
});
