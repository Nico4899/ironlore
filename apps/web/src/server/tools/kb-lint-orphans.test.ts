import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SearchIndex } from "../search-index.js";
import type { ToolCallContext } from "./types.js";
import { createKbLintOrphans } from "./kb-lint-orphans.js";

/**
 * `kb.lint_orphans` + `SearchIndex.findOrphans` together. Real
 * SQLite on disk, real indexPage() calls — the same code path a live
 * server would exercise.
 */

function makeTmpProject(): string {
  const dir = join(tmpdir(), `lint-orphans-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, ".ironlore"), { recursive: true });
  return dir;
}

const NO_CTX: ToolCallContext = {
  projectId: "main",
  agentSlug: "wiki-gardener",
  jobId: "test",
  emitEvent: () => undefined,
  dataRoot: "",
};

describe("SearchIndex.findOrphans + kb.lint_orphans", () => {
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

  it("returns a page with no inbound wiki-links as an orphan", () => {
    const index = createIndex();
    index.indexPage("lonely.md", "# Lonely\n\nNo one links here.", "user");

    const orphans = index.findOrphans();
    expect(orphans.map((o) => o.path)).toEqual(["lonely.md"]);
  });

  it("omits a page that has at least one inbound wiki-link", () => {
    const index = createIndex();
    index.indexPage("hub.md", "# Hub\n\nSee [[lonely]].", "user");
    index.indexPage("lonely.md", "# Lonely", "user");

    const orphans = index.findOrphans();
    expect(orphans.map((o) => o.path)).toEqual(["hub.md"]); // lonely is linked now
  });

  it("excludes _maintenance/, getting-started/, and .agents/ by default", () => {
    const index = createIndex();
    index.indexPage("_maintenance/lint-2026-04-23.md", "# Report", "user");
    index.indexPage("getting-started/index.md", "# Getting Started", "user");
    index.indexPage(".agents/general/persona.md", "# Persona", "user");
    index.indexPage("content/real-orphan.md", "# Real orphan", "user");

    const orphans = index.findOrphans();
    expect(orphans.map((o) => o.path)).toEqual(["content/real-orphan.md"]);
  });

  it("honors a caller-supplied excludePrefixes override", () => {
    const index = createIndex();
    index.indexPage("archive/old.md", "# Old", "user");
    index.indexPage("notes/new.md", "# New", "user");

    const orphans = index.findOrphans({ excludePrefixes: ["archive/"] });
    expect(orphans.map((o) => o.path)).toEqual(["notes/new.md"]);
  });

  it("includes every markdown page when excludePrefixes is empty", () => {
    const index = createIndex();
    index.indexPage("_maintenance/report.md", "# Report", "user");
    index.indexPage("notes/foo.md", "# Foo", "user");

    const orphans = index.findOrphans({ excludePrefixes: [] });
    expect(orphans.map((o) => o.path).sort()).toEqual([
      "_maintenance/report.md",
      "notes/foo.md",
    ]);
  });

  it("kb.lint_orphans tool returns a JSON envelope with count + orphans", async () => {
    const index = createIndex();
    index.indexPage("hub.md", "# Hub\n\nLinks to [[foo]].", "user");
    index.indexPage("foo.md", "# Foo", "user");
    index.indexPage("bar.md", "# Bar", "user");

    const tool = createKbLintOrphans(index);
    const out = JSON.parse(await tool.execute({}, NO_CTX)) as {
      count: number;
      orphans: Array<{ path: string }>;
    };
    // hub.md has no inbound links; bar.md has no inbound links; foo.md is linked from hub.
    expect(out.count).toBe(2);
    expect(out.orphans.map((o) => o.path).sort()).toEqual(["bar.md", "hub.md"]);
  });

  it("kb.lint_orphans reports zero orphans with an empty array (not null)", async () => {
    const index = createIndex();
    index.indexPage("hub.md", "# Hub\n\n[[spoke]]", "user");
    index.indexPage("spoke.md", "# Spoke\n\n[[hub]]", "user");

    const tool = createKbLintOrphans(index);
    const out = JSON.parse(await tool.execute({}, NO_CTX)) as {
      count: number;
      orphans: unknown[];
    };
    expect(out.count).toBe(0);
    expect(out.orphans).toEqual([]);
  });

  it("kb.lint_orphans respects caller-supplied excludePrefixes", async () => {
    const index = createIndex();
    index.indexPage("temp/x.md", "# x", "user");
    index.indexPage("notes/y.md", "# y", "user");

    const tool = createKbLintOrphans(index);
    const out = JSON.parse(
      await tool.execute({ excludePrefixes: ["temp/"] }, NO_CTX),
    ) as { count: number; orphans: Array<{ path: string }> };
    expect(out.orphans.map((o) => o.path)).toEqual(["notes/y.md"]);
  });
});
