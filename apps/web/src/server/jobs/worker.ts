import { randomBytes } from "node:crypto";
import { ulid } from "@ironlore/core";
import type Database from "better-sqlite3";
import type { JobContext, JobHandler, JobResult, JobRow } from "./types.js";

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
      signal: controller.signal,
    };

    // Run the handler asynchronously.
    handler(job, ctx)
      .then((result) => this.completeJob(job.id, result))
      .catch((err) => this.completeJob(job.id, { status: "failed", result: String(err) }));
  }

  private completeJob(jobId: string, result: JobResult): void {
    const now = Date.now();
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
