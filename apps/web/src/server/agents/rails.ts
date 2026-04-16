import type Database from "better-sqlite3";

/**
 * Agent safety rails — auto-pause and run-rate limits.
 *
 * These sit between the job dispatcher and the worker pool. Before
 * enqueuing a heartbeat the dispatcher calls `canEnqueue()`. After a
 * job completes the worker calls `recordOutcome()`.
 *
 * See docs/04-ai-and-agents.md §Heartbeats and run-rate limits and
 * docs/05-jobs-and-security.md §Safety rails.
 */

const DEFAULT_FAILURE_THRESHOLD = 3;

export class AgentRails {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Check whether a heartbeat can be enqueued for this agent.
   * Returns `{ allowed: true }` or `{ allowed: false, reason }`.
   */
  canEnqueue(
    projectId: string,
    slug: string,
  ): { allowed: true } | { allowed: false; reason: string } {
    const state = this.db
      .prepare("SELECT * FROM agent_state WHERE project_id = ? AND slug = ?")
      .get(projectId, slug) as { status: string; max_runs_per_hour: number; max_runs_per_day: number } | undefined;

    if (!state) return { allowed: true }; // No state row → no constraints.

    // Check pause state.
    if (state.status === "paused") {
      return { allowed: false, reason: "agent is paused" };
    }

    // Check hourly rate limit.
    const oneHourAgo = Date.now() - 3_600_000;
    const hourCount = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS cnt FROM agent_runs WHERE project_id = ? AND slug = ? AND started_at >= ?",
        )
        .get(projectId, slug, oneHourAgo) as { cnt: number }
    ).cnt;

    if (hourCount >= state.max_runs_per_hour) {
      return { allowed: false, reason: `rate limited: ${hourCount}/${state.max_runs_per_hour} runs this hour` };
    }

    // Check daily rate limit.
    const oneDayAgo = Date.now() - 86_400_000;
    const dayCount = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS cnt FROM agent_runs WHERE project_id = ? AND slug = ? AND started_at >= ?",
        )
        .get(projectId, slug, oneDayAgo) as { cnt: number }
    ).cnt;

    if (dayCount >= state.max_runs_per_day) {
      return { allowed: false, reason: `rate limited: ${dayCount}/${state.max_runs_per_day} runs today` };
    }

    return { allowed: true };
  }

  /**
   * Record that a job started for an agent (for rate-limit tracking).
   */
  recordStart(projectId: string, slug: string, jobId: string): void {
    this.db
      .prepare("INSERT INTO agent_runs (project_id, slug, started_at, job_id) VALUES (?, ?, ?, ?)")
      .run(projectId, slug, Date.now(), jobId);
  }

  /**
   * Record the outcome of a job. On failure, increment the failure
   * streak and auto-pause if the threshold is reached. On success,
   * reset the streak.
   */
  recordOutcome(projectId: string, slug: string, succeeded: boolean): void {
    const now = Date.now();

    if (succeeded) {
      this.db
        .prepare(
          `UPDATE agent_state SET failure_streak = 0, updated_at = ?
           WHERE project_id = ? AND slug = ?`,
        )
        .run(now, projectId, slug);
      return;
    }

    // Failure: increment streak.
    this.db
      .prepare(
        `UPDATE agent_state SET failure_streak = failure_streak + 1, updated_at = ?
         WHERE project_id = ? AND slug = ?`,
      )
      .run(now, projectId, slug);

    // Check if we've hit the threshold.
    const state = this.db
      .prepare("SELECT failure_streak FROM agent_state WHERE project_id = ? AND slug = ?")
      .get(projectId, slug) as { failure_streak: number } | undefined;

    if (state && state.failure_streak >= DEFAULT_FAILURE_THRESHOLD) {
      this.db
        .prepare(
          `UPDATE agent_state SET status = 'paused', pause_reason = 'failure_streak', updated_at = ?
           WHERE project_id = ? AND slug = ?`,
        )
        .run(now, projectId, slug);
    }
  }

  /**
   * Manually pause or resume an agent. Used by the "Pause this agent"
   * button on the agent home page.
   */
  setPauseState(projectId: string, slug: string, paused: boolean): void {
    const now = Date.now();
    if (paused) {
      this.db
        .prepare(
          `UPDATE agent_state SET status = 'paused', pause_reason = 'user', updated_at = ?
           WHERE project_id = ? AND slug = ?`,
        )
        .run(now, projectId, slug);
    } else {
      this.db
        .prepare(
          `UPDATE agent_state SET status = 'active', pause_reason = NULL, failure_streak = 0, updated_at = ?
           WHERE project_id = ? AND slug = ?`,
        )
        .run(now, projectId, slug);
    }
  }

  /**
   * Ensure an agent_state row exists for a given agent.
   */
  ensureState(projectId: string, slug: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO agent_state (project_id, slug, status, updated_at)
         VALUES (?, ?, 'active', ?)`,
      )
      .run(projectId, slug, Date.now());
  }
}
