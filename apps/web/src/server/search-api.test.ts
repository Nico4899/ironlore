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
