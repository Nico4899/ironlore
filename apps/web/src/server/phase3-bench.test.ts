import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateLargeKb } from "@ironlore/core/fixtures/generate-large-kb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SearchIndex } from "./search-index.js";

/**
 * Phase 3 exit criteria benchmark: a 5000-page fixture must load the
 * sidebar in <100ms and search in <50ms cold.
 *
 * "Sidebar load" here is proxied by `searchIndex.getTree()` — the single
 * server call the real sidebar makes on mount. "Cold search" is the first
 * FTS5 query against a freshly opened database handle. Wall-clock budgets
 * are intentionally generous in the assertions below (we multiply by 4x
 * to absorb laptop thermals and CI variance); the real signal is that
 * results land in the same order of magnitude as the spec.
 */

const PAGE_COUNT = 5000;
const SIDEBAR_BUDGET_MS = 400; // spec: 100ms, with 4x slack for CI
const SEARCH_BUDGET_MS = 200; // spec: 50ms, with 4x slack for CI

describe("Phase 3 exit criteria: 5000-page sidebar + search benchmark", () => {
  let projectDir: string;
  let dataRoot: string;

  beforeAll(async () => {
    projectDir = join(tmpdir(), `ironlore-bench-${randomBytes(4).toString("hex")}`);
    dataRoot = join(projectDir, "data");
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(join(projectDir, ".ironlore"), { recursive: true });

    const { written } = generateLargeKb({ count: PAGE_COUNT, dataRoot });
    expect(written).toBe(PAGE_COUNT);

    // Warm reindex — populates the pages table + FTS5 index once.
    const warmIndex = new SearchIndex(projectDir);
    const { indexed } = await warmIndex.reindexAll(dataRoot);
    expect(indexed).toBe(PAGE_COUNT);
    warmIndex.close();
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it(`getTree() returns all ${PAGE_COUNT} pages under ${SIDEBAR_BUDGET_MS}ms`, () => {
    // Fresh handle = cold read path (the scenario real users hit on app open)
    const index = new SearchIndex(projectDir);
    try {
      const start = performance.now();
      const tree = index.getTree();
      const elapsed = performance.now() - start;

      // PAGE_COUNT files + the synthesized folder entries
      expect(tree.length).toBeGreaterThanOrEqual(PAGE_COUNT);
      expect(elapsed).toBeLessThan(SIDEBAR_BUDGET_MS);
    } finally {
      index.close();
    }
  });

  it(`cold FTS5 search returns results under ${SEARCH_BUDGET_MS}ms`, () => {
    const index = new SearchIndex(projectDir);
    try {
      const start = performance.now();
      const results = index.search("consectetur");
      const elapsed = performance.now() - start;

      expect(results.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(SEARCH_BUDGET_MS);
    } finally {
      index.close();
    }
  });
});
