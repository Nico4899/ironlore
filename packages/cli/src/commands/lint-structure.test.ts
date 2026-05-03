import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lintStructure } from "./lint-structure.js";

/**
 * `lint --check structure` tests. Synthetic `index.sqlite` per case
 * — pages + backlinks tables seeded with rows that exercise the
 * orphan + coverage-gap detectors.
 *
 * The orphan detector skips `_maintenance/`, `getting-started/`, and
 * `.agents/` by default (per the wiki-gardener convention); pages
 * outside those prefixes with no inbound `[[...]]` are orphans.
 *
 * The coverage-gap detector flags wiki-link targets cited by ≥3
 * distinct pages that don't resolve to any existing page. The
 * resolution is case-insensitive and accepts the bare basename, the
 * no-extension path, and the full path.
 */

interface Fixture {
  cwd: string;
  projectDir: string;
  dbPath: string;
}

function makeFixture(): Fixture {
  const cwd = join(tmpdir(), `lint-structure-test-${randomBytes(4).toString("hex")}`);
  const projectDir = join(cwd, "projects", "main");
  const indexDir = join(projectDir, ".ironlore");
  mkdirSync(indexDir, { recursive: true });
  const dbPath = join(indexDir, "index.sqlite");

  const db = new Database(dbPath);
  // Mirror just enough of the SearchIndex schema to feed the lint.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      path TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      parent TEXT,
      file_type TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS backlinks (
      source_path TEXT NOT NULL,
      target_path TEXT NOT NULL,
      link_text TEXT NOT NULL,
      rel TEXT,
      PRIMARY KEY (source_path, target_path, link_text)
    );
  `);
  db.close();
  return { cwd, projectDir, dbPath };
}

function seedPages(dbPath: string, pages: Array<{ path: string; type?: string }>): void {
  const db = new Database(dbPath);
  const stmt = db.prepare("INSERT INTO pages (path, name, parent, file_type) VALUES (?, ?, ?, ?)");
  for (const p of pages) {
    const slashIdx = p.path.lastIndexOf("/");
    const name = slashIdx === -1 ? p.path : p.path.slice(slashIdx + 1);
    const parent = slashIdx === -1 ? null : p.path.slice(0, slashIdx);
    stmt.run(p.path, name, parent, p.type ?? "markdown");
  }
  db.close();
}

function seedBacklinks(dbPath: string, links: Array<{ source: string; target: string }>): void {
  const db = new Database(dbPath);
  const stmt = db.prepare(
    "INSERT INTO backlinks (source_path, target_path, link_text) VALUES (?, ?, ?)",
  );
  for (const l of links) stmt.run(l.source, l.target, l.target);
  db.close();
}

describe("lintStructure", () => {
  let fx: Fixture | null = null;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    if (fx) {
      try {
        rmSync(fx.cwd, { recursive: true, force: true });
      } catch {
        /* */
      }
      fx = null;
    }
    logSpy.mockRestore();
  });

  it("reports a clean structure when every page has at least one inbound link", () => {
    fx = makeFixture();
    seedPages(fx.dbPath, [{ path: "index.md" }, { path: "research.md" }]);
    // Mutual links: index ↔ research → both have an inbound link.
    seedBacklinks(fx.dbPath, [
      { source: "index.md", target: "research" },
      { source: "research.md", target: "index" },
    ]);

    lintStructure({ project: "main", cwd: fx.cwd });

    const calls = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(calls).toContain("Structure clean");
  });

  it("reports orphan pages (markdown, outside excluded prefixes, zero inbound links)", () => {
    fx = makeFixture();
    seedPages(fx.dbPath, [
      { path: "index.md" },
      { path: "abandoned.md" }, // no inbound — orphan
      { path: "getting-started/seed.md" }, // excluded prefix — not flagged
    ]);
    seedBacklinks(fx.dbPath, [{ source: "index.md", target: "index" }]);

    lintStructure({ project: "main", cwd: fx.cwd });

    const calls = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(calls).toContain("Orphans (1)");
    expect(calls).toContain("abandoned.md");
    // Excluded-prefix page MUST NOT appear in the orphan list even
    // though it has no inbound links.
    expect(calls).not.toContain("getting-started/seed.md");
  });

  it("reports coverage gaps for targets cited ≥3 times that don't resolve to a page", () => {
    fx = makeFixture();
    seedPages(fx.dbPath, [
      { path: "p1.md" },
      { path: "p2.md" },
      { path: "p3.md" },
      { path: "p4.md" },
      { path: "found.md" }, // a real page that one citation resolves to
    ]);
    seedBacklinks(fx.dbPath, [
      { source: "p1.md", target: "Quantum Stuff" }, // 4× citations, no resolving page
      { source: "p2.md", target: "Quantum Stuff" },
      { source: "p3.md", target: "Quantum Stuff" },
      { source: "p4.md", target: "Quantum Stuff" },
      { source: "p1.md", target: "Found" }, // resolves to found.md — not a gap
      { source: "p2.md", target: "found" }, // case-insensitive resolution
      { source: "p3.md", target: "found.md" },
      { source: "p1.md", target: "Onestory" }, // single citation — under threshold
    ]);

    lintStructure({ project: "main", cwd: fx.cwd });

    const calls = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(calls).toContain("Coverage gaps");
    expect(calls).toContain("Quantum Stuff");
    expect(calls).toContain("×4");
    // Single-citation target stays under the threshold — must not appear.
    expect(calls).not.toContain("Onestory");
    // `found` resolved via case-insensitive lookup — must not appear.
    expect(calls).not.toContain("[[found]]");
    expect(calls).not.toContain("[[Found]]");
  });

  it("falls back gracefully when the index does not exist yet", () => {
    fx = makeFixture();
    rmSync(fx.dbPath); // simulate "no index"

    lintStructure({ project: "main", cwd: fx.cwd });

    const calls = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(calls).toContain("No index found");
  });
});
