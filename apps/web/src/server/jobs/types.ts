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

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type JobMode = "interactive" | "autonomous";
export type JobKind = "agent.run" | "cron.tick" | "reindex" | "lint" | string;

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
  created_at: number;
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
  /** Signal that this job should be cancelled (cooperative). */
  signal: AbortSignal;
}

export interface JobResult {
  status: "done" | "failed";
  result?: string;
}
