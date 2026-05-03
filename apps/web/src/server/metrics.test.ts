import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openJobsDb } from "./jobs/schema.js";
import { createMetricsEndpoint } from "./metrics.js";

describe("metrics endpoint", () => {
  it("returns Prometheus text format with WAL depth gauge", async () => {
    const fakeWal = { getDepth: () => 42 };
    const metricsApi = createMetricsEndpoint(() => fakeWal as never);

    const res = await metricsApi.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");

    const body = await res.text();
    expect(body).toContain("ironlore_wal_depth 42");
    expect(body).toContain("ironlore_ws_connections 0");
    expect(body).toContain("# TYPE ironlore_wal_depth gauge");
  });

  it("returns 0 WAL depth when wal is null", async () => {
    const metricsApi = createMetricsEndpoint(() => null);

    const res = await metricsApi.request("/");
    const body = await res.text();
    expect(body).toContain("ironlore_wal_depth 0");
  });

  it("emits ironlore_job_queue_lag_seconds = 0 when no jobsDb is provided", async () => {
    const metricsApi = createMetricsEndpoint(() => null);
    const res = await metricsApi.request("/");
    const body = await res.text();
    expect(body).toContain("ironlore_job_queue_lag_seconds 0");
    expect(body).toContain("# TYPE ironlore_job_queue_lag_seconds gauge");
  });
});

describe("metrics endpoint — job queue lag (per docs/07-tech-stack.md §Metrics)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ironlore-metrics-${randomBytes(4).toString("hex")}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports lag = (now - oldest queued scheduled_at) in seconds", async () => {
    const db = openJobsDb(join(tmpDir, "jobs.sqlite"));

    // Seed three queued jobs with staggered scheduled_at — the oldest
    //  drives the gauge. Two of them must be eligible (scheduled_at
    //  ≤ now); the future-scheduled one is excluded by the SQL filter.
    const now = Date.now();
    const oldest = now - 4_000; // 4 s in the past
    const middle = now - 1_500;
    const future = now + 60_000;

    const insert = db.prepare(
      `INSERT INTO jobs (id, project_id, kind, mode, payload, status, scheduled_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
    );
    insert.run("oldest", "main", "test", "autonomous", "{}", oldest, oldest);
    insert.run("middle", "main", "test", "autonomous", "{}", middle, middle);
    insert.run("future", "main", "test", "autonomous", "{}", future, future);

    const metricsApi = createMetricsEndpoint(
      () => null,
      () => db,
    );
    const res = await metricsApi.request("/");
    const body = await res.text();

    const match = body.match(/ironlore_job_queue_lag_seconds (\d+(?:\.\d+)?)/);
    expect(match).not.toBeNull();
    const lag = Number(match?.[1]);
    // Tolerance: 4 s expected, anywhere in [3.5, 6.0] is fine —
    //  test setup overhead + clock skew shouldn't spike above 6 s.
    expect(lag).toBeGreaterThanOrEqual(3.5);
    expect(lag).toBeLessThan(6);

    db.close();
  });

  it("reports 0 lag when the queue is empty", async () => {
    const db = openJobsDb(join(tmpDir, "jobs.sqlite"));
    const metricsApi = createMetricsEndpoint(
      () => null,
      () => db,
    );
    const res = await metricsApi.request("/");
    const body = await res.text();
    expect(body).toContain("ironlore_job_queue_lag_seconds 0");
    db.close();
  });
});
