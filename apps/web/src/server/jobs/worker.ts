import { randomBytes } from "node:crypto";
import { ulid } from "@ironlore/core";
import type Database from "better-sqlite3";
import type { BatchHandlePersisted, JobContext, JobHandler, JobResult, JobRow } from "./types.js";

/**
 * In-process worker pool.
 *
 * Polls the `jobs` table for queued work, acquires a lease via an
 * atomic UPDATE, and dispatches to the registered handler for the
 * job's `kind`. Leases are renewed periodically so a long-running
 * agent heartbeat (30+ min) doesn't expire while the worker is
 * healthy. An expired lease means the worker crashed — the job
 * returns to `queued` on the next poll cycle.
 *
 * Concurrency is bounded by `maxParallel` and further constrained
 * per-provider by the adaptive backpressure layer (wired in Step 6).
 */

const POLL_INTERVAL_MS = 1_000;
const LEASE_DURATION_MS = 30_000;
const LEASE_RENEW_MS = 10_000;
/**
 * Default delay between an `agent.run` returning `batch_pending`
 * and the first `agent.batch_resume` tick. 5 s matches the
 * historical in-process polling cadence — long enough that a fast
 * batch is still ready by the first poll, short enough that
 * humans don't notice. Overridable per result via
 * `JobResult.batchResumeDelayMs` (tests inject 1 ms).
 */
const BATCH_RESUME_DELAY_MS = 5_000;

export class WorkerPool {
  private db: Database.Database;
  private workerId: string;
  private handlers = new Map<string, JobHandler>();
  private maxParallel: number;
  private activeJobs = new Map<
    string,
    { controller: AbortController; renewTimer: ReturnType<typeof setInterval> }
  >();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private seqCounters = new Map<string, number>();

  constructor(db: Database.Database, opts?: { maxParallel?: number }) {
    this.db = db;
    this.workerId = `worker-${randomBytes(4).toString("hex")}`;
    this.maxParallel = opts?.maxParallel ?? 20;
  }

  /** Register a handler for a job kind. */
  register(kind: string, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  /** Start the poll loop. */
  start(): void {
    this.stopped = false;
    // Reclaim any expired leases on startup (from a prior crash).
    this.reclaimExpiredLeases();
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    if (this.pollTimer.unref) this.pollTimer.unref();
  }

  /** Stop polling and cancel all active jobs. */
  stop(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const [, { controller, renewTimer }] of this.activeJobs) {
      controller.abort();
      clearInterval(renewTimer);
    }
    this.activeJobs.clear();
  }

  /** Number of currently-running jobs. */
  get activeCount(): number {
    return this.activeJobs.size;
  }

  /** Enqueue a new job. Returns the job ID. */
  enqueue(opts: {
    projectId: string;
    kind: string;
    mode?: "interactive" | "autonomous";
    ownerId?: string;
    payload?: unknown;
    scheduledAt?: number;
    maxAttempts?: number;
  }): string {
    const id = ulid();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO jobs (id, project_id, kind, mode, owner_id, payload, status, scheduled_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        id,
        opts.projectId,
        opts.kind,
        opts.mode ?? "autonomous",
        opts.ownerId ?? null,
        JSON.stringify(opts.payload ?? {}),
        opts.scheduledAt ?? now,
        now,
      );
    return id;
  }

