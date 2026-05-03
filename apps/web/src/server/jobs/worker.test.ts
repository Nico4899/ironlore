import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openJobsDb } from "./schema.js";
import type { JobContext, JobRow } from "./types.js";
import { WorkerPool } from "./worker.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ironlore-jobs-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("WorkerPool", () => {
  let tmpDir: string;
  let pool: WorkerPool;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    const db = openJobsDb(join(tmpDir, "jobs.sqlite"));
    pool = new WorkerPool(db, { maxParallel: 5 });
  });

  afterEach(() => {
    pool.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("enqueues and retrieves a job", () => {
    const id = pool.enqueue({
      projectId: "main",
      kind: "agent.run",
      payload: { prompt: "hello" },
    });

    const job = pool.getJob(id);
    expect(job).toBeDefined();
    expect(job?.status).toBe("queued");
    expect(job?.project_id).toBe("main");
    expect(job?.kind).toBe("agent.run");
    expect(JSON.parse(job?.payload ?? "{}")).toEqual({ prompt: "hello" });
  });

  it("polls and dispatches a queued job to its handler", async () => {
    let handlerCalled = false;
    let receivedJobId = "";

    pool.register("test.job", async (job: JobRow) => {
      handlerCalled = true;
      receivedJobId = job.id;
      return { status: "done", result: "ok" };
    });

    const id = pool.enqueue({ projectId: "main", kind: "test.job" });
    pool.start();

    // Wait for the poll cycle to pick it up.
    await new Promise((r) => setTimeout(r, 2000));

    expect(handlerCalled).toBe(true);
    expect(receivedJobId).toBe(id);

    const completed = pool.getJob(id);
    expect(completed?.status).toBe("done");
    expect(completed?.result).toBe("ok");
    expect(completed?.finished_at).toBeGreaterThan(0);
  });

  it("fails a job when the handler throws", async () => {
    pool.register("failing.job", async () => {
      throw new Error("boom");
    });

    const id = pool.enqueue({ projectId: "main", kind: "failing.job" });
    pool.start();

    await new Promise((r) => setTimeout(r, 2000));

    const job = pool.getJob(id);
    expect(job?.status).toBe("failed");
    expect(job?.result).toContain("boom");
  });

  it("fails a job when no handler is registered for the kind", async () => {
    const id = pool.enqueue({ projectId: "main", kind: "unknown.kind" });
    pool.start();

    await new Promise((r) => setTimeout(r, 2000));

    const job = pool.getJob(id);
    expect(job?.status).toBe("failed");
    expect(job?.result).toContain("No handler");
  });

  it("emits events to the job_events table", async () => {
    pool.register("eventing.job", async (_job: JobRow, ctx: JobContext) => {
      ctx.emitEvent("tool.call", { tool: "kb.search", args: { query: "test" } });
      ctx.emitEvent("tool.result", { result: "found" });
      return { status: "done" };
    });

    const id = pool.enqueue({ projectId: "main", kind: "eventing.job" });
    pool.start();

    await new Promise((r) => setTimeout(r, 2000));

    const events = pool.getJobEvents(id);
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe("tool.call");
    expect(events[0]?.seq).toBe(1);
    expect(events[1]?.kind).toBe("tool.result");
    expect(events[1]?.seq).toBe(2);
  });

  it("does not double-dispatch the same job to two poll cycles", async () => {
    let callCount = 0;

    pool.register("slow.job", async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 3000));
      return { status: "done" };
    });

    pool.enqueue({ projectId: "main", kind: "slow.job" });
    pool.start();

    // Wait long enough for multiple poll cycles to fire.
    await new Promise((r) => setTimeout(r, 3500));

    expect(callCount).toBe(1);
  });

  it("respects maxParallel concurrency limit", async () => {
    let peakConcurrency = 0;
    let currentConcurrency = 0;

    pool.register("concurrent.job", async () => {
      currentConcurrency++;
      peakConcurrency = Math.max(peakConcurrency, currentConcurrency);
      await new Promise((r) => setTimeout(r, 500));
      currentConcurrency--;
      return { status: "done" };
    });

    // Enqueue more jobs than maxParallel (5).
    for (let i = 0; i < 10; i++) {
      pool.enqueue({ projectId: "main", kind: "concurrent.job" });
    }

    pool.start();
    await new Promise((r) => setTimeout(r, 3000));

    expect(peakConcurrency).toBeLessThanOrEqual(5);
    // All 10 should eventually complete.
    // (Some may not finish in 3s with only 5 parallel; just check the limit held.)
  });

  it("periodically reclaims expired leases while running", async () => {
    // Simulates a worker crashing mid-run: a job is marked running
    // with an expired lease, but no one has restarted the pool.
    // The pre-fix version relied on a restart to reclaim; now the
    // poll loop itself sweeps expired leases and the job gets
    // re-dispatched automatically.
    const db = openJobsDb(join(tmpDir, "jobs.sqlite"));
    const now = Date.now();
    db.prepare(
      `INSERT INTO jobs (id, project_id, kind, mode, payload, status, lease_until, worker_id, scheduled_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
    ).run(
      "stuck-job",
      "main",
      "resumable.job",
      "autonomous",
      "{}",
      now - 10_000, // lease expired 10s ago
      "dead-worker",
      now - 60_000,
      now - 60_000,
    );

    let pickedUp = false;
    pool.register("resumable.job", async () => {
      pickedUp = true;
      return { status: "done" };
    });
    pool.start();

    // Wait for a poll cycle to run.
    await new Promise((r) => setTimeout(r, 2000));

    expect(pickedUp).toBe(true);
    const job = pool.getJob("stuck-job");
    expect(job?.status).toBe("done");
    db.close();
  });

  it("reclaims expired leases on startup", () => {
    // Manually insert a job with an expired lease (simulating a crash).
    const db = openJobsDb(join(tmpDir, "jobs.sqlite"));
    const now = Date.now();
    db.prepare(
      `INSERT INTO jobs (id, project_id, kind, mode, payload, status, lease_until, worker_id, scheduled_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
    ).run(
      "crashed-job",
      "main",
      "test",
      "autonomous",
      "{}",
      now - 60_000,
      "dead-worker",
      now - 120_000,
      now - 120_000,
    );

    // Create a new pool — it should reclaim the expired lease on start.
    const pool2 = new WorkerPool(db, { maxParallel: 5 });
    pool2.start();

    const job = pool2.getJob("crashed-job");
    expect(job?.status).toBe("queued");
    expect(job?.worker_id).toBeNull();
    expect(job?.lease_until).toBeNull();

    pool2.stop();
    db.close();
  });

  it("gracefulStop() requeues every active job back to 'queued'", async () => {
    // Two jobs that each park for several seconds inside the handler —
    //  long enough that the gracefulStop() call below catches them
    //  mid-run. The poll cycle is 1 s; the handler must outlast that
    //  plus the test's wait window.
    let started = 0;
    pool.register("test.long", async (_job, ctx) => {
      started++;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 5_000);
        ctx.signal.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      });
      return { status: "done" };
    });

    const id1 = pool.enqueue({ projectId: "main", kind: "test.long" });
    const id2 = pool.enqueue({ projectId: "main", kind: "test.long" });
    pool.start();

    // Wait through ≥2 poll cycles. The poll claims one job at a time
    //  (`LIMIT 1` in the atomic UPDATE), so two enqueued jobs need
    //  two ticks before both are running. The 1 s tick + ~300 ms
    //  slack puts us safely past that.
    await new Promise((r) => setTimeout(r, 2_400));
    expect(started).toBe(2);

    const requeued = pool.gracefulStop();
    expect(requeued).toBe(2);

    // Both rows should now be back in 'queued' with cleared lease state
    //  so the next process pickup retries them.
    const j1 = pool.getJob(id1);
    const j2 = pool.getJob(id2);
    expect(j1?.status).toBe("queued");
    expect(j1?.worker_id).toBeNull();
    expect(j1?.lease_until).toBeNull();
    expect(j2?.status).toBe("queued");
    expect(j2?.worker_id).toBeNull();
    expect(j2?.lease_until).toBeNull();
  });

  it("gracefulStop() returns 0 when no jobs are in flight", () => {
    pool.start();
    const requeued = pool.gracefulStop();
    expect(requeued).toBe(0);
  });
});
