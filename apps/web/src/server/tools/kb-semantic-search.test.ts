import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "../providers/embedding-types.js";
import { SearchIndex } from "../search-index.js";
import { createKbSemanticSearch } from "./kb-semantic-search.js";
import type { ToolCallContext } from "./types.js";

/**
 * `kb.semantic_search` end-to-end with a stub embedding provider.
 * Exercises the BM25 prefilter → embed → vector search → RRF merge
 * → hydrate path in one file with zero network.
 *
 * The stub provider returns deterministic low-dim vectors keyed by
 * string — embeddings that have nothing to do with real semantics but
 * make the ordering assertions crystal-clear.
 */

function makeTmpProject(): string {
  const dir = join(tmpdir(), `semantic-search-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, ".ironlore"), { recursive: true });
  return dir;
}

const NO_CTX: ToolCallContext = {
  projectId: "main",
  agentSlug: "general",
  jobId: "test",
  emitEvent: () => undefined,
  dataRoot: "",
};

/**
 * Stub embedding provider: pre-registered (text → vector) mappings.
 * `embed()` looks each input up in the table; unknown inputs get a
 * zero vector so the test can explicitly assert "this input was
 * queried but didn't map to any page."
 */
class StubEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai" as const;
  readonly model: string;
  readonly dimensions: number;
  private vectors: Map<string, number[]>;
  embedCalls = 0;
  shouldThrow = false;

  constructor(vectors: Record<string, number[]>, dims = 4, model = "stub-4d") {
    this.vectors = new Map(Object.entries(vectors));
    this.dimensions = dims;
    this.model = model;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    this.embedCalls++;
    if (this.shouldThrow) throw new Error("simulated transport failure");
    return texts.map((t) => this.vectors.get(t) ?? new Array(this.dimensions).fill(0));
  }
}

describe("kb.semantic_search", () => {
  const indexes: SearchIndex[] = [];

  function setup(): { index: SearchIndex; projectDir: string } {
    const projectDir = makeTmpProject();
    const index = new SearchIndex(projectDir);
    indexes.push(index);
    return { index, projectDir };
  }

  afterEach(() => {
    for (const idx of indexes) idx.close();
    indexes.length = 0;
  });

  it("returns empty results for an empty query", async () => {
    const { index, projectDir } = setup();
    const tool = createKbSemanticSearch(index, new StubEmbeddingProvider({}), "main", projectDir);
    const out = JSON.parse(await tool.execute({ query: "" }, NO_CTX)) as {
      results: unknown[];
    };
    expect(out.results).toEqual([]);
  });

  it("returns empty results when no chunk matches the BM25 prefilter", async () => {
    const { index, projectDir } = setup();
    index.indexPage("note.md", "# Note\n\nHello world.", "user");

    const provider = new StubEmbeddingProvider({ banana: [1, 0, 0, 0] });
    const tool = createKbSemanticSearch(index, provider, "main", projectDir);

    const out = JSON.parse(await tool.execute({ query: "banana" }, NO_CTX)) as {
      results: unknown[];
    };
    expect(out.results).toEqual([]);
    // No candidates → should NOT have paid to embed the query.
    expect(provider.embedCalls).toBe(0);
  });

  it("ranks a vector-close page above a BM25-only page on the same query", async () => {
    const { index, projectDir } = setup();
    // Two pages both contain "coffee" so both survive BM25 prefilter.
    // Only `close.md` gets an embedding that matches the query vector.
    index.indexPage("far.md", "# Far\n\nCoffee details, far from the query.", "user");
    index.indexPage("close.md", "# Close\n\nCoffee brewing guide.", "user");
    index.storeChunkEmbedding("far.md", 0, [0, 0, 1, 0], "stub-4d");
    index.storeChunkEmbedding("close.md", 0, [1, 0, 0, 0], "stub-4d");

    const provider = new StubEmbeddingProvider({ coffee: [1, 0, 0, 0] });
    const tool = createKbSemanticSearch(index, provider, "main", projectDir);

    const out = JSON.parse(await tool.execute({ query: "coffee" }, NO_CTX)) as {
      results: Array<{ path: string }>;
    };
    expect(out.results.map((r) => r.path)).toEqual(["close.md", "far.md"]);
  });

  it("falls back to BM25 prefilter order when the embed call fails", async () => {
    const { index, projectDir } = setup();
    index.indexPage("alpha.md", "# Alpha\n\nCoffee page.", "user");
    index.indexPage("beta.md", "# Beta\n\nCoffee page.", "user");
    index.storeChunkEmbedding("alpha.md", 0, [0, 1, 0, 0], "stub-4d");
    index.storeChunkEmbedding("beta.md", 0, [1, 0, 0, 0], "stub-4d");

    const provider = new StubEmbeddingProvider({ coffee: [1, 0, 0, 0] });
    provider.shouldThrow = true;
    const tool = createKbSemanticSearch(index, provider, "main", projectDir);

    const out = JSON.parse(await tool.execute({ query: "coffee" }, NO_CTX)) as {
      results: Array<{ path: string }>;
    };
    // Embed threw — the tool must still return results (BM25 only).
    expect(out.results.length).toBeGreaterThan(0);
  });

  it("respects the `limit` parameter", async () => {
    const { index, projectDir } = setup();
    for (const slug of ["a", "b", "c", "d", "e"]) {
      index.indexPage(`${slug}.md`, `# ${slug}\n\ntopic word`, "user");
      index.storeChunkEmbedding(`${slug}.md`, 0, [1, 0, 0, 0], "stub-4d");
    }
    const provider = new StubEmbeddingProvider({ topic: [1, 0, 0, 0] });
    const tool = createKbSemanticSearch(index, provider, "main", projectDir);

    const out = JSON.parse(await tool.execute({ query: "topic", limit: 2 }, NO_CTX)) as {
      results: Array<{ path: string }>;
    };
    expect(out.results).toHaveLength(2);
  });

  it("surfaces block-ID citations on hits that came through the vector path", async () => {
    const { index, projectDir } = setup();
    const content = "# Overview\n\nCoffee details. <!-- #blk_01TEST -->";
    index.indexPage("w.md", content, "user");
    index.storeChunkEmbedding("w.md", 0, [1, 0, 0, 0], "stub-4d");

    const provider = new StubEmbeddingProvider({ coffee: [1, 0, 0, 0] });
    const tool = createKbSemanticSearch(index, provider, "main", projectDir);

    const out = JSON.parse(await tool.execute({ query: "coffee" }, NO_CTX)) as {
      results: Array<{ path: string; blockIdStart: string | null }>;
    };
    expect(out.results[0]?.blockIdStart).toBeTruthy();
  });

  it("populates title + snippet fields from the chunk FTS table", async () => {
    const { index, projectDir } = setup();
    index.indexPage("w.md", "# My Title\n\nBrewing notes for coffee.", "user");
    index.storeChunkEmbedding("w.md", 0, [1, 0, 0, 0], "stub-4d");

    const provider = new StubEmbeddingProvider({ coffee: [1, 0, 0, 0] });
    const tool = createKbSemanticSearch(index, provider, "main", projectDir);

    const out = JSON.parse(await tool.execute({ query: "coffee" }, NO_CTX)) as {
      results: Array<{ path: string; title: string; snippet: string }>;
    };
    expect(out.results[0]?.title).toBe("My Title");
    expect(out.results[0]?.snippet).toContain("coffee");
  });

  it("RRF-merges BM25 and vector ranks — a page surfaced by both tops one surfaced by only one", async () => {
    const { index, projectDir } = setup();
    // `both.md` matches the BM25 query *and* has a close vector.
    // `vectorOnly.md` also matches BM25 (same word) but vector is farther.
    index.indexPage("both.md", "# Both\n\ntopic page", "user");
    index.indexPage("vectorOnly.md", "# VectorOnly\n\ntopic page", "user");
    index.storeChunkEmbedding("both.md", 0, [1, 0, 0, 0], "stub-4d");
    index.storeChunkEmbedding("vectorOnly.md", 0, [0.2, 0.98, 0, 0], "stub-4d");

    const provider = new StubEmbeddingProvider({ topic: [1, 0, 0, 0] });
    const tool = createKbSemanticSearch(index, provider, "main", projectDir);

    const out = JSON.parse(await tool.execute({ query: "topic" }, NO_CTX)) as {
      results: Array<{ path: string }>;
    };
    // `both.md` should rank first — it gets RRF credit from both channels
    // while `vectorOnly.md` has a weaker vector score.
    expect(out.results[0]?.path).toBe("both.md");
  });
});
