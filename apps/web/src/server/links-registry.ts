import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DERIVED_DIR } from "@ironlore/core";
import type { LinkedPathValidator } from "@ironlore/core/server";
import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LinkRow {
  id: number;
  symlink_path: string;
  target_realpath: string;
  created_at: string;
  created_by: string;
}

/** Marker file that must exist at the root of a linked target directory. */
const MARKER_FILE = ".ironlore-link.yaml";

// ---------------------------------------------------------------------------
// LinksRegistry
// ---------------------------------------------------------------------------

/**
 * Per-project registry of UI-created linked directories.
 *
 * Symlinks inside a project's data directory that point outside the project
 * root are normally rejected by `resolveSafe()`. The LinksRegistry records
 * which symlinks were explicitly created through the UI, and provides a
 * validator callback so that `resolveSafe()` can allow them.
 *
 * Two-level safety check:
 * 1. The target's realpath must be registered in links.sqlite.
 * 2. The target directory must contain a marker file (`{@link MARKER_FILE}`).
 *
 * This prevents hand-planted symlinks from being followed — even if someone
 * adds a row to links.sqlite, the marker file at the target must also exist.
 *
 * The SQLite database lives at `<projectDir>/.ironlore/links.sqlite`.
 */
export class LinksRegistry {
  private db: InstanceType<typeof Database>;

  constructor(projectDir: string) {
    const dbPath = join(projectDir, DERIVED_DIR, "links.sqlite");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS linked_directories (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        symlink_path    TEXT NOT NULL UNIQUE,
        target_realpath TEXT NOT NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        created_by      TEXT NOT NULL DEFAULT 'user'
      )
    `);
  }

  /**
   * Register a new linked directory.
   *
   * @param symlinkPath - Relative path of the symlink within the data dir
   * @param targetRealpath - Absolute realpath the symlink points to
   * @param createdBy - Who created the link (default: "user")
   * @throws if the target does not contain the marker file
   */
  registerLink(symlinkPath: string, targetRealpath: string, createdBy = "user"): LinkRow {
    const resolved = realpathSync(targetRealpath);

    if (!existsSync(join(resolved, MARKER_FILE))) {
      throw new LinkMarkerMissingError(resolved);
    }

    const stmt = this.db.prepare(`
      INSERT INTO linked_directories (symlink_path, target_realpath, created_by)
      VALUES (?, ?, ?)
    `);
    const result = stmt.run(symlinkPath, resolved, createdBy);

    return {
      id: result.lastInsertRowid as number,
      symlink_path: symlinkPath,
      target_realpath: resolved,
      created_at: new Date().toISOString(),
      created_by: createdBy,
    };
  }

  /**
   * Remove a linked directory registration by symlink path.
   * Returns true if a row was deleted.
   */
  removeLink(symlinkPath: string): boolean {
    const stmt = this.db.prepare(
      "DELETE FROM linked_directories WHERE symlink_path = ?",
    );
    return stmt.run(symlinkPath).changes > 0;
  }

  /**
   * Check whether a realpath is registered AND its marker file still exists.
   * This is the two-level check used by `resolveSafe()`.
   */
  isRegistered(realpath: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM linked_directories WHERE target_realpath = ?")
      .get(realpath);

    if (!row) return false;

    // Second level: marker file must still exist at the target
    return existsSync(join(realpath, MARKER_FILE));
  }

  /**
   * List all registered linked directories.
   */
  list(): LinkRow[] {
    return this.db
      .prepare("SELECT * FROM linked_directories ORDER BY created_at")
      .all() as LinkRow[];
  }

  /**
   * Return a `LinkedPathValidator` callback suitable for passing to
   * `resolveSafe()`. The callback captures `this` so it can be used
   * independently of the registry instance.
   */
  validator(): LinkedPathValidator {
    return (realpath: string) => this.isRegistered(realpath);
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class LinkMarkerMissingError extends Error {
  override readonly name = "LinkMarkerMissingError";
  constructor(public readonly targetPath: string) {
    super(
      `Cannot register linked directory: marker file "${MARKER_FILE}" not found at "${targetPath}"`,
    );
  }
}
