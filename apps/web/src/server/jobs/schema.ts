import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/**
 * Initialize the jobs database at the given path.
 *
 * Creates all tables idempotently (IF NOT EXISTS). The database lives
 * at the install root, NOT per-project — the worker pool is shared
 * across projects and each job row carries its own `project_id`.
 *
 * Schema mirrors docs/05-jobs-and-security.md §Durable Jobs verbatim.
 */
export function openJobsDb(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  initSchema(db);
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      kind            TEXT NOT NULL,
      mode            TEXT NOT NULL DEFAULT 'autonomous',
      owner_id        TEXT,
      payload         TEXT NOT NULL DEFAULT '{}',
      status          TEXT NOT NULL DEFAULT 'queued',
      lease_until     INTEGER,
      worker_id       TEXT,
      attempts        INTEGER NOT NULL DEFAULT 0,
      max_attempts    INTEGER NOT NULL DEFAULT 3,
      scheduled_at    INTEGER NOT NULL,
      started_at      INTEGER,
      finished_at     INTEGER,
      result          TEXT,
      commit_sha_start TEXT,
      commit_sha_end   TEXT,
      created_at      INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_jobs_due
    ON jobs(status, scheduled_at)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_jobs_project
    ON jobs(project_id, status)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS job_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  TEXT NOT NULL,
      job_id      TEXT NOT NULL,
      seq         INTEGER NOT NULL,
      ts          INTEGER NOT NULL,
      kind        TEXT NOT NULL,
      data        TEXT NOT NULL DEFAULT '{}'
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_job_events_job
    ON job_events(job_id, seq)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_state (
      project_id        TEXT NOT NULL,
      slug              TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'active',
      max_runs_per_hour INTEGER NOT NULL DEFAULT 10,
      max_runs_per_day  INTEGER NOT NULL DEFAULT 50,
      failure_streak    INTEGER NOT NULL DEFAULT 0,
      pause_reason      TEXT,
      updated_at        INTEGER NOT NULL,
      PRIMARY KEY (project_id, slug)
    )
  `);

  // Phase 11: `last_heartbeat_at` added by the heartbeat scheduler to
  // prevent double-fires across ticks and server restarts. Additive
  // migration so upgraded installs pick it up without a schema
  // rewrite. Mirrors the `inbox_entries.file_decisions` pattern.
  const agentStateCols = db.prepare("PRAGMA table_info(agent_state)").all() as Array<{
    name: string;
  }>;
  if (!agentStateCols.some((c) => c.name === "last_heartbeat_at")) {
    db.exec("ALTER TABLE agent_state ADD COLUMN last_heartbeat_at INTEGER");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      project_id  TEXT NOT NULL,
      slug        TEXT NOT NULL,
      started_at  INTEGER NOT NULL,
      job_id      TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_runs_window
    ON agent_runs(project_id, slug, started_at)
  `);
}
