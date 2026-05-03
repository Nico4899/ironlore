import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeEtag } from "@ironlore/core/server";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lintWalIntegrity } from "./lint-wal.js";

/**
 * `lint --check wal-integrity` tests.
 *
 * Builds a synthetic project layout (cwd + projects/<id>/.ironlore/wal/wal.sqlite +
 * data/) for each case, then exercises `lintWalIntegrity({fix})` against
 * the four spec'd recovery states (post-match / pre-match / neither /
 * delete) plus the "no WAL exists" and "WAL clean" baselines.
 *
 * The four cases cover docs/02-storage-and-sync.md §WAL crash recovery
 * lines 45-60. Case 3 (neither) is the only one that must NOT auto-
 * repair — the doc forbids overwriting because the on-disk file may
 * be a legitimate external edit.
 */

interface Fixture {
  cwd: string;
  projectDir: string;
  dataRoot: string;
  walPath: string;
  walDb: Database.Database;
}

function makeFixture(): Fixture {
  const cwd = join(tmpdir(), `lint-wal-test-${randomBytes(4).toString("hex")}`);
  const projectDir = join(cwd, "projects", "main");
  const dataRoot = join(projectDir, "data");
  const walDir = join(projectDir, ".ironlore", "wal");
  const walPath = join(walDir, "wal.sqlite");
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(walDir, { recursive: true });
  const walDb = new Database(walPath);
  // Mirror the schema in apps/web/src/server/wal.ts:39-58.
  walDb.exec(`
    CREATE TABLE IF NOT EXISTS wal_entries (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      path       TEXT    NOT NULL,
      op         TEXT    NOT NULL CHECK(op IN ('write', 'delete')),
      pre_hash   TEXT,
      post_hash  TEXT,
      content    TEXT,
      author     TEXT    NOT NULL DEFAULT 'user',
      message    TEXT    NOT NULL DEFAULT '',
      committed  INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);
  return { cwd, projectDir, dataRoot, walPath, walDb };
}

function insertWal(
  fx: Fixture,
  entry: {
    path: string;
    op: "write" | "delete";
    preHash: string | null;
    postHash: string | null;
    content: string | null;
  },
): number {
  const stmt = fx.walDb.prepare(
    "INSERT INTO wal_entries (path, op, pre_hash, post_hash, content) VALUES (?, ?, ?, ?, ?)",
  );
  const result = stmt.run(entry.path, entry.op, entry.preHash, entry.postHash, entry.content);
  return Number(result.lastInsertRowid);
}

function isCommitted(fx: Fixture, id: number): boolean {
  fx.walDb.close();
  const ro = new Database(fx.walPath, { readonly: true });
  try {
    const row = ro.prepare("SELECT committed FROM wal_entries WHERE id = ?").get(id) as
      | { committed: number }
      | undefined;
    return (row?.committed ?? 0) === 1;
  } finally {
    ro.close();
    fx.walDb = new Database(fx.walPath);
  }
}

describe("lintWalIntegrity", () => {
  let fx: Fixture | null = null;
  // Use any here — vi's mockImplementation generic vs. process.exit's
  // never-return type don't unify cleanly, and the mock just throws so
  // the runtime contract is satisfied either way.
  // biome-ignore lint/suspicious/noExplicitAny: mock-typing escape hatch
  let exitSpy: any;

  beforeEach(() => {
    // Stub process.exit so we can assert it was called without
    // tearing down the test runner. Throwing is the standard vitest
    // pattern — the production caller never expects exit to return.
    exitSpy = vi
      .spyOn(process, "exit")
      // biome-ignore lint/suspicious/noExplicitAny: mock-typing escape hatch
      .mockImplementation(((_code?: number) => {
        throw new Error("process.exit");
      }) as any);
  });

  afterEach(() => {
    if (fx) {
      try {
        fx.walDb.close();
      } catch {
        /* */
      }
      try {
        rmSync(fx.cwd, { recursive: true, force: true });
      } catch {
        /* */
      }
      fx = null;
    }
    exitSpy.mockRestore();
  });

  it("no-op when the WAL file does not exist", () => {
    fx = makeFixture();
    fx.walDb.close();
    rmSync(fx.walPath); // remove the file we just created
    // No throw, no exit.
    const cwd = fx.cwd;
    expect(() => lintWalIntegrity({ project: "main", cwd })).not.toThrow();
  });

  it("no-op when the WAL has no uncommitted entries", () => {
    fx = makeFixture();
    insertWal(fx, { path: "a.md", op: "write", preHash: null, postHash: "x", content: "x" });
    // Mark as committed
    fx.walDb.prepare("UPDATE wal_entries SET committed = 1").run();
    const cwd = fx.cwd;
    expect(() => lintWalIntegrity({ project: "main", cwd })).not.toThrow();
  });

  it("CASE 1 (post-write match): --fix marks the entry committed", () => {
    fx = makeFixture();
    const content = "# A\n\nFinal body.\n";
    const postHash = computeEtag(content);
    writeFileSync(join(fx.dataRoot, "a.md"), content);
    const id = insertWal(fx, {
      path: "a.md",
      op: "write",
      preHash: null,
      postHash,
      content,
    });
    expect(isCommitted(fx, id)).toBe(false);

    lintWalIntegrity({ project: "main", cwd: fx.cwd, fix: true });

    expect(isCommitted(fx, id)).toBe(true);
  });

  it("CASE 2 (pre-write match): --fix replays the write from WAL content", () => {
    fx = makeFixture();
    const preContent = "# A\n\nOriginal.\n";
    const postContent = "# A\n\nReplayed.\n";
    const preHash = computeEtag(preContent);
    const postHash = computeEtag(postContent);
    writeFileSync(join(fx.dataRoot, "a.md"), preContent); // file still on prev version
    const id = insertWal(fx, {
      path: "a.md",
      op: "write",
      preHash,
      postHash,
      content: postContent,
    });

    lintWalIntegrity({ project: "main", cwd: fx.cwd, fix: true });

    // File now matches the WAL content; entry committed.
    expect(readFileSync(join(fx.dataRoot, "a.md"), "utf-8")).toBe(postContent);
    expect(isCommitted(fx, id)).toBe(true);
  });

  it("CASE 3 (neither): --fix REFUSES to overwrite, surfaces hashes, exits 1", () => {
    fx = makeFixture();
    const preContent = "original\n";
    const postContent = "wal expected\n";
    const externalContent = "user edit\n"; // file modified outside Ironlore
    const preHash = computeEtag(preContent);
    const postHash = computeEtag(postContent);
    writeFileSync(join(fx.dataRoot, "a.md"), externalContent);
    insertWal(fx, {
      path: "a.md",
      op: "write",
      preHash,
      postHash,
      content: postContent,
    });

    const cwd = fx.cwd;
    expect(() => lintWalIntegrity({ project: "main", cwd, fix: true })).toThrow(
      "process.exit",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    // The on-disk file must be UNTOUCHED — the spec forbids
    // auto-clobbering external edits during recovery.
    expect(readFileSync(join(fx.dataRoot, "a.md"), "utf-8")).toBe(externalContent);
  });

  it("CASE 4a (delete-pending): file still present, --fix unlinks + commits", () => {
    fx = makeFixture();
    writeFileSync(join(fx.dataRoot, "stale.md"), "should be gone\n");
    const id = insertWal(fx, {
      path: "stale.md",
      op: "delete",
      preHash: null,
      postHash: null,
      content: null,
    });

    lintWalIntegrity({ project: "main", cwd: fx.cwd, fix: true });

    expect(existsSync(join(fx.dataRoot, "stale.md"))).toBe(false);
    expect(isCommitted(fx, id)).toBe(true);
  });

  it("CASE 4b (delete-done): file already gone, --fix marks committed", () => {
    fx = makeFixture();
    // No file present.
    const id = insertWal(fx, {
      path: "phantom.md",
      op: "delete",
      preHash: null,
      postHash: null,
      content: null,
    });

    lintWalIntegrity({ project: "main", cwd: fx.cwd, fix: true });

    expect(isCommitted(fx, id)).toBe(true);
  });

  it("report mode (no --fix) is read-only — does not commit, does not modify files", () => {
    fx = makeFixture();
    const content = "# A\n\nFinal.\n";
    writeFileSync(join(fx.dataRoot, "a.md"), content);
    const id = insertWal(fx, {
      path: "a.md",
      op: "write",
      preHash: null,
      postHash: computeEtag(content),
      content,
    });

    // No --fix
    lintWalIntegrity({ project: "main", cwd: fx.cwd });

    // Entry stays uncommitted; file unchanged.
    expect(isCommitted(fx, id)).toBe(false);
  });
});
