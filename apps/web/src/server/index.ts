import { serve } from "@hono/node-server";
import type { HealthResponse, ReadyResponse } from "@ironlore/core";
import { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_PROJECT_ID } from "@ironlore/core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { SessionStore, createAuthApi } from "./auth.js";
import { bootstrap } from "./bootstrap.js";
import { createCorsConfig } from "./cors.js";
import { FileWatcher } from "./file-watcher.js";
import { GitWorker } from "./git-worker.js";
import { createIpcAuthMiddleware } from "./ipc-auth.js";
import { createMetricsEndpoint, metricsMiddleware } from "./metrics.js";
import { validateBind } from "./network.js";
import { authRateLimiter } from "./rate-limit.js";
import { createPagesApi } from "./pages-api.js";
import { checkPermissions } from "./permissions.js";
import { SearchIndex } from "./search-index.js";
import { StorageWriter } from "./storage-writer.js";
import type { Wal } from "./wal.js";

const app = new Hono();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let ready = false;
let readyReason = "Server starting up";
let wal: Wal | null = null;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use("*", logger());

// Metrics middleware — records request latency per route (when enabled)
if (process.env.IRONLORE_METRICS === "true") {
  app.use("*", metricsMiddleware());
}

const corsConfig = createCorsConfig();
if (corsConfig) {
  app.use("/api/*", cors(corsConfig));
}

// ---------------------------------------------------------------------------
// Health & readiness
// ---------------------------------------------------------------------------
app.get("/health", (c) => {
  const body: HealthResponse = {
    status: "ok",
    activeJobs: 0,
    walDepth: wal?.getDepth() ?? 0,
    wsSubscribers: 0,
    projects: 1, // single-project until Phase 5
  };
  return c.json(body);
});

app.get("/ready", (c) => {
  if (ready) {
    const body: ReadyResponse = { ready: true };
    return c.json(body);
  }
  const body: ReadyResponse = { ready: false, reason: readyReason };
  return c.json(body, 503);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const host = process.env.IRONLORE_BIND ?? DEFAULT_HOST;
const port = Number(process.env.IRONLORE_PORT ?? DEFAULT_PORT);

validateBind(host);

async function start() {
  const installRoot = process.cwd();
  await bootstrap(installRoot);

  // Check sensitive file permissions (refuse to start if too broad)
  const violations = checkPermissions(installRoot);
  if (violations.length > 0) {
    console.error("Refusing to start — sensitive files have insecure permissions:");
    for (const v of violations) {
      console.error(`  ${v}`);
    }
    process.exit(1);
  }

  // Mount IPC auth middleware for worker ↔ web internal routes
  app.use("/api/internal/*", createIpcAuthMiddleware(installRoot));

  // Initialize auth system (sessions, login, password change)
  const sessionStore = new SessionStore(installRoot);
  const { api: authApi, middleware: authMiddleware } = createAuthApi(installRoot, sessionStore);
  app.use("/api/auth/*", authRateLimiter());
  app.route("/api/auth", authApi);

  // Protect all non-auth API routes with session middleware
  app.use("/api/projects/*", authMiddleware);

  // Initialize StorageWriter for the default project
  const projectDir = `${installRoot}/projects/${DEFAULT_PROJECT_ID}`;
  const writer = new StorageWriter(projectDir);

  // Crash recovery — replay any uncommitted WAL entries
  const { recovered, warnings } = writer.recover();
  if (recovered > 0) {
    console.log(`WAL recovery: replayed ${recovered} entries`);
  }
  for (const w of warnings) {
    console.warn(`WAL recovery warning: ${w}`);
  }

  // Initialize search index (FTS5 + backlinks + tags + recent-edits)
  const searchIndex = new SearchIndex(projectDir);

  // Mount page API
  const pagesApi = createPagesApi(writer, searchIndex);
  app.route(`/api/projects/${DEFAULT_PROJECT_ID}/pages`, pagesApi);

  // Expose WAL for health endpoint
  wal = writer.getWal();

  // Mount /metrics endpoint (Prometheus text format, behind auth, opt-in)
  if (process.env.IRONLORE_METRICS === "true") {
    const metricsApi = createMetricsEndpoint(() => wal);
    app.use("/metrics", authMiddleware);
    app.route("/metrics", metricsApi);
  }

  // Start git worker (background commit grouping)
  const gitWorker = new GitWorker(projectDir, wal);
  await gitWorker.start();

  // Start filesystem watcher for external edits
  const fileWatcher = new FileWatcher(writer.getDataRoot(), wal, searchIndex);
  fileWatcher.start();

  ready = true;
  readyReason = "";

  serve({ fetch: app.fetch, hostname: host, port }, (info) => {
    console.log(`ironlore listening on http://${info.address}:${info.port}`);
  });
}

start().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});

export { app };
