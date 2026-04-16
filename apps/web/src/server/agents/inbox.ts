import { execSync } from "node:child_process";
import { join } from "node:path";
import type Database from "better-sqlite3";

/**
 * Agent Inbox — staging branches for review_mode: inbox runs.
 *
 * When an autonomous agent's persona declares `review_mode: inbox`,
 * the commit worker writes its commits to `agents/<slug>/<run-id>`
 * instead of `main`. On finalization, an inbox entry is created.
 * The user reviews via the Inbox UI:
 *
 *   - Approve all → fast-forward (or rebase clean) onto main, delete branch.
 *   - Reject all → delete branch without merging.
 *   - Partial approve → cherry-pick approved files, delete branch.
 *
 * See docs/02-storage-and-sync.md §Staging branches for inbox runs
 * and docs/09-ui-and-brand.md §Agent Inbox.
 */

export interface InboxEntry {
  id: string;
  projectId: string;
  agentSlug: string;
  branch: string;
  jobId: string;
  filesChanged: string[];
  startedAt: number;
  finalizedAt: number;
  status: "pending" | "approved" | "rejected" | "partial";
}

export class AgentInbox {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inbox_entries (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL,
        agent_slug   TEXT NOT NULL,
        branch       TEXT NOT NULL,
        job_id       TEXT NOT NULL,
        files_changed TEXT NOT NULL DEFAULT '[]',
        started_at   INTEGER NOT NULL,
        finalized_at INTEGER NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending'
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_inbox_project
      ON inbox_entries(project_id, status)
    `);
  }

  /**
   * Create a new inbox entry when an inbox-mode run finalizes.
   */
  createEntry(entry: Omit<InboxEntry, "status">): void {
    this.db
      .prepare(
        `INSERT INTO inbox_entries (id, project_id, agent_slug, branch, job_id, files_changed, started_at, finalized_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(
        entry.id,
        entry.projectId,
        entry.agentSlug,
        entry.branch,
        entry.jobId,
        JSON.stringify(entry.filesChanged),
        entry.startedAt,
        entry.finalizedAt,
      );
  }

  /**
   * Get all pending inbox entries for a project.
   */
  getPending(projectId: string): InboxEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM inbox_entries WHERE project_id = ? AND status = 'pending' ORDER BY finalized_at DESC")
      .all(projectId) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: r.id as string,
      projectId: r.project_id as string,
      agentSlug: r.agent_slug as string,
      branch: r.branch as string,
      jobId: r.job_id as string,
      filesChanged: JSON.parse((r.files_changed as string) || "[]") as string[],
      startedAt: r.started_at as number,
      finalizedAt: r.finalized_at as number,
      status: r.status as InboxEntry["status"],
    }));
  }

  /**
   * Approve all — fast-forward the staging branch onto main.
   */
  approveAll(entryId: string, projectDir: string): { success: boolean; error?: string } {
    const entry = this.getEntry(entryId);
    if (!entry) return { success: false, error: "Entry not found" };

    const gitDir = join(projectDir, ".git");
    try {
      // Try fast-forward merge first.
      execSync(
        `git --git-dir="${gitDir}" --work-tree="${projectDir}" merge --ff-only ${entry.branch}`,
        { encoding: "utf-8", stdio: "pipe" },
      );
      // Delete the staging branch.
      execSync(
        `git --git-dir="${gitDir}" --work-tree="${projectDir}" branch -d ${entry.branch}`,
        { encoding: "utf-8", stdio: "pipe" },
      );
      this.setStatus(entryId, "approved");
      return { success: true };
    } catch (err) {
      // Fast-forward failed — try rebase.
      try {
        execSync(
          `git --git-dir="${gitDir}" --work-tree="${projectDir}" rebase ${entry.branch}`,
          { encoding: "utf-8", stdio: "pipe" },
        );
        execSync(
          `git --git-dir="${gitDir}" --work-tree="${projectDir}" branch -d ${entry.branch}`,
          { encoding: "utf-8", stdio: "pipe" },
        );
        this.setStatus(entryId, "approved");
        return { success: true };
      } catch (rebaseErr) {
        // Abort failed rebase.
        try {
          execSync(
            `git --git-dir="${gitDir}" --work-tree="${projectDir}" rebase --abort`,
            { encoding: "utf-8", stdio: "pipe" },
          );
        } catch { /* already clean */ }
        return {
          success: false,
          error: rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr),
        };
      }
    }
  }

  /**
   * Reject all — delete the staging branch without merging.
   */
  rejectAll(entryId: string, projectDir: string): { success: boolean; error?: string } {
    const entry = this.getEntry(entryId);
    if (!entry) return { success: false, error: "Entry not found" };

    const gitDir = join(projectDir, ".git");
    try {
      execSync(
        `git --git-dir="${gitDir}" --work-tree="${projectDir}" branch -D ${entry.branch}`,
        { encoding: "utf-8", stdio: "pipe" },
      );
      this.setStatus(entryId, "rejected");
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private getEntry(id: string): InboxEntry | null {
    const row = this.db.prepare("SELECT * FROM inbox_entries WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      agentSlug: row.agent_slug as string,
      branch: row.branch as string,
      jobId: row.job_id as string,
      filesChanged: JSON.parse((row.files_changed as string) || "[]") as string[],
      startedAt: row.started_at as number,
      finalizedAt: row.finalized_at as number,
      status: row.status as InboxEntry["status"],
    };
  }

  private setStatus(id: string, status: InboxEntry["status"]): void {
    this.db.prepare("UPDATE inbox_entries SET status = ? WHERE id = ?").run(status, id);
  }
}
