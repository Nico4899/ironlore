import type { ProviderResolution } from "@ironlore/core";
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
      .get(projectId, slug) as
      | { status: string; max_runs_per_hour: number; max_runs_per_day: number }
      | undefined;

    if (!state) return { allowed: true }; // No state row → no constraints.

    // Check pause state.
    if (state.status === "paused") {
      return { allowed: false, reason: "agent is paused" };
    }

    // Check hourly rate limit. Only autonomous runs count: interactive
    // runs are user-initiated and shouldn't be rate-limited against
    // the heartbeat budget. The schema-migration default of
    // 'autonomous' means legacy rows still count, preserving prior
    // behavior on upgraded installs.
    const oneHourAgo = Date.now() - 3_600_000;
    const hourCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM agent_runs
           WHERE project_id = ? AND slug = ? AND started_at >= ? AND mode = 'autonomous'`,
        )
        .get(projectId, slug, oneHourAgo) as { cnt: number }
    ).cnt;

    if (hourCount >= state.max_runs_per_hour) {
      return {
        allowed: false,
        reason: `rate limited: ${hourCount}/${state.max_runs_per_hour} runs this hour`,
      };
    }

    // Check daily rate limit (autonomous-only, same reason as above).
    const oneDayAgo = Date.now() - 86_400_000;
    const dayCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM agent_runs
           WHERE project_id = ? AND slug = ? AND started_at >= ? AND mode = 'autonomous'`,
        )
        .get(projectId, slug, oneDayAgo) as { cnt: number }
    ).cnt;

    if (dayCount >= state.max_runs_per_day) {
      return {
        allowed: false,
        reason: `rate limited: ${dayCount}/${state.max_runs_per_day} runs today`,
      };
    }

    return { allowed: true };
  }

  /**
   * Record that a job started for an agent.
   *
   * Both modes get a row so the agent detail page's run history shows
   * user-driven activity alongside heartbeats. Rate-limit and
   * histogram queries scope to `mode = 'autonomous'` to preserve
   * their original budget semantics — see `canEnqueue` and
   * `getHourlyHistogram`.
   */
  recordStart(
    projectId: string,
    slug: string,
    jobId: string,
    mode: "interactive" | "autonomous" = "autonomous",
  ): void {
    this.db
      .prepare(
        "INSERT INTO agent_runs (project_id, slug, started_at, job_id, mode) VALUES (?, ?, ?, ?, ?)",
      )
      .run(projectId, slug, Date.now(), jobId, mode);
  }

  /**
   * Stamp the per-run provider resolution onto an existing
   * `agent_runs` row. No-op when the row doesn't exist (interactive
   * runs aren't tracked there); the AI panel surfaces those
   * resolutions live via WS event instead.
   *
   * Powers the AgentDetail page's "Run 0042: anthropic / sonnet-4 /
   * medium (from persona)" chip — the user can see at a glance which
   * level of the override chain decided each field.
   */
  recordResolution(jobId: string, resolution: ProviderResolution): void {
    this.db
      .prepare(
        `UPDATE agent_runs
         SET provider        = ?,
             model           = ?,
             effort          = ?,
             provider_source = ?,
             model_source    = ?,
             effort_source   = ?
         WHERE job_id = ?`,
      )
      .run(
        resolution.provider,
        resolution.model,
        resolution.effort,
        resolution.source.provider,
        resolution.source.model,
        resolution.source.effort,
        jobId,
      );
  }

  /**
   * Record the outcome of a job. On failure, increment the failure
   * streak and auto-pause if the threshold is reached. On success,
   * reset the streak.
   */
  recordOutcome(projectId: string, slug: string, succeeded: boolean): void {
    const now = Date.now();

    // Ensure the state row exists — custom agents (not seeded by
    // seed-agents.ts) need a row to accumulate failure_streak against.
    this.ensureState(projectId, slug);

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
