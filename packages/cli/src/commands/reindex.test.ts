import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reindex } from "./reindex.js";

/**
 * `ironlore lint --fix --check index-consistency` → reindex tests.
 *
 * The CLI's reindex rebuilds `.ironlore/index.sqlite` from the data/
 * directory. The server's SearchIndex creates a richer schema (pages
 * table for the sidebar, pages_chunks_fts for block-level citations,
 * rel column on backlinks for typed wiki-links) — the CLI MUST match
 * it or a CLI-driven rebuild would brick the running app.
 *
 * These tests enforce schema parity by opening the resulting DB
 * directly and asserting every table + column + index the server
 * relies on. They also populate real data to catch silent failures
 * (e.g., missing table = runtime exception at query time).
 */

function makeTmpCwd(): string {
  const cwd = join(tmpdir(), `reindex-cli-${randomBytes(4).toString("hex")}`);
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

function makeProjectWithContent(cwd: string, id: string, files: Record<string, string>): string {
  const dataRoot = join(cwd, "projects", id, "data");
  mkdirSync(join(cwd, "projects", id, ".ironlore"), { recursive: true });
  mkdirSync(dataRoot, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(dataRoot, relPath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return join(cwd, "projects", id);
}

describe("reindex — schema parity with server SearchIndex", () => {
  let cwd: string;
  let origCwd: () => string;

  beforeEach(() => {
    cwd = makeTmpCwd();
    // reindex() reads process.cwd() — temporarily point it at our tempdir.
    origCwd = process.cwd;
    process.cwd = () => cwd;
    // Silence CLI logs.
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    process.cwd = origCwd;
    vi.restoreAllMocks();
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("creates every table and index the server's SearchIndex expects", () => {
    makeProjectWithContent(cwd, "main", {
      "a.md": "# A\n\nContent.",
    });
    reindex({ project: "main" });

    const db = new Database(join(cwd, "projects", "main", ".ironlore", "index.sqlite"), {
      readonly: true,
    });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' OR type='virtual table'")
        .all() as Array<{ name: string }>;
      const tableNames = new Set(tables.map((t) => t.name));

      // Schema must be the superset SearchIndex creates.
      expect(tableNames.has("pages_fts")).toBe(true);
      expect(tableNames.has("pages_chunks_fts")).toBe(true);
      expect(tableNames.has("pages")).toBe(true);
      expect(tableNames.has("backlinks")).toBe(true);
      expect(tableNames.has("tags")).toBe(true);
      expect(tableNames.has("recent_edits")).toBe(true);

      // Backlinks must include the `rel` column (typed relations).
      const backlinksCols = db.prepare("PRAGMA table_info(backlinks)").all() as Array<{
        name: string;
      }>;
      const colNames = new Set(backlinksCols.map((c) => c.name));
      expect(colNames.has("rel")).toBe(true);

      // Indices the server relies on.
      const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{
        name: string;
      }>;
      const idxNames = new Set(idx.map((i) => i.name));
      expect(idxNames.has("idx_backlinks_target")).toBe(true);
      expect(idxNames.has("idx_tags_tag")).toBe(true);
      expect(idxNames.has("idx_pages_parent")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("populates the pages table with file_type + parent so the sidebar renders", () => {
    makeProjectWithContent(cwd, "main", {
      "top.md": "# Top",
      "folder/nested.md": "# Nested",
      "folder/deeper/deep.md": "# Deep",
    });
    reindex({ project: "main" });

    const db = new Database(join(cwd, "projects", "main", ".ironlore", "index.sqlite"), {
      readonly: true,
    });
    try {
      const rows = db
        .prepare("SELECT path, name, parent, file_type FROM pages ORDER BY path")
        .all() as Array<{ path: string; name: string; parent: string | null; file_type: string }>;

      const byPath = new Map(rows.map((r) => [r.path, r]));

      // Markdown leaves should be present with file_type=markdown.
      expect(byPath.get("top.md")?.file_type).toBe("markdown");
      expect(byPath.get("folder/nested.md")?.file_type).toBe("markdown");
      expect(byPath.get("folder/deeper/deep.md")?.file_type).toBe("markdown");

      // Parent chain should be materialized so the sidebar tree has
      // directory rows to hang leaves off of.
      expect(byPath.get("folder")?.file_type).toBe("directory");
      expect(byPath.get("folder/deeper")?.file_type).toBe("directory");
      expect(byPath.get("folder/deeper")?.parent).toBe("folder");
      expect(byPath.get("folder")?.parent).toBeNull();
    } finally {
      db.close();
    }
  });

  it("populates chunk FTS with block-ID ranges", () => {
    // ULIDs are 26 base32 chars. Use a fixed-length helper.
    const id = (i: number) => `blk_01HCCCCCCCCCCCCCCCCCCCCCX${i}`;
    const content = [
      `# Title <!-- #${id(1)} -->`,
      "",
      `First paragraph. <!-- #${id(2)} -->`,
      "",
      `Second paragraph. <!-- #${id(3)} -->`,
    ].join("\n");

    makeProjectWithContent(cwd, "main", { "page.md": content });
    reindex({ project: "main" });

    const db = new Database(join(cwd, "projects", "main", ".ironlore", "index.sqlite"), {
      readonly: true,
    });
    try {
      const chunks = db
        .prepare("SELECT path, block_id_start, block_id_end FROM pages_chunks_fts WHERE path = ?")
        .all("page.md") as Array<{
        path: string;
        block_id_start: string;
        block_id_end: string;
      }>;
      expect(chunks.length).toBeGreaterThan(0);
      // At least one chunk should cite real block IDs (not empty strings).
      expect(chunks[0]?.block_id_start).toMatch(/^blk_/);
      expect(chunks[0]?.block_id_end).toMatch(/^blk_/);
    } finally {
      db.close();
    }
  });

  it("stores the typed-relation `rel` for pipe-syntax wiki-links", () => {
    makeProjectWithContent(cwd, "main", {
      "claim.md": "# Claim\n\nThis [[Paper X | contradicts]] prior work.",
    });
    reindex({ project: "main" });

    const db = new Database(join(cwd, "projects", "main", ".ironlore", "index.sqlite"), {
      readonly: true,
    });
    try {
      const rows = db
        .prepare("SELECT source_path, target_path, rel FROM backlinks")
        .all() as Array<{ source_path: string; target_path: string; rel: string | null }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.rel).toBe("contradicts");
    } finally {
      db.close();
    }
  });

  it("clears stale data when rebuilding", () => {
    // First pass with one page.
    makeProjectWithContent(cwd, "main", {
      "old.md": "# Old page",
    });
    reindex({ project: "main" });

    // Remove the old page and replace with a new one; rebuild.
    rmSync(join(cwd, "projects", "main", "data", "old.md"));
    writeFileSync(join(cwd, "projects", "main", "data", "new.md"), "# New page");
    reindex({ project: "main" });

    const db = new Database(join(cwd, "projects", "main", ".ironlore", "index.sqlite"), {
      readonly: true,
    });
    try {
      const paths = db.prepare("SELECT path FROM pages").all() as Array<{ path: string }>;
      const pathSet = new Set(paths.map((r) => r.path));
      expect(pathSet.has("new.md")).toBe(true);
      expect(pathSet.has("old.md")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("handles an empty data/ directory without crashing", () => {
    makeProjectWithContent(cwd, "main", {});
    expect(() => reindex({ project: "main" })).not.toThrow();
  });
});