  /** Get a job by ID. */
  getJob(jobId: string): JobRow | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
  }

  /** Get events for a job, optionally since a sequence number. */
  getJobEvents(jobId: string, sinceSeq = 0): Array<{ seq: number; kind: string; data: string }> {
    return this.db
      .prepare("SELECT seq, kind, data FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq")
      .all(jobId, sinceSeq) as Array<{ seq: number; kind: string; data: string }>;
  }

  // ─── Internal ────────────────────────────────────────────────────

  private poll(): void {
    if (this.stopped) return;

    // Reclaim expired leases every poll cycle. In single-process
    // deployments a crash is handled by the startup-time reclaim,
    // but a worker that simply falls over mid-run (OOM, killed
    // child process, bug that escapes the handler promise) can
    // leave a job stuck in `status='running'` forever without
    // this periodic sweep. The query is cheap — no rows match
    // most of the time.
    this.reclaimExpiredLeases();

    if (this.activeJobs.size >= this.maxParallel) return;

    const now = Date.now();

    // Atomic claim: UPDATE + WHERE filters ensure no double-dispatch.
    const claimed = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'running',
             lease_until = ?,
             worker_id = ?,
             started_at = COALESCE(started_at, ?),
             attempts = attempts + 1
         WHERE id = (
           SELECT id FROM jobs
           WHERE status = 'queued' AND scheduled_at <= ?
           ORDER BY scheduled_at
           LIMIT 1
         )
         RETURNING *`,
      )
      .get(now + LEASE_DURATION_MS, this.workerId, now, now) as JobRow | undefined;

    if (!claimed) return;

    const handler = this.handlers.get(claimed.kind);
    if (!handler) {
      // No handler registered — fail immediately.
      this.db
        .prepare("UPDATE jobs SET status = 'failed', result = ?, finished_at = ? WHERE id = ?")
        .run(JSON.stringify({ error: `No handler for kind: ${claimed.kind}` }), now, claimed.id);
      return;
    }

    this.runJob(claimed, handler);
  }

  private runJob(job: JobRow, handler: JobHandler): void {
    const controller = new AbortController();

    // Renew the lease periodically so long-running jobs survive.
    const renewTimer = setInterval(() => {
      if (this.stopped) return;
      const now = Date.now();
      this.db
        .prepare("UPDATE jobs SET lease_until = ? WHERE id = ? AND worker_id = ?")
        .run(now + LEASE_DURATION_MS, job.id, this.workerId);
    }, LEASE_RENEW_MS);

    this.activeJobs.set(job.id, { controller, renewTimer });

    const ctx: JobContext = {
      projectId: job.project_id,
      workerId: this.workerId,
      emitEvent: (kind, data) => this.appendEvent(job.project_id, job.id, kind, data),
      markEgressDowngraded: (payload) => this.markEgressDowngraded(job.id, payload),
      signal: controller.signal,
    };

    // Run the handler asynchronously.
    handler(job, ctx)
      .then((result) => this.completeJob(job.id, result))
      .catch((err) => this.completeJob(job.id, { status: "failed", result: String(err) }));
  }

  private completeJob(jobId: string, result: JobResult): void {
    const now = Date.now();
    if (result.status === "batch_pending") {
      this.parkBatchPending(jobId, result, now);
      return;
    }
    this.db
      .prepare(
        "UPDATE jobs SET status = ?, result = ?, finished_at = ?, lease_until = NULL WHERE id = ?",
      )
      .run(result.status, result.result ?? null, now, jobId);

    const active = this.activeJobs.get(jobId);
    if (active) {
      clearInterval(active.renewTimer);
      this.activeJobs.delete(jobId);
    }
  }

  /**
   * Phase-11 batch path. The original `agent.run` job returned
   * `batch_pending` because it submitted an async batch and
   * doesn't want to hold its worker slot for the full upstream
   * latency. Persist the handle, drop the lease, free the slot,
   * and enqueue a delayed `agent.batch_resume` job that will poll
   * the upstream and finalize the original.
   *
   * The original row stays in `status='batch_pending'` (distinct
   * from `running`) so the atomic claim in `poll()` can never
   * pick it up again — a second worker that scans for queued
   * jobs won't see this row at all.
   */
  private parkBatchPending(jobId: string, result: JobResult, now: number): void {
    if (!result.batchHandle) {
      // Defensive — handler returned the new status without the
      // payload. Treat as a hard failure rather than parking
      // forever, otherwise the row leaks slots in the dashboard.
      this.db
        .prepare(
          "UPDATE jobs SET status='failed', result=?, finished_at=?, lease_until=NULL WHERE id=?",
        )
        .run("batch_pending without batchHandle", now, jobId);
      const active = this.activeJobs.get(jobId);
      if (active) {
        clearInterval(active.renewTimer);
        this.activeJobs.delete(jobId);
      }
      return;
    }
    const job = this.getJob(jobId);
    if (!job) return;
    this.db
      .prepare(
        `UPDATE jobs
         SET status='batch_pending',
             batch_handle=?,
             lease_until=NULL,
             worker_id=NULL
         WHERE id=?`,
      )
      .run(JSON.stringify(result.batchHandle), jobId);

    const delayMs = result.batchResumeDelayMs ?? BATCH_RESUME_DELAY_MS;
    this.enqueue({
      projectId: job.project_id,
      kind: "agent.batch_resume",
      mode: "autonomous",
      ownerId: job.owner_id ?? undefined,
      payload: { originalJobId: jobId, attempt: 1, delayMs },
      scheduledAt: now + delayMs,
    });

    const active = this.activeJobs.get(jobId);
    if (active) {
      clearInterval(active.renewTimer);
      this.activeJobs.delete(jobId);
    }
  }

  /**
   * Append an event to the durable stream of a job *other than*
   * the one currently running. Used by `agent.batch_resume` to
   * emit `message.text` / `usage` / `batch.completed` against the
   * original `agent.run` job — the job_id the AI panel is
   * subscribed to.
   *
   * The seq counter is shared with the regular emit path so a
   * resume tick can never collide with a stray late event from
   * the original handler (which doesn't exist by the time the
   * tick fires, but defensive is cheap).
   */
  emitEventForJob(originalJobId: string, kind: string, data: unknown): void {
    const job = this.getJob(originalJobId);
    if (!job) return;
    this.appendEvent(job.project_id, originalJobId, kind, data);
  }

  /**
   * Read the persisted batch handle for a job, or null when the
   * job has no handle (it's not batch_pending, or the column
   * was never written).
   */
  getBatchHandle(jobId: string): BatchHandlePersisted | null {
    const row = this.db.prepare("SELECT batch_handle FROM jobs WHERE id = ?").get(jobId) as
      | { batch_handle: string | null }
      | undefined;
    if (!row?.batch_handle) return null;
    try {
      return JSON.parse(row.batch_handle) as BatchHandlePersisted;
    } catch {
      return null;
    }
  }

  /**
   * Phase-11 Airlock — persist the audit trail when a run's egress
   * gets downgraded by a cross-project `kb.global_search` hit.
   * The in-memory `AirlockSession` still enforces the downgrade;
   * this writes a forensic row so SQL queries can find every
   * tainted run without replaying `job_events`. Idempotent — only
   * the first downgrade per job sticks (matches `AirlockSession`'s
   * "first reason wins" semantics).
   */
  markEgressDowngraded(jobId: string, payload: { reason: string | null; at: string | null }): void {
    this.db
      .prepare("UPDATE jobs SET egress_downgraded = ? WHERE id = ? AND egress_downgraded IS NULL")
      .run(JSON.stringify(payload), jobId);
  }

  /**
   * Mark a parked `batch_pending` job as terminal. Called by the
   * resume handler when the upstream batch ends. Idempotent — a
   * job that's already been marked done/failed by some other
   * path is left alone.
   */
  finalizeBatchedJob(jobId: string, status: "done" | "failed", result: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE jobs
         SET status=?, result=?, finished_at=?, lease_until=NULL, worker_id=NULL
         WHERE id=? AND status='batch_pending'`,
      )
      .run(status, result, now, jobId);
  }

  private appendEvent(projectId: string, jobId: string, kind: string, data: unknown): void {
    const key = jobId;
    const seq = (this.seqCounters.get(key) ?? 0) + 1;
    this.seqCounters.set(key, seq);

    this.db
      .prepare(
        "INSERT INTO job_events (project_id, job_id, seq, ts, kind, data) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(projectId, jobId, seq, Date.now(), kind, JSON.stringify(data));
  }

  private reclaimExpiredLeases(): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE jobs SET status = 'queued', lease_until = NULL, worker_id = NULL
         WHERE status = 'running' AND lease_until < ?`,
      )
      .run(now);
  }
}
