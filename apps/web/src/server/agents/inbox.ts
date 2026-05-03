import { execFileSync, execSync } from "node:child_process";
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
  /**
   * `stale` is set when the staging branch has been deleted out of
   * band (manual cleanup, prior reject, history rewrite). Without
   * this state the entry would sit forever as `pending`; approve /
   * reject would fail with raw git errors. `entryExists()` reads
   * the branch on demand and demotes to `stale` when it's gone.
   */
  status: "pending" | "approved" | "rejected" | "partial" | "stale";
}

/** Per-file user decision captured during inbox review. */
export type InboxFileDecision = "approved" | "rejected";
/** Map of path → decision. Paths without an entry are undecided. */
export type InboxFileDecisions = Record<string, InboxFileDecision>;

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

    // Additive migration: `file_decisions` JSON column holds per-file
    //  approve/reject decisions the user makes during review. Older
    //  rows get '{}' as the default. Use PRAGMA to detect the column
    //  rather than swallowing errors from a redundant ALTER.
    const cols = this.db.prepare("PRAGMA table_info(inbox_entries)").all() as Array<{
      name: string;
    }>;
    if (!cols.some((c) => c.name === "file_decisions")) {
      this.db.exec(
        "ALTER TABLE inbox_entries ADD COLUMN file_decisions TEXT NOT NULL DEFAULT '{}'",
      );
    }
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
      .prepare(
        "SELECT * FROM inbox_entries WHERE project_id = ? AND status = 'pending' ORDER BY finalized_at DESC",
      )
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
   * Approve all — merge the staging branch into main.
   *
   * Tries a fast-forward merge first (clean when main hasn't moved
   * since the branch was created). Falls back to a non-ff merge
   * commit when main has diverged but the branches compose cleanly.
   * Aborts on conflict so the repo stays clean for the next run.
   *
   * The pre-fix version tried `git rebase <branch>` as a fallback,
   * which rebases main ONTO the staging branch (backwards direction
   * — staging's commits vanish from view, main's commits get
   * replayed on top of staging's). Replaced with a proper merge
   * fallback that actually lands the agent's work on main.
   */
  approveAll(entryId: string, projectDir: string): { success: boolean; error?: string } {
    const entry = this.getEntry(entryId);
    if (!entry) return { success: false, error: "Entry not found" };

    // Pre-flight branch check: a pending entry whose branch has
    // already been deleted (manual cleanup, history rewrite, the
    // user ran reject from a different surface) used to fail with
    // raw git stderr like `merge: agents/.../X - not something we
    // can merge`. Demote to 'stale' and return a structured error.
    if (!this.branchExists(projectDir, entry.branch)) {
      this.setStatus(entryId, "stale");
      return {
        success: false,
        error: `Staging branch '${entry.branch}' no longer exists; entry marked stale.`,
      };
    }

    const gitDir = join(projectDir, ".git");
    const decisions = this.getFileDecisions(entryId);
    const rejected = Object.entries(decisions)
      .filter(([, d]) => d === "rejected")
      .map(([p]) => p);

    // Fast path: no rejections → merge the whole branch (fast-forward,
    //  then a merge commit if main has diverged). This is the shape
    //  the original approveAll shipped with.
    if (rejected.length === 0) {
      try {
        execSync(
          `git --git-dir="${gitDir}" --work-tree="${projectDir}" merge --ff-only ${entry.branch}`,
          { encoding: "utf-8", stdio: "pipe" },
        );
        execSync(
          `git --git-dir="${gitDir}" --work-tree="${projectDir}" branch -d ${entry.branch}`,
          { encoding: "utf-8", stdio: "pipe" },
        );
        this.setStatus(entryId, "approved");
        return { success: true };
      } catch {
        // Fast-forward failed (main diverged). Fall back to a merge
        // commit that lands the agent work without rewriting history.
        try {
          execSync(
            `git --git-dir="${gitDir}" --work-tree="${projectDir}" merge --no-ff --no-edit ${entry.branch}`,
            { encoding: "utf-8", stdio: "pipe" },
          );
          execSync(
            `git --git-dir="${gitDir}" --work-tree="${projectDir}" branch -d ${entry.branch}`,
            { encoding: "utf-8", stdio: "pipe" },
          );
          this.setStatus(entryId, "approved");
          return { success: true };
        } catch (mergeErr) {
          // Conflict — abort so the repo is clean and the user can
          // resolve manually (or retry later once main stabilizes).
          try {
            execSync(`git --git-dir="${gitDir}" --work-tree="${projectDir}" merge --abort`, {
              encoding: "utf-8",
              stdio: "pipe",
            });
          } catch {
            /* already clean */
          }
          return {
            success: false,
            error: mergeErr instanceof Error ? mergeErr.message : String(mergeErr),
          };
        }
      }
    }

    // Partial approve: the user marked ≥1 file as rejected, so we
    //  can't do a plain branch merge. Checkout each non-rejected
    //  changed file from the staging branch into main's working tree,
    //  stage it, commit once. Files not mentioned at all in the diff
    //  are left alone. Rejected files keep main's current version.
    const rejectedSet = new Set(rejected);
    const diff = this.getFileDiffStats(entryId, projectDir);
    const toApply = diff.filter((f) => !rejectedSet.has(f.path));

    if (toApply.length === 0) {
      // Everything was rejected — same net outcome as rejectAll.
      return this.rejectAll(entryId, projectDir);
    }

    const gitCmd = `git --git-dir="${gitDir}" --work-tree="${projectDir}"`;
    try {
      for (const f of toApply) {
        if (f.status === "D") {
          // The agent deleted the file on its branch; replay that
          //  deletion on main. `git rm` handles both staging the
          //  removal and clearing the working tree.
          execSync(`${gitCmd} rm --ignore-unmatch -- "${f.path}"`, {
            encoding: "utf-8",
            stdio: "pipe",
          });
        } else {
          execSync(`${gitCmd} checkout ${entry.branch} -- "${f.path}"`, {
            encoding: "utf-8",
            stdio: "pipe",
          });
          execSync(`${gitCmd} add -- "${f.path}"`, { encoding: "utf-8", stdio: "pipe" });
        }
      }
      const msg = `Approve ${toApply.length}/${diff.length} from ${entry.branch}`;
      execSync(`${gitCmd} commit --no-verify -m "${msg}"`, {
        encoding: "utf-8",
        stdio: "pipe",
      });
      // Branch may still be around for archaeology — delete with -D
      //  because the user didn't full-merge it and -d would refuse.
      execSync(`${gitCmd} branch -D ${entry.branch}`, { encoding: "utf-8", stdio: "pipe" });
      this.setStatus(entryId, "partial");
      return { success: true };
    } catch (cherryErr) {
      // Leave the working tree in whatever state the loop produced;
      //  the user can inspect and either retry or reset manually.
      return {
        success: false,
        error: cherryErr instanceof Error ? cherryErr.message : String(cherryErr),
      };
    }
  }

  /**
   * Reject all — delete the staging branch without merging.
   */
  rejectAll(entryId: string, projectDir: string): { success: boolean; error?: string } {
    const entry = this.getEntry(entryId);
    if (!entry) return { success: false, error: "Entry not found" };

    // Pre-flight: if the branch is already gone the user effectively
    // rejected this entry through some other surface. Mark it
    // resolved and return a friendly message — a raw git stderr
    // ("error: branch '...' not found") used to leak through.
    if (!this.branchExists(projectDir, entry.branch)) {
      this.setStatus(entryId, "stale");
      return {
        success: false,
        error: `Staging branch '${entry.branch}' no longer exists; entry marked stale.`,
      };
    }

    const gitDir = join(projectDir, ".git");
    try {
      execSync(`git --git-dir="${gitDir}" --work-tree="${projectDir}" branch -D ${entry.branch}`, {
        encoding: "utf-8",
        stdio: "pipe",
      });
      this.setStatus(entryId, "rejected");
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Per-file diff stats for the entry's staging branch vs. the current
   * merge base with main. Returns one row per touched file with its
   * status (`A`dded / `D`eleted / `M`odified / `R`enamed) plus
   * line-delta counts and the user's review decision (if any).
   * Consumed by the Inbox UI's per-file row grammar
   * (docs/09-ui-and-brand.md §Agent Inbox: `A  engineering/arch.md  +3 -2`).
   *
   * Runs two git calls because `--name-status` and `--numstat` each
   * give half the answer; merging on file path yields the full row.
   * The diff is computed live — staging branches can move under the
   * entry (the agent keeps writing), so a snapshot stored at
   * finalization would go stale.
   *
   * Binary files report `-` counts from numstat; we surface those as
   * `null` rather than zero so the UI can render "binary" rather
   * than a misleading "+0 -0".
   */
  getFileDiffStats(
    entryId: string,
    projectDir: string,
  ): Array<{
    path: string;
    status: "A" | "D" | "M" | "R" | "?";
    added: number | null;
    removed: number | null;
    decision: InboxFileDecision | null;
  }> {
    const entry = this.getEntry(entryId);
    if (!entry) return [];

    const gitDir = join(projectDir, ".git");
    const rangeArg = `main...${entry.branch}`;

    type Row = {
      path: string;
      status: "A" | "D" | "M" | "R" | "?";
      added: number | null;
      removed: number | null;
      decision: InboxFileDecision | null;
    };
    const byPath = new Map<string, Row>();
    const decisions = this.getFileDecisions(entryId);

    // Name-status: first column is the letter, second is the path.
    // Rename records emit an extra "new path" column we preserve as the
    // canonical row path.
    try {
      const nameStatus = execSync(
        `git --git-dir="${gitDir}" --work-tree="${projectDir}" diff --name-status ${rangeArg}`,
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
      );
      for (const line of nameStatus.split("\n")) {
        if (!line.trim()) continue;
        const parts = line.split("\t");
        const raw = parts[0] ?? "";
        // Rename statuses look like "R090" — normalize to just "R".
        const letter = raw.startsWith("R")
          ? "R"
          : raw === "A" || raw === "D" || raw === "M"
            ? raw
            : "?";
        const path = (parts.length === 3 ? parts[2] : parts[1]) ?? "";
        if (!path) continue;
        byPath.set(path, {
          path,
          status: letter as Row["status"],
          added: 0,
          removed: 0,
          decision: decisions[path] ?? null,
        });
      }
    } catch {
      // Branch missing or git failure — return an empty list rather
      // than a partial one so the UI shows the honest "no data" state.
      return [];
    }

    try {
      const numStat = execSync(
        `git --git-dir="${gitDir}" --work-tree="${projectDir}" diff --numstat ${rangeArg}`,
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
      );
      for (const line of numStat.split("\n")) {
        if (!line.trim()) continue;
        const [addedRaw, removedRaw, path] = line.split("\t");
        if (!path) continue;
        const existing: Row = byPath.get(path) ?? {
          path,
          status: "M" as Row["status"],
          added: 0,
          removed: 0,
          decision: decisions[path] ?? null,
        };
        existing.added = addedRaw === "-" ? null : Number.parseInt(addedRaw ?? "0", 10);
        existing.removed = removedRaw === "-" ? null : Number.parseInt(removedRaw ?? "0", 10);
        byPath.set(path, existing);
      }
    } catch {
      // Numstat failed — keep whatever name-status returned with zero
      // deltas. Callers will render "?" instead of "+N -M".
    }

    return Array.from(byPath.values());
  }

  /**
   * Unified git diff for a single file within a pending inbox entry.
   *
   * Powers the Inbox expand-on-click dropdown: the UI shows stats via
   * `getFileDiffStats`, and — when the user expands an entry — fetches
   * the full `git diff main...<branch> -- <path>` so they can review
   * the actual change before approving.
   *
   * Path is validated against the entry's file list first so a
   * hostile `path` query parameter can't reach outside the diff
   * surface. We use `execFileSync` (not `execSync`) so nothing is
   * interpreted by a shell — paths with spaces or quotes in their
   * names round-trip cleanly.
   *
   * Returns `null` when the entry or path is invalid, or when git
   * reports an error (branch missing, etc.).
   */
  getFileDiff(entryId: string, path: string, projectDir: string): string | null {
    const entry = this.getEntry(entryId);
    if (!entry) return null;

    // Validate: only paths that appear in the entry's own file list
    //  are allowed through. Cheap belt + suspenders against a client
    //  passing an arbitrary path.
    const stats = this.getFileDiffStats(entryId, projectDir);
    if (!stats.some((f) => f.path === path)) return null;

    const gitDir = join(projectDir, ".git");
    const rangeArg = `main...${entry.branch}`;
    try {
      const buf = execFileSync(
        "git",
        [
          `--git-dir=${gitDir}`,
          `--work-tree=${projectDir}`,
          "diff",
          "--no-color",
          rangeArg,
          "--",
          path,
        ],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 },
      );
      return buf;
    } catch {
      return null;
    }
  }

  /**
   * Read the per-file decision map for an entry. Empty object when
   * the entry is missing or the JSON column is corrupt (never
   * throws — the UI treats an empty map as "all pending").
   */
  getFileDecisions(entryId: string): InboxFileDecisions {
    const row = this.db
      .prepare("SELECT file_decisions FROM inbox_entries WHERE id = ?")
      .get(entryId) as { file_decisions: string } | undefined;
    if (!row) return {};
    try {
      const parsed = JSON.parse(row.file_decisions) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const out: InboxFileDecisions = {};
        for (const [path, decision] of Object.entries(parsed as Record<string, unknown>)) {
          if (decision === "approved" || decision === "rejected") out[path] = decision;
        }
        return out;
      }
    } catch {
      /* fall through to {} */
    }
    return {};
  }

  /**
   * Record (or clear) a per-file decision. `null` removes the row's
   * path from the decision map so the file falls back to the bulk
   * approve/reject behavior when the user commits.
   */
  setFileDecision(
    entryId: string,
    path: string,
    decision: InboxFileDecision | null,
  ): { success: boolean; error?: string } {
    const row = this.db
      .prepare("SELECT file_decisions FROM inbox_entries WHERE id = ?")
      .get(entryId) as { file_decisions: string } | undefined;
    if (!row) return { success: false, error: "Entry not found" };

    const decisions = this.getFileDecisions(entryId);
    if (decision === null) {
      delete decisions[path];
    } else {
      decisions[path] = decision;
    }
    this.db
      .prepare("UPDATE inbox_entries SET file_decisions = ? WHERE id = ?")
      .run(JSON.stringify(decisions), entryId);
    return { success: true };
  }

  /**
   * Existence check the API layer uses to return 404 for bogus IDs.
   *
   * When `projectDir` is supplied we additionally verify the entry's
   * staging branch still exists in the project repo. If the row is
   * still `pending` but the branch is gone (manual cleanup, prior
   * reject, history rewrite), we demote the row to `'stale'` and
   * return false — so the API surfaces a 404 instead of letting the
   * approve/reject handler fail with a raw git error like
   * `branch '...' not found`. Without `projectDir` (e.g. the file
   * decision endpoint that doesn't need branch state), we do the
   * row-only check the audit's Bug D fix introduced.
   */
  entryExists(id: string, projectDir?: string): boolean {
    const row = this.db.prepare("SELECT branch, status FROM inbox_entries WHERE id = ?").get(id) as
      | { branch: string; status: InboxEntry["status"] }
      | undefined;
    if (!row) return false;
    // `stale` is a tombstone status — the row exists but the branch
    // is gone and there's nothing meaningful to do with it. Treat
    // it the same as a missing row so /files / /diff / /decision
    // all 404 cleanly.
    if (row.status === "stale") return false;
    if (!projectDir) return true;
    // Resolved entries (approved/rejected/partial) — the branch may
    // legitimately be gone (the resolution itself deleted it).
    if (row.status !== "pending") return true;
    if (this.branchExists(projectDir, row.branch)) return true;
    // Pending row + missing branch → demote to stale so the next
    // listing skips it and approve/reject return 404.
    this.setStatus(id, "stale");
    return false;
  }

  /**
   * Sweep all `pending` entries and demote any whose staging branch
   * has been deleted to `'stale'`. Run on startup (and optionally on
   * a tick) so listings stay clean without waiting for a request to
   * trip the per-entry check.
   *
   * Returns the count of entries promoted to stale.
   */
  pruneStaleEntries(projectId: string, projectDir: string): number {
    const rows = this.db
      .prepare("SELECT id, branch FROM inbox_entries WHERE project_id = ? AND status = 'pending'")
      .all(projectId) as Array<{ id: string; branch: string }>;
    let demoted = 0;
    for (const row of rows) {
      if (!this.branchExists(projectDir, row.branch)) {
        this.setStatus(row.id, "stale");
        demoted++;
      }
    }
    return demoted;
  }

  private branchExists(projectDir: string, branch: string): boolean {
    const gitDir = join(projectDir, ".git");
    try {
      // `--verify` exits non-zero when the ref doesn't exist; we
      // discard stderr so a missing branch is silent (it's the
      // expected path here).
      execSync(
        `git --git-dir="${gitDir}" --work-tree="${projectDir}" rev-parse --verify --quiet refs/heads/${branch}`,
        { encoding: "utf-8", stdio: "pipe" },
      );
      return true;
    } catch {
      return false;
    }
  }

  private getEntry(id: string): InboxEntry | null {
    const row = this.db.prepare("SELECT * FROM inbox_entries WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
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
