import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchIndex } from "../search-index.js";
import { createKbGlobalSearch } from "./kb-global-search.js";
import type { ToolCallContext } from "./types.js";

/**
 * `kb.global_search` — Phase-11 Airlock cross-project surface.
 * Pin three behaviours: cross-project fan-out, the downgrade
 * trigger on foreign hits, and the no-downgrade case for queries
 * that only return caller-project rows.
 */

interface ProjectFx {
  projectDir: string;
  searchIndex: SearchIndex;
}

function makeProject(label: string): ProjectFx {
  const projectDir = join(tmpdir(), `kbglobal-${label}-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(projectDir, "data"), { recursive: true });
  mkdirSync(join(projectDir, ".ironlore"), { recursive: true });
  const searchIndex = new SearchIndex(projectDir);
  return { projectDir, searchIndex };
}

function teardown(fx: ProjectFx): void {
  fx.searchIndex.close();
  try {
    rmSync(fx.projectDir, { recursive: true, force: true });
  } catch {
    /* */
  }
}

const created: ProjectFx[] = [];

afterEach(() => {
  while (created.length > 0) {
    const fx = created.pop();
    if (fx) teardown(fx);
  }
});

function newProject(label: string): ProjectFx {
  const fx = makeProject(label);
  created.push(fx);
  return fx;
}

function makeCtx(opts: { downgrade: ReturnType<typeof vi.fn> }): ToolCallContext {
  return {
    projectId: "main",
    agentSlug: "general",
    jobId: "test",
    emitEvent: () => undefined,
    dataRoot: "",
    fetch: globalThis.fetch,
    downgradeEgress: opts.downgrade,
  };
}

describe("kb.global_search", () => {
  it("returns hits across every registered project, tagged with projectId", async () => {
    const main = newProject("main");
    const other = newProject("other");
    main.searchIndex.indexPage("a.md", "# A\n\nMango pad notes.\n", "test");
    other.searchIndex.indexPage("b.md", "# B\n\nMango bass workflow.\n", "test");

    const downgrade = vi.fn();
    const tool = createKbGlobalSearch({
      getAllProjectIndexes: () =>
        new Map([
          ["main", main.searchIndex],
          ["other", other.searchIndex],
        ]),
    });
    const result = JSON.parse(await tool.execute({ query: "mango" }, makeCtx({ downgrade }))) as {
      count: number;
      results: Array<{ projectId: string; path: string }>;
      crossedProjects: boolean;
    };

    expect(result.count).toBeGreaterThanOrEqual(2);
    const byProject = new Map(result.results.map((r) => [r.projectId, r]));
    expect(byProject.has("main")).toBe(true);
    expect(byProject.has("other")).toBe(true);
    expect(result.crossedProjects).toBe(true);
  });

  it("downgrades egress when a foreign-project hit is returned", async () => {
    const main = newProject("main");
    const other = newProject("other");
    other.searchIndex.indexPage("foreign.md", "# Foreign\n\ncarousel.\n", "test");

    const downgrade = vi.fn();
    const tool = createKbGlobalSearch({
      getAllProjectIndexes: () =>
        new Map([
          ["main", main.searchIndex],
          ["other", other.searchIndex],
        ]),
    });
    await tool.execute({ query: "carousel" }, makeCtx({ downgrade }));
    expect(downgrade).toHaveBeenCalledTimes(1);
    expect(String(downgrade.mock.calls[0]?.[0])).toMatch(/cross-project hits/);
  });

  it("does NOT downgrade when only caller-project hits are returned", async () => {
    const main = newProject("main");
    const other = newProject("other");
    main.searchIndex.indexPage("local.md", "# Local\n\nlocal carousel.\n", "test");
    other.searchIndex.indexPage("unrelated.md", "# Other\n\ndifferent text.\n", "test");

    const downgrade = vi.fn();
    const tool = createKbGlobalSearch({
      getAllProjectIndexes: () =>
        new Map([
          ["main", main.searchIndex],
          ["other", other.searchIndex],
        ]),
    });
    await tool.execute({ query: "carousel" }, makeCtx({ downgrade }));
    expect(downgrade).not.toHaveBeenCalled();
  });

  it("acknowledges the lockdown reason when acknowledge_lockdown:true", async () => {
    const main = newProject("main");
    const other = newProject("other");
    other.searchIndex.indexPage("foreign.md", "# F\n\nbody.\n", "test");

    const downgrade = vi.fn();
    const tool = createKbGlobalSearch({
      getAllProjectIndexes: () =>
        new Map([
          ["main", main.searchIndex],
          ["other", other.searchIndex],
        ]),
    });
    await tool.execute({ query: "body", acknowledge_lockdown: true }, makeCtx({ downgrade }));
    expect(String(downgrade.mock.calls[0]?.[0])).toMatch(/acknowledged/);
  });

  it("a project with broken FTS5 doesn't poison the fan-out", async () => {
    const main = newProject("main");
    main.searchIndex.indexPage("a.md", "# A\n\nApple alpha.\n", "test");

    const broken = {
      search: () => {
        throw new Error("simulated FTS5 corruption");
      },
    } as unknown as SearchIndex;

    const downgrade = vi.fn();
    const tool = createKbGlobalSearch({
      getAllProjectIndexes: () =>
        new Map([
          ["main", main.searchIndex],
          ["broken", broken],
        ]),
    });
    const result = JSON.parse(await tool.execute({ query: "apple" }, makeCtx({ downgrade }))) as {
      results: Array<{ projectId: string }>;
    };
    const projectIds = new Set(result.results.map((r) => r.projectId));
    expect(projectIds.has("main")).toBe(true);
    expect(projectIds.has("broken")).toBe(false);
  });

  it("returns an empty result + note for blank queries", async () => {
    const main = newProject("main");
    const tool = createKbGlobalSearch({
      getAllProjectIndexes: () => new Map([["main", main.searchIndex]]),
    });
    const downgrade = vi.fn();
    const result = JSON.parse(await tool.execute({ query: "" }, makeCtx({ downgrade }))) as {
      count: number;
      results: unknown[];
    };
    expect(result.count).toBe(0);
    expect(result.results).toEqual([]);
    expect(downgrade).not.toHaveBeenCalled();
  });

  it("skips foreign projects marked trust: strict", async () => {
    const main = newProject("main");
    const strictForeign = newProject("strict");
    const normalForeign = newProject("normal");
    main.searchIndex.indexPage("a.md", "# A\n\nMango pad notes.\n", "test");
    strictForeign.searchIndex.indexPage("b.md", "# B\n\nMango bass workflow.\n", "test");
    normalForeign.searchIndex.indexPage("c.md", "# C\n\nMango drum workflow.\n", "test");

    const downgrade = vi.fn();
    const tool = createKbGlobalSearch({
      getAllProjectIndexes: () =>
        new Map([
          ["main", main.searchIndex],
          ["strict", strictForeign.searchIndex],
          ["normal", normalForeign.searchIndex],
        ]),
      getProjectTrust: (pid) => (pid === "strict" ? "strict" : "normal"),
    });
    const result = JSON.parse(await tool.execute({ query: "mango" }, makeCtx({ downgrade }))) as {
      results: Array<{ projectId: string }>;
      skippedStrictProjects?: number;
    };

    const projectIds = new Set(result.results.map((r) => r.projectId));
    expect(projectIds.has("main")).toBe(true);
    expect(projectIds.has("normal")).toBe(true);
    expect(projectIds.has("strict")).toBe(false);
    expect(result.skippedStrictProjects).toBe(1);
  });

  it("does NOT skip the caller's own project even when its trust is strict", async () => {
    // Strict only constrains *outbound* discovery — a project's
    // own agents still see its own pages.
    const main = newProject("main");
    main.searchIndex.indexPage("a.md", "# A\n\nMango self-search.\n", "test");

    const downgrade = vi.fn();
    const tool = createKbGlobalSearch({
      getAllProjectIndexes: () => new Map([["main", main.searchIndex]]),
      getProjectTrust: () => "strict",
    });
    const result = JSON.parse(await tool.execute({ query: "mango" }, makeCtx({ downgrade }))) as {
      results: Array<{ projectId: string }>;
    };
    expect(result.results.some((r) => r.projectId === "main")).toBe(true);
    // No foreign projects participated → no downgrade.
    expect(downgrade).not.toHaveBeenCalled();
  });

  it("respects ?limit by capping the merged list", async () => {
    const main = newProject("main");
    const other = newProject("other");
    for (const fx of [main, other] as const) {
      for (let i = 0; i < 5; i++) {
        fx.searchIndex.indexPage(`p${i}.md`, `Pomelo ${i}.`, "test");
      }
    }
    const tool = createKbGlobalSearch({
      getAllProjectIndexes: () =>
        new Map([
          ["main", main.searchIndex],
          ["other", other.searchIndex],
        ]),
    });
    const downgrade = vi.fn();
    const result = JSON.parse(
      await tool.execute({ query: "pomelo", limit: 3 }, makeCtx({ downgrade })),
    ) as { count: number; results: unknown[] };
    expect(result.count).toBeLessThanOrEqual(3);
    expect(result.results.length).toBeLessThanOrEqual(3);
  });
});
