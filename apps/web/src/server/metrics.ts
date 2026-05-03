import type Database from "better-sqlite3";
import type { Context, Next } from "hono";
import { Hono } from "hono";
import type { Wal } from "./wal.js";

// ---------------------------------------------------------------------------
// Histogram — simple bucket-based latency tracker
// ---------------------------------------------------------------------------

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface HistogramEntry {
  buckets: number[];
  sum: number;
  count: number;
}

const latencyByRoute = new Map<string, HistogramEntry>();

function observeLatency(route: string, durationS: number): void {
  let entry = latencyByRoute.get(route);
  if (!entry) {
    entry = { buckets: new Array(BUCKETS.length).fill(0), sum: 0, count: 0 };
    latencyByRoute.set(route, entry);
  }
  entry.sum += durationS;
  entry.count++;
  for (let i = 0; i < BUCKETS.length; i++) {
    const threshold = BUCKETS[i];
    if (threshold !== undefined && durationS <= threshold) {
      entry.buckets[i] = (entry.buckets[i] ?? 0) + 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Gauges
// ---------------------------------------------------------------------------

let activeWsConnections = 0;

export function setWsConnections(count: number): void {
  activeWsConnections = count;
}

export function incWsConnections(): void {
  activeWsConnections++;
}

export function decWsConnections(): void {
  activeWsConnections = Math.max(0, activeWsConnections - 1);
}

// ---------------------------------------------------------------------------
// Middleware — records request latency per route pattern
// ---------------------------------------------------------------------------

export function metricsMiddleware() {
  return async (c: Context, next: Next) => {
    const start = performance.now();
    await next();
    const durationS = (performance.now() - start) / 1000;
    // Use the matched route pattern if available, else the path
    const route = c.req.routePath ?? c.req.path;
    observeLatency(`${c.req.method} ${route}`, durationS);
  };
}

// ---------------------------------------------------------------------------
// /metrics endpoint — Prometheus text exposition format
// ---------------------------------------------------------------------------

/**
 * Compute the job-queue lag at scrape time. Lag = (now - scheduled_at)
 * for the oldest queued job, in seconds. Returns 0 when the queue is
 * empty so Prometheus has a stable gauge to plot. SQL deliberately
 * filters on `status='queued'` AND `scheduled_at <= now` so that
 * future-scheduled jobs (deferred batch resumes) don't inflate the lag.
 */
function computeJobQueueLag(db: Database.Database | null): number {
  if (!db) return 0;
  try {
    const now = Date.now();
    const row = db
      .prepare(
        `SELECT MIN(scheduled_at) AS oldest
         FROM jobs
         WHERE status = 'queued' AND scheduled_at <= ?`,
      )
      .get(now) as { oldest: number | null } | undefined;
    if (!row || row.oldest == null) return 0;
    return Math.max(0, (now - row.oldest) / 1000);
  } catch {
    // Schema not initialised yet (boot race) → report 0 rather than 5xx.
    return 0;
  }
}

export function createMetricsEndpoint(
  getWal: () => Wal | null,
  getJobsDb: () => Database.Database | null = () => null,
): Hono {
  const api = new Hono();

  api.get("/", (c) => {
    const lines: string[] = [];

    // -- Request latency histogram --
    lines.push("# HELP ironlore_http_request_duration_seconds HTTP request latency in seconds.");
    lines.push("# TYPE ironlore_http_request_duration_seconds histogram");
    for (const [route, entry] of latencyByRoute) {
      const label = route.replace(/"/g, '\\"');
      let cumulative = 0;
      for (let i = 0; i < BUCKETS.length; i++) {
        cumulative += entry.buckets[i] ?? 0;
        lines.push(
          `ironlore_http_request_duration_seconds_bucket{route="${label}",le="${BUCKETS[i]}"} ${cumulative}`,
        );
      }
      lines.push(
        `ironlore_http_request_duration_seconds_bucket{route="${label}",le="+Inf"} ${entry.count}`,
      );
      lines.push(`ironlore_http_request_duration_seconds_sum{route="${label}"} ${entry.sum}`);
      lines.push(`ironlore_http_request_duration_seconds_count{route="${label}"} ${entry.count}`);
    }

    // -- WAL depth gauge --
    const walDepth = getWal()?.getDepth() ?? 0;
    lines.push("# HELP ironlore_wal_depth Number of uncommitted WAL entries.");
    lines.push("# TYPE ironlore_wal_depth gauge");
    lines.push(`ironlore_wal_depth ${walDepth}`);

    // -- Job queue lag gauge (per docs/07-tech-stack.md §Metrics) --
    //  Seconds since the oldest eligible queued job became eligible.
    //  Zero when the queue is empty.
    const lagSeconds = computeJobQueueLag(getJobsDb());
    lines.push(
      "# HELP ironlore_job_queue_lag_seconds Seconds since the oldest eligible queued job became eligible (0 when empty).",
    );
    lines.push("# TYPE ironlore_job_queue_lag_seconds gauge");
    lines.push(`ironlore_job_queue_lag_seconds ${lagSeconds}`);

    // -- WebSocket connections gauge --
    lines.push("# HELP ironlore_ws_connections Active WebSocket connections.");
    lines.push("# TYPE ironlore_ws_connections gauge");
    lines.push(`ironlore_ws_connections ${activeWsConnections}`);

    c.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return c.text(`${lines.join("\n")}\n`);
  });

  return api;
}
