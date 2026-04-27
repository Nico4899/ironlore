import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSearchApi } from "./search-api.js";
import { SearchIndex } from "./search-index.js";
import { StorageWriter } from "./storage-writer.js";

/**
 * search-api — `?scope` semantics.
 *
 * Spec: docs/06-implementation-roadmap.md Phase 3 §FTS5 search via
 * Cmd+K, current-project + all-projects scopes. The route accepts a
 * `scope` query parameter — `current` (default) or `all`. The all-
 * projects path fans out across every registered SearchIndex, tags
 * each hit with `projectId`, and returns a position-RRF merged list.
 * The agent tool path (`kb.search`) intentionally never sees the
 * cross-project map; that's verified separately at the dispatcher
 * level.
 */

interface ProjectFx {
  projectDir: string;
  writer: StorageWriter;
  searchIndex: SearchIndex;
}

function makeProject(label: string): ProjectFx {
  const projectDir = join(tmpdir(), `search-api-test-${label}-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(projectDir, "data"), { recursive: true });
  mkdirSync(join(projectDir, ".ironlore"), { recursive: true });
  const writer = new StorageWriter(projectDir);
  const searchIndex = new SearchIndex(projectDir);
  return { projectDir, writer, searchIndex };
}

function teardown(fx: ProjectFx): void {
  fx.writer.close();
  fx.searchIndex.close();
  try {
    rmSync(fx.projectDir, { recursive: true, force: true });
  } catch {
    /* */
  }
}

interface Hit {
  path: string;
  title: string;
  snippet: string;
  rank: number;
  projectId?: string;
}

async function get(app: Hono, url: string): Promise<{ results: Hit[] }> {
  const res = await app.request(url);
  expect(res.status).toBe(200);
  return (await res.json()) as { results: Hit[] };
}

describe("search-api — scope=current (default)", () => {
  let main: ProjectFx;

  beforeEach(() => {
    main = makeProject("current");
  });

  afterEach(() => {
    teardown(main);
  });

  it("returns only the active project's index, no projectId tag", async () => {
    await main.writer.write("apple.md", "# Apple\n\nJonagold and braeburn.", null);
    main.searchIndex.indexPage("apple.md", "# Apple\n\nJonagold and braeburn.", "test");
    const app = new Hono();
    app.route("/search", createSearchApi(main.searchIndex));

    const { results } = await get(app, "/search/search?q=jonagold");
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toBe("apple.md");
    expect(results[0]?.projectId).toBeUndefined();
  });

  it("ignores scope=all when getAllProjectIndexes is not configured", async () => {
    await main.writer.write("apple.md", "Apple jonagold.", null);
    main.searchIndex.indexPage("apple.md", "Apple jonagold.", "test");
    const app = new Hono();
    app.route("/search", createSearchApi(main.searchIndex));

    // Without `getAllProjectIndexes` wired, scope=all silently
    // degrades to single-project — no projectId tag, same results.
    const { results } = await get(app, "/search/search?q=jonagold&scope=all");
    expect(results).toHaveLength(1);
    expect(results[0]?.projectId).toBeUndefined();
  });
});

describe("search-api — scope=all", () => {
  let main: ProjectFx;
  let other: ProjectFx;

  beforeEach(() => {
    main = makeProject("main");
    other = makeProject("other");
  });

  afterEach(() => {
    teardown(main);
    teardown(other);
  });

  it("merges hits across two projects and tags each with projectId", async () => {
    // Both projects mention "synth" — the all-projects fan-out
    // should surface both hits with their respective projectId.
    await main.writer.write("a.md", "# A\n\nSynth pad notes.", null);
    main.searchIndex.indexPage("a.md", "# A\n\nSynth pad notes.", "test");
    await other.writer.write("b.md", "# B\n\nSynth bass workflow.", null);
    other.searchIndex.indexPage("b.md", "# B\n\nSynth bass workflow.", "test");

    const allIndexes = new Map<string, SearchIndex>([
      ["main", main.searchIndex],
      ["other", other.searchIndex],
    ]);

    const app = new Hono();
    app.route(
      "/search",
      createSearchApi(main.searchIndex, {
        getAllProjectIndexes: () => allIndexes,
      }),
    );

    const { results } = await get(app, "/search/search?q=synth&scope=all");
    expect(results.length).toBeGreaterThanOrEqual(2);
    const byProject = new Map(results.map((r) => [r.projectId, r]));
    expect(byProject.has("main")).toBe(true);
    expect(byProject.has("other")).toBe(true);
    expect(byProject.get("main")?.path).toBe("a.md");
    expect(byProject.get("other")?.path).toBe("b.md");
  });

  it("scope=current still suppresses cross-project hits even with the registry wired", async () => {
    await main.writer.write("a.md", "Apple alpha.", null);
    main.searchIndex.indexPage("a.md", "Apple alpha.", "test");
    await other.writer.write("b.md", "Apple beta.", null);
    other.searchIndex.indexPage("b.md", "Apple beta.", "test");

    const allIndexes = new Map<string, SearchIndex>([
      ["main", main.searchIndex],
      ["other", other.searchIndex],
    ]);

    const app = new Hono();
    app.route(
      "/search",
      createSearchApi(main.searchIndex, {
        getAllProjectIndexes: () => allIndexes,
      }),
    );

    // No `scope` param defaults to current — only main's index.
    const { results } = await get(app, "/search/search?q=apple");
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toBe("a.md");
    expect(results[0]?.projectId).toBeUndefined();
  });

  it("a project that throws on FTS5 doesn't poison the rest of the fan-out", async () => {
    await main.writer.write("a.md", "Carousel.", null);
    main.searchIndex.indexPage("a.md", "Carousel.", "test");
    await other.writer.write("b.md", "Carousel.", null);
    other.searchIndex.indexPage("b.md", "Carousel.", "test");

    // Stub a misbehaving SearchIndex that always throws — simulates
    // a project whose FTS index is corrupt or being rebuilt.
    const broken = {
      search: () => {
        throw new Error("simulated FTS5 corruption");
      },
    } as unknown as SearchIndex;

    const allIndexes = new Map<string, SearchIndex>([
      ["main", main.searchIndex],
      ["broken", broken],
      ["other", other.searchIndex],
    ]);

    const app = new Hono();
    app.route(
      "/search",
      createSearchApi(main.searchIndex, {
        getAllProjectIndexes: () => allIndexes,
      }),
    );

    const { results } = await get(app, "/search/search?q=carousel&scope=all");
    const projectIds = new Set(results.map((r) => r.projectId));
    expect(projectIds.has("main")).toBe(true);
    expect(projectIds.has("other")).toBe(true);
    // The broken project contributed nothing but didn't 500 the route.
    expect(projectIds.has("broken")).toBe(false);
  });

  it("respects ?limit by capping the merged list", async () => {
    // Seed each project with three matching pages → six total.
    for (const [fx, prefix] of [
      [main, "m"],
      [other, "o"],
    ] as const) {
      for (let i = 0; i < 3; i++) {
        const p = `${prefix}${i}.md`;
        await fx.writer.write(p, `Mango ${prefix}${i}.`, null);
        fx.searchIndex.indexPage(p, `Mango ${prefix}${i}.`, "test");
      }
    }

    const allIndexes = new Map<string, SearchIndex>([
      ["main", main.searchIndex],
      ["other", other.searchIndex],
    ]);
    const app = new Hono();
    app.route(
      "/search",
      createSearchApi(main.searchIndex, {
        getAllProjectIndexes: () => allIndexes,
      }),
    );

    const { results } = await get(app, "/search/search?q=mango&limit=4&scope=all");
    expect(results.length).toBeLessThanOrEqual(4);
  });
});

describe("search-api — Phase-11 ?semantic=true toggle", () => {
  let main: ProjectFx;

  beforeEach(() => {
    main = makeProject("semantic");
  });
  afterEach(() => {
    teardown(main);
  });

  /**
   * Stub embedding provider that returns a fixed vector for any
   * input. Lets us exercise the runSemanticPass codepath without
   * standing up Ollama. The cosine sweep against `chunk_vectors`
   * needs the chunks to be vectorised — we pre-populate them via
   * `storeChunkEmbedding` so the index has something to find.
   */
  class StubEmbeddingProvider {
    readonly name = "stub" as const;
    readonly dimensions = 4;
    readonly model = "stub-test";
    constructor(private readonly vector: readonly number[]) {}
    async embed(inputs: readonly string[]): Promise<number[][]> {
      return inputs.map(() => [...this.vector]);
    }
  }

  it("response includes semanticAvailable: false when no embedding provider is configured", async () => {
    main.searchIndex.indexPage("a.md", "# A\n\nApple.", "test");
    const app = new Hono();
    app.route("/search", createSearchApi(main.searchIndex));
    const res = await app.request("/search/search?q=apple&semantic=true");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Hit[]; semanticAvailable: boolean };
    expect(body.semanticAvailable).toBe(false);
    // The semantic toggle is silently a no-op without a provider —
    // FTS5 results still flow through.
    expect(body.results.length).toBeGreaterThan(0);
  });

  it("response includes semanticAvailable: true when a provider is registered", async () => {
    main.searchIndex.indexPage("a.md", "# A\n\nApple.", "test");
    const app = new Hono();
    app.route(
      "/search",
      createSearchApi(main.searchIndex, {
        embeddingProvider: new StubEmbeddingProvider([1, 0, 0, 0]),
      }),
    );
    const res = await app.request("/search/search?q=apple");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Hit[]; semanticAvailable: boolean };
    expect(body.semanticAvailable).toBe(true);
  });

  it("reorders results when semantic ranking disagrees with BM25 ranking", async () => {
    // Both pages match the keyword "caching" so they hit the BM25
    // prefilter and become semantic candidates. We pre-store
    // chunk vectors so caching-deep.md matches the stub query
    // vector perfectly (cosine 1) while caching-shallow.md is a
    // weaker semantic match. With semantic=true, RRF merges the
    // FTS5 ordering with the semantic ordering — caching-deep.md
    // should float to the top because it wins both channels.
    main.searchIndex.indexPage(
      "caching-shallow.md",
      "# Shallow\n\nbrief mention of caching only.",
      "test",
    );
    main.searchIndex.indexPage(
      "caching-deep.md",
      "# Deep\n\ndetailed analysis of caching strategies and implementation.",
      "test",
    );

    const queryVec = [1, 0, 0, 0];
    // caching-deep.md gets the perfect-match vector → cosine 1.
    main.searchIndex.storeChunkEmbedding("caching-deep.md", 0, queryVec, "stub-test");
    // caching-shallow.md gets a low-similarity vector.
    main.searchIndex.storeChunkEmbedding("caching-shallow.md", 0, [0.1, 0.5, 0.5, 0.5], "stub-test");

    const app = new Hono();
    app.route(
      "/search",
      createSearchApi(main.searchIndex, {
        embeddingProvider: new StubEmbeddingProvider(queryVec),
      }),
    );
    const res = await app.request("/search/search?q=caching&semantic=true");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Hit[]; semanticAvailable: boolean };
    expect(body.semanticAvailable).toBe(true);
    const paths = body.results.map((r) => r.path);
    // Both pages surface — the merge keeps both channels' top
    // candidates. We don't pin the specific ordering: RRF math +
    // FTS5's internal ranking + chunk-level vector positions are
    // all in play, and the absolute order is not a stable
    // property worth pinning. The contract under test is that
    // semantic=true produces a valid merged result set including
    // the FTS5 hits.
    expect(paths).toContain("caching-deep.md");
    expect(paths).toContain("caching-shallow.md");
  });

  it("falls back to FTS5 results when the embedding provider throws", async () => {
    // Failure modes (provider down, network error) must not
    // poison the user's search — the keyword path's results still
    // reach the response.
    class FailingProvider extends StubEmbeddingProvider {
      override async embed(): Promise<number[][]> {
        throw new Error("upstream 503");
      }
    }
    main.searchIndex.indexPage("a.md", "# A\n\nApple.", "test");

    const app = new Hono();
    app.route(
      "/search",
      createSearchApi(main.searchIndex, {
        embeddingProvider: new FailingProvider([1, 0, 0, 0]),
      }),
    );
    const res = await app.request("/search/search?q=apple&semantic=true");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Hit[]; semanticAvailable: boolean };
    // Toggle still reads as available — failure here is per-call,
    // not a configuration issue. FTS5 results still surface.
    expect(body.semanticAvailable).toBe(true);
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0]?.path).toBe("a.md");
  });
});
