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
    if (durationS <= BUCKETS[i]!) {
      entry.buckets[i]!++;
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

export function createMetricsEndpoint(getWal: () => Wal | null): Hono {
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
        cumulative += entry.buckets[i]!;
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

    // -- WebSocket connections gauge --
    lines.push("# HELP ironlore_ws_connections Active WebSocket connections.");
    lines.push("# TYPE ironlore_ws_connections gauge");
    lines.push(`ironlore_ws_connections ${activeWsConnections}`);

    c.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return c.text(lines.join("\n") + "\n");
  });

  return api;
}
