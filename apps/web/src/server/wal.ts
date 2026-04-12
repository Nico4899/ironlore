import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export interface WalEntry {
  id: number;
  path: string;
  op: "write" | "delete";
  preHash: string | null;
  postHash: string | null;
  content: string | null;
  author: string;
  message: string;
  committed: 0 | 1;
  createdAt: string;
}

/**
 * Write-Ahead Log backed by SQLite.
 *
 * Every mutation is appended synchronously to the WAL before the filesystem
 * write, ensuring durability. The git worker drains committed entries.
 */
export class Wal {
  private db: Database.Database;

  constructor(projectDir: string) {
    const walDir = join(projectDir, ".ironlore", "wal");
    mkdirSync(walDir, { recursive: true });
    const dbPath = join(walDir, "wal.sqlite");

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
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

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_wal_committed
      ON wal_entries(committed, created_at)
    `);
  }

  /**
   * Append a write operation to the WAL. Synchronous — returns only after
   * the entry is durable on disk.
   */
  append(entry: {
    path: string;
    op: "write" | "delete";
    preHash: string | null;
    postHash: string | null;
    content: string | null;
    author?: string;
    message?: string;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO wal_entries (path, op, pre_hash, post_hash, content, author, message)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      entry.path,
      entry.op,
      entry.preHash,
      entry.postHash,
      entry.content,
      entry.author ?? "user",
      entry.message ?? "",
    );
    return Number(result.lastInsertRowid);
  }

  /**
   * Mark a WAL entry as committed (filesystem write succeeded).
   */
  markCommitted(id: number): void {
    this.db.prepare("UPDATE wal_entries SET committed = 1 WHERE id = ?").run(id);
  }

  /**
   * Get all uncommitted entries for crash recovery on startup.
   */
  getUncommitted(): WalEntry[] {
    return this.db
      .prepare(
        `SELECT id, path, op, pre_hash AS preHash, post_hash AS postHash,
                content, author, message, committed, created_at AS createdAt
         FROM wal_entries WHERE committed = 0 ORDER BY id`,
      )
      .all() as WalEntry[];
  }

  /**
   * Get committed entries not yet consumed by the git worker.
   * Returns entries grouped by author + time window for batched commits.
   */
  getCommittedPending(limit = 100): WalEntry[] {
    return this.db
      .prepare(
        `SELECT id, path, op, pre_hash AS preHash, post_hash AS postHash,
                content, author, message, committed, created_at AS createdAt
         FROM wal_entries WHERE committed = 1 ORDER BY id LIMIT ?`,
      )
      .all(limit) as WalEntry[];
  }

  /**
   * Delete consumed entries (after git commit).
   */
  deleteConsumed(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    this.db.prepare(`DELETE FROM wal_entries WHERE id IN (${placeholders})`).run(...ids);
  }

  /**
   * Count of uncommitted WAL entries (for health endpoint).
   */
  getDepth(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM wal_entries WHERE committed = 0")
      .get() as { cnt: number };
    return row.cnt;
  }

  close(): void {
    this.db.close();
  }
}
