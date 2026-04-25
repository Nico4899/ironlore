import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openJobsDb } from "./schema.js";
import type { BatchHandlePersisted, JobResult } from "./types.js";
import { WorkerPool } from "./worker.js";

/**
 * Phase-11 worker-pool lease release for async batch.
 *
 * The batch path lets a long-running upstream (Anthropic Message
 * Batches, target SLA 24h) run without pinning a worker slot.
 * The flow:
 *   1. agent.run handler returns `batch_pending` + a handle.
 *   2. Worker pool persists the handle, sets status=batch_pending,
 *      drops the lease, frees the slot.
 *   3. Worker pool enqueues a delayed `agent.batch_resume` job.
 *   4. The resume handler polls upstream + finalizes the original.
 *
 * These tests pin the contract between the executor and the
 * worker pool. The agent.run + agent.batch_resume handlers
 * themselves live in index.ts; here we drive a stub handler that
 * exercises the same invariants without booting the rest of the
 * server.
 */

let tmp: string;
let db: Database.Database;

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "worker-batch-"));
  db = openJobsDb(join(tmp, "jobs.sqlite"));
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("WorkerPool — batch_pending lifecycle", () => {
  it("parks the original job + persists the handle when the agent.run handler returns batch_pending", async () => {
    const pool = new WorkerPool(db, { maxParallel: 4 });
    const handle: BatchHandlePersisted = {
      provider: "anthropic",
      batchId: "msgbatch_park",
      requestId: "req_park",
      model: "claude-sonnet-4-6",
      agentSlug: "general",
    };

    pool.register("agent.run", async (): Promise<JobResult> => {
      return { status: "batch_pending", batchHandle: handle, batchResumeDelayMs: 1 };
    });
    // Stub resume handler — just marks the original done so the
    // test doesn't hang waiting for a real upstream poll.
    const resumePayloads: Array<{ originalJobId?: string; attempt?: number }> = [];
    pool.register("agent.batch_resume", async (job) => {
      resumePayloads.push(JSON.parse(job.payload) as { originalJobId?: string; attempt?: number });
      return { status: "done", result: "stub-resumed" };
    });

    pool.start();
    const originalId = pool.enqueue({ projectId: "main", kind: "agent.run" });

    // Wait for the original to land in batch_pending status.
    await waitFor(() => {
      const j = pool.getJob(originalId);
      return j?.status === "batch_pending";
    });

    const parked = pool.getJob(originalId);
    expect(parked?.status).toBe("batch_pending");
    expect(parked?.lease_until).toBeNull();
    expect(parked?.worker_id).toBeNull();
    expect(parked?.finished_at).toBeNull(); // not terminal yet

    // The persisted handle survives the round-trip.
    const stored = pool.getBatchHandle(originalId);
    expect(stored).toEqual(handle);

    // Slot is free — pool can claim a new job immediately.
    expect(pool.activeCount).toBeLessThan(4);

    // The resume tick fires shortly after.
    await waitFor(() => resumePayloads.length > 0);
    expect(resumePayloads[0]?.originalJobId).toBe(originalId);
    expect(resumePayloads[0]?.attempt).toBe(1);

    pool.stop();
  });

  it("emitEventForJob writes events against the original job's id", async () => {
    const pool = new WorkerPool(db, { maxParallel: 1 });
    pool.register("noop", async () => ({ status: "done", result: "ok" }));
    pool.start();
    const jobId = pool.enqueue({ projectId: "main", kind: "noop" });
    await waitFor(() => pool.getJob(jobId)?.status === "done");

    pool.emitEventForJob(jobId, "batch.poll", { batchId: "x", status: "in_progress" });
    pool.emitEventForJob(jobId, "message.text", { text: "hi" });

    const events = pool.getJobEvents(jobId);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("batch.poll");
    expect(kinds).toContain("message.text");
    pool.stop();
  });

  it("finalizeBatchedJob marks the parked job done + ignores already-terminal rows", async () => {
    const pool = new WorkerPool(db, { maxParallel: 1 });
    const handle: BatchHandlePersisted = {
      provider: "anthropic",
      batchId: "msgbatch_done",
      requestId: "req_done",
      model: "claude-sonnet-4-6",
      agentSlug: "general",
    };
    pool.register("agent.run", async () => ({
      status: "batch_pending",
      batchHandle: handle,
      batchResumeDelayMs: 999_999, // resume tick we'll never reach
    }));
    // Register a no-op resume so any incidental tick has a handler.
    pool.register("agent.batch_resume", async () => ({ status: "done" }));
    pool.start();
    const id = pool.enqueue({ projectId: "main", kind: "agent.run" });
    await waitFor(() => pool.getJob(id)?.status === "batch_pending");

    pool.finalizeBatchedJob(id, "done", "summary text");
    expect(pool.getJob(id)?.status).toBe("done");
    expect(pool.getJob(id)?.result).toBe("summary text");
    expect(pool.getJob(id)?.finished_at).not.toBeNull();

    // Idempotency — calling again on an already-terminal row is
    // a no-op (the WHERE filter restricts to status='batch_pending').
    pool.finalizeBatchedJob(id, "failed", "should not overwrite");
    expect(pool.getJob(id)?.result).toBe("summary text");
    pool.stop();
  });

  it("fails the original cleanly when the handler returns batch_pending without a handle", async () => {
    const pool = new WorkerPool(db, { maxParallel: 1 });
    pool.register("agent.run", async () => ({
      status: "batch_pending",
      // no batchHandle — defensive path
    }));
    pool.start();
    const id = pool.enqueue({ projectId: "main", kind: "agent.run" });

    await waitFor(() => pool.getJob(id)?.status === "failed");
    expect(pool.getJob(id)?.result).toMatch(/batchHandle/);
    pool.stop();
  });
});
