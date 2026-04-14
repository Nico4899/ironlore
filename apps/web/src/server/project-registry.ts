import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectPreset } from "@ironlore/core";
import { SENSITIVE_FILE_MODE } from "@ironlore/core";
import Database from "better-sqlite3";

export interface ProjectRecord {
  id: string;
  name: string;
  preset: ProjectPreset;
  createdAt: string;
}

/**
 * Project registry backed by `projects.sqlite` at the install root.
 *
 * This is a process-wide file (not per-project) because the project
 * switcher queries it before a specific project is selected.
 */
export class ProjectRegistry {
  private db: Database.Database;

  constructor(installRoot: string) {
    const dbPath = join(installRoot, "projects.sqlite");
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    // Restrict permissions — projects.sqlite is a sensitive file (0600)
    chmodSync(dbPath, SENSITIVE_FILE_MODE);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id         TEXT    PRIMARY KEY,
        name       TEXT    NOT NULL,
        preset     TEXT    NOT NULL CHECK(preset IN ('main', 'research', 'sandbox')),
        created_at TEXT    NOT NULL DEFAULT (datetime('now'))
      )
    `);
    // Rename legacy `kind` column on pre-existing dev databases.
    const cols = this.db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "kind") && !cols.some((c) => c.name === "preset")) {
      this.db.exec("ALTER TABLE projects RENAME COLUMN kind TO preset");
    }
  }

  /**
   * Ensure a project exists in the registry. Inserts if missing.
   */
  ensureProject(id: string, name: string, preset: ProjectPreset): void {
    this.db
      .prepare("INSERT OR IGNORE INTO projects (id, name, preset) VALUES (?, ?, ?)")
      .run(id, name, preset);
  }

  /**
   * Get a project by ID.
   */
  get(id: string): ProjectRecord | null {
    const row = this.db
      .prepare("SELECT id, name, preset, created_at AS createdAt FROM projects WHERE id = ?")
      .get(id) as ProjectRecord | undefined;
    return row ?? null;
  }

  /**
   * List all projects.
   */
  list(): ProjectRecord[] {
    return this.db
      .prepare("SELECT id, name, preset, created_at AS createdAt FROM projects ORDER BY created_at")
      .all() as ProjectRecord[];
  }

  /**
   * Get project count (for /health endpoint).
   */
  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS cnt FROM projects").get() as { cnt: number };
    return row.cnt;
  }

  close(): void {
    this.db.close();
  }
}
