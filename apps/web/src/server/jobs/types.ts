/**
 * Durable job queue types.
 *
 * The job queue is the backbone of Phase 4 — every agent run, every
 * cron heartbeat, every system task is a row in the `jobs` table.
 * Closing the browser never cancels work; the UI subscribes to
 * `job_events` via WebSocket but doesn't own state.
 *
 * See docs/05-jobs-and-security.md §Durable Jobs for the full design.
 */

export type JobStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  /**
   * Phase-11: an autonomous run submitted an async batch and
   * released its worker slot. The job is alive but parked until
   * the agent.batch_resume handler picks up its handle on a poll
   * tick. Distinct from `running` so the worker pool's atomic
   * claim can't double-dispatch a parked job.
   */
  | "batch_pending";
export type JobMode = "interactive" | "autonomous";
export type JobKind =
  | "agent.run"
  | "agent.batch_resume"
  | "cron.tick"
  | "reindex"
  | "lint"
  | string;

export interface JobRow {
  id: string;
  project_id: string;
  kind: JobKind;
  mode: JobMode;
  owner_id: string | null;
  payload: string;
  status: JobStatus;
  lease_until: number | null;
  worker_id: string | null;
  attempts: number;
  max_attempts: number;
  scheduled_at: number;
  started_at: number | null;
  finished_at: number | null;
  result: string | null;
  commit_sha_start: string | null;
  commit_sha_end: string | null;
  /**
   * Persisted async-batch handle JSON; only set while the row is
   * in `status='batch_pending'`. Shape: `BatchHandlePersisted`.
   */
  batch_handle: string | null;
  /**
   * Phase-11 Airlock forensic audit trail. JSON `{reason, at}` for
   * runs whose egress got downgraded by a cross-project
   * `kb.global_search` hit; null otherwise. Set by the worker
   * pool's `markEgressDowngraded` hook from the executor's
   * downgrade callback. The actual enforcement still lives in the
   * in-memory `AirlockSession`; this column exists so an
   * incident-response query can find every tainted run without
   * replaying `job_events`.
   */
  egress_downgraded: string | null;
  created_at: number;
}

/**
 * Subset of the in-memory `BatchHandle` that's persisted to the
 * jobs.batch_handle column. The `agent.batch_resume` handler
 * rebuilds the upstream call from these fields. Held lean
 * deliberately — request bodies are not stored, only the
 * provider-side identifiers needed to poll + the run-context
 * identifiers needed to emit events on the original job.
 */
export interface BatchHandlePersisted {
  /** Provider that issued the batch. Reads as a `ProviderId` after
   *  parse — typed as plain string here to keep the jobs module
   *  free of provider-layer imports (the resume handler casts when
   *  reconstructing the in-memory `BatchHandle`). */
  provider: string;
  batchId: string;
  requestId: string;
  model: string;
  agentSlug: string;
}

export interface JobEventRow {
  id: number;
  project_id: string;
  job_id: string;
  seq: number;
  ts: number;
  kind: string;
  data: string;
}

export type AgentStatus = "active" | "paused";
export type PauseReason = "failure_streak" | "user" | null;

export interface AgentStateRow {
  project_id: string;
  slug: string;
  status: AgentStatus;
  max_runs_per_hour: number;
  max_runs_per_day: number;
  failure_streak: number;
  pause_reason: PauseReason;
  updated_at: number;
}

export interface AgentRunRow {
  project_id: string;
  slug: string;
  started_at: number;
  job_id: string;
}

/**
 * Handler signature for a job kind. The worker calls this when
 * picking up a job. The handler receives the parsed payload and
 * a context bag with the project-scoped infrastructure.
 */
export type JobHandler = (job: JobRow, ctx: JobContext) => Promise<JobResult>;

export interface JobContext {
  projectId: string;
  workerId: string;
  /** Append an event to the durable job_events stream. */
  emitEvent(kind: string, data: unknown): void;
  /**
   * Phase-11 Airlock forensic hook — handler calls this when the
   * run's egress gets downgraded by a cross-project hit. Worker
   * pool persists the payload to `jobs.egress_downgraded` so an
   * incident-response query can find every tainted run by SELECT
   * rather than replaying `job_events`. First reason wins.
   */
  markEgressDowngraded(payload: { reason: string | null; at: string | null }): void;
  /** Signal that this job should be cancelled (cooperative). */
  signal: AbortSignal;
}

export interface JobResult {
  /**
   * Terminal job outcomes (`done` / `failed`) finalize the row.
   * `batch_pending` is non-terminal: the worker pool persists
   * `batchHandle`, releases the slot, and enqueues an
   * `agent.batch_resume` job to poll the upstream batch later.
   */
  status: "done" | "failed" | "batch_pending";
  result?: string;
  /** Required when `status === "batch_pending"`. */
  batchHandle?: BatchHandlePersisted;
  /**
   * Override the resume scheduling delay (ms). Defaults to the
   * worker pool's `BATCH_RESUME_DELAY_MS`. Tests use a tight
   * value (1–5 ms) to exercise the loop without sleeping.
   */
  batchResumeDelayMs?: number;
}
