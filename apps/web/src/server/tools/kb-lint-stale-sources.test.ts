import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SearchIndex } from "../search-index.js";
import { createKbLintStaleSources } from "./kb-lint-stale-sources.js";
import type { ToolCallContext } from "./types.js";

/**
 * `kb.lint_stale_sources` + `SearchIndex.findStaleSources()` together.
 * Real SQLite + indexPage — the same code path a live server uses.
 *
 * `datetime('now')` has second resolution, so consecutive writes in
 * the same test can land on the same timestamp. We nudge the `pages`
 * table's `updated_at` directly after each indexPage call so the
 * staleness math has an unambiguous ordering. In production the
 * drift arises naturally from user edits happening seconds or
 * hours apart.
 */

function makeTmpProject(): string {
  const dir = join(tmpdir(), `lint-stale-test-${randomBytes(4).toString("hex")}`);
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

/** Backdate a page's pages.updated_at to an earlier ISO timestamp. */
function stamp(index: SearchIndex, path: string, iso: string): void {
  // SearchIndex keeps its db private; reach in via a prepared stmt
  // through the exposed better-sqlite handle. Tests exercise the
  // SQL directly because the production code never modifies
  // updated_at out of band.
  // biome-ignore lint/suspicious/noExplicitAny: test-only internal hook
  const db = (index as any).db as import("better-sqlite3").Database;
  db.prepare("UPDATE pages SET updated_at = ? WHERE path = ?").run(iso, path);
}

function frontmatter(kind: "page" | "source" | "wiki", body = ""): string {
  return `---\nkind: ${kind}\n---\n\n${body}`;
}

describe("SearchIndex.findStaleSources + kb.lint_stale_sources", () => {
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

  it("flags a wiki whose cited source has a newer mtime", () => {
    const index = createIndex();
    index.indexPage("wiki/overview.md", frontmatter("wiki", "See [[interview]]."), "user");
    stamp(index, "wiki/overview.md", "2026-01-01T00:00:00Z");
    index.indexPage("sources/interview.md", frontmatter("source", "# Interview"), "user");
    stamp(index, "sources/interview.md", "2026-02-01T00:00:00Z");
    // Rebuild backlinks under the basename the wiki used.
    index.indexPage("wiki/overview.md", frontmatter("wiki", "See [[interview]]."), "user");
    stamp(index, "wiki/overview.md", "2026-01-01T00:00:00Z");

    const stale = index.findStaleSources();
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({
      wikiPath: "wiki/overview.md",
      sourcePath: "sources/interview.md",
      wikiUpdatedAt: "2026-01-01T00:00:00Z",
      sourceUpdatedAt: "2026-02-01T00:00:00Z",
    });
  });

  it("does not flag when the source is older than the wiki", () => {
    const index = createIndex();
    index.indexPage("sources/old.md", frontmatter("source"), "user");
    stamp(index, "sources/old.md", "2026-01-01T00:00:00Z");
    index.indexPage("wiki/fresh.md", frontmatter("wiki", "See [[old]]."), "user");
    stamp(index, "wiki/fresh.md", "2026-02-01T00:00:00Z");

    expect(index.findStaleSources()).toEqual([]);
  });

  it("does not flag an identical-mtime pair (strict >, not >=)", () => {
    const index = createIndex();
    index.indexPage("sources/s.md", frontmatter("source"), "user");
    stamp(index, "sources/s.md", "2026-02-01T00:00:00Z");
    index.indexPage("wiki/w.md", frontmatter("wiki", "[[s]]"), "user");
    stamp(index, "wiki/w.md", "2026-02-01T00:00:00Z");

    expect(index.findStaleSources()).toEqual([]);
  });

  it("ignores outbound links to non-source pages", () => {
    const index = createIndex();
    // Wiki links to a kind:page — not a source — and that page is newer.
    index.indexPage("notes/plain.md", frontmatter("page"), "user");
    stamp(index, "notes/plain.md", "2026-02-01T00:00:00Z");
    index.indexPage("wiki/w.md", frontmatter("wiki", "[[plain]]"), "user");
    stamp(index, "wiki/w.md", "2026-01-01T00:00:00Z");

    expect(index.findStaleSources()).toEqual([]);
  });

  it("ignores outbound links from non-wiki pages", () => {
    const index = createIndex();
    // Plain page links to a newer source — not the wiki-gardener's concern.
    index.indexPage("sources/s.md", frontmatter("source"), "user");
    stamp(index, "sources/s.md", "2026-02-01T00:00:00Z");
    index.indexPage("notes/plain.md", frontmatter("page", "[[s]]"), "user");
    stamp(index, "notes/plain.md", "2026-01-01T00:00:00Z");

    expect(index.findStaleSources()).toEqual([]);
  });

  it("emits one row per (wiki, source) pair when a wiki cites multiple stale sources", () => {
    const index = createIndex();
    index.indexPage("sources/a.md", frontmatter("source"), "user");
    stamp(index, "sources/a.md", "2026-02-01T00:00:00Z");
    index.indexPage("sources/b.md", frontmatter("source"), "user");
    stamp(index, "sources/b.md", "2026-02-02T00:00:00Z");
    index.indexPage("wiki/w.md", frontmatter("wiki", "See [[a]] and [[b]]."), "user");
    stamp(index, "wiki/w.md", "2026-01-01T00:00:00Z");

    const stale = index.findStaleSources();
    expect(stale.map((r) => r.sourcePath)).toEqual(["sources/a.md", "sources/b.md"]);
  });

  it("resolves links written with the `.md` suffix and full path", () => {
    const index = createIndex();
    index.indexPage("sources/interview.md", frontmatter("source"), "user");
    stamp(index, "sources/interview.md", "2026-02-01T00:00:00Z");
    // `[[sources/interview]]` — path without .md
    index.indexPage("wiki/full.md", frontmatter("wiki", "See [[sources/interview]]."), "user");
    stamp(index, "wiki/full.md", "2026-01-01T00:00:00Z");

    const stale = index.findStaleSources();
    expect(stale.map((r) => r.wikiPath)).toEqual(["wiki/full.md"]);
  });

  it("kb.lint_stale_sources returns a JSON envelope with count + stale rows", async () => {
    const index = createIndex();
    index.indexPage("sources/s.md", frontmatter("source"), "user");
    stamp(index, "sources/s.md", "2026-02-01T00:00:00Z");
    index.indexPage("wiki/w.md", frontmatter("wiki", "[[s]]"), "user");
    stamp(index, "wiki/w.md", "2026-01-01T00:00:00Z");

    const tool = createKbLintStaleSources(index);
    const out = JSON.parse(await tool.execute({}, NO_CTX)) as {
      count: number;
      stale: Array<{ wikiPath: string; sourcePath: string }>;
    };
    expect(out.count).toBe(1);
    expect(out.stale[0]).toMatchObject({ wikiPath: "wiki/w.md", sourcePath: "sources/s.md" });
  });

  it("kb.lint_stale_sources reports zero stale pairs with an empty array (not null)", async () => {
    const index = createIndex();
    // No wikis, no sources.
    const tool = createKbLintStaleSources(index);
    const out = JSON.parse(await tool.execute({}, NO_CTX)) as {
      count: number;
      stale: unknown[];
    };
    expect(out.count).toBe(0);
    expect(out.stale).toEqual([]);
  });

  it("sorts rows deterministically by wikiPath then sourcePath", () => {
    const index = createIndex();
    index.indexPage("sources/z.md", frontmatter("source"), "user");
    stamp(index, "sources/z.md", "2026-02-01T00:00:00Z");
    index.indexPage("sources/a.md", frontmatter("source"), "user");
    stamp(index, "sources/a.md", "2026-02-02T00:00:00Z");
    index.indexPage("wiki/b.md", frontmatter("wiki", "[[a]] [[z]]"), "user");
    stamp(index, "wiki/b.md", "2026-01-01T00:00:00Z");
    index.indexPage("wiki/a.md", frontmatter("wiki", "[[z]]"), "user");
    stamp(index, "wiki/a.md", "2026-01-01T00:00:00Z");

    const stale = index.findStaleSources();
    expect(stale.map((r) => `${r.wikiPath}→${r.sourcePath}`)).toEqual([
      "wiki/a.md→sources/z.md",
      "wiki/b.md→sources/a.md",
      "wiki/b.md→sources/z.md",
    ]);
  });
});
