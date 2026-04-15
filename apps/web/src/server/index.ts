import { serve } from "@hono/node-server";
import type { HealthResponse, ReadyResponse } from "@ironlore/core";
import { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_PROJECT_ID } from "@ironlore/core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { createAuthApi, SessionStore } from "./auth.js";
import { bootstrap } from "./bootstrap.js";
import { createCorsConfig } from "./cors.js";
import { FileWatcher } from "./file-watcher.js";
import { GitWorker } from "./git-worker.js";
import { createIpcAuthMiddleware } from "./ipc-auth.js";
import { LinksRegistry } from "./links-registry.js";
import { createMetricsEndpoint, metricsMiddleware } from "./metrics.js";
import { validateBind } from "./network.js";
import { createPagesApi, createRawApi } from "./pages-api.js";
import { checkPermissions } from "./permissions.js";
import { authRateLimiter } from "./rate-limit.js";
import { createSearchApi } from "./search-api.js";
import { SearchIndex } from "./search-index.js";
import { StorageWriter } from "./storage-writer.js";
import { TerminalManager } from "./terminal.js";
import type { Wal } from "./wal.js";
import { WebSocketManager } from "./ws.js";

const app = new Hono();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let ready = false;
let readyReason = "Server starting up";
let wal: Wal | null = null;
let wsManager: WebSocketManager | null = null;
let terminalManager: TerminalManager | null = null;

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
    wsSubscribers: wsManager?.getSubscriberCount() ?? 0,
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
  const {
    api: authApi,
    middleware: authMiddleware,
    validateCookie,
  } = createAuthApi(installRoot, sessionStore);
  app.use("/api/auth/*", authRateLimiter());
  app.route("/api/auth", authApi);

  // Protect all non-auth API routes with session middleware
  app.use("/api/projects/*", authMiddleware);

  // Initialize StorageWriter for the default project
  const projectDir = `${installRoot}/projects/${DEFAULT_PROJECT_ID}`;
  const linksRegistry = new LinksRegistry(projectDir);
  const writer = new StorageWriter(projectDir, linksRegistry.validator());

  // Crash recovery — replay any uncommitted WAL entries
  const { recovered, warnings } = writer.recover();
  if (recovered > 0) {
    console.log(`WAL recovery: replayed ${recovered} entries`);
  }
  for (const w of warnings) {
    console.warn(`WAL recovery warning: ${w}`);
  }

  // Initialize search index (FTS5 + backlinks + tags + recent-edits + pages tree)
  const searchIndex = new SearchIndex(projectDir);

  // Reindex on startup to ensure the pages table is populated
  const { indexed } = await searchIndex.reindexAll(writer.getDataRoot());
  console.log(`Search index: ${indexed} pages indexed`);

  // Create broadcast callback that forwards to the WebSocket manager
  // (wsManager is assigned below; the closure reads the module-level
  // reference at call time, so late binding is fine).
  const broadcast = (event: Parameters<WebSocketManager["broadcast"]>[0]) => {
    wsManager?.broadcast(event);
  };

  // Mount page API
  const pagesApi = createPagesApi(writer, searchIndex, broadcast);
  app.route(`/api/projects/${DEFAULT_PROJECT_ID}/pages`, pagesApi);

  // Mount raw file API (binary + CSV write)
  const rawApi = createRawApi(writer);
  app.route(`/api/projects/${DEFAULT_PROJECT_ID}/raw`, rawApi);

  // Mount search API (FTS5, backlinks, recent edits)
  const searchApi = createSearchApi(searchIndex);
  app.route(`/api/projects/${DEFAULT_PROJECT_ID}/search`, searchApi);

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
  const fileWatcher = new FileWatcher(writer.getDataRoot(), wal, searchIndex, broadcast);
  fileWatcher.start();

  // Initialize WebSocket manager for real-time events
  wsManager = new WebSocketManager(sessionStore, validateCookie);

  // Initialize terminal manager (single-session PTY over WS)
  terminalManager = new TerminalManager(writer.getDataRoot(), sessionStore, validateCookie);

  ready = true;
  readyReason = "";

  const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
    console.log(`ironlore listening on http://${info.address}:${info.port}`);
  });

  // Attach WebSocket upgrade handler to the HTTP server
  const wsMgr = wsManager;
  const termMgr = terminalManager;
  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/ws") {
      wsMgr.handleUpgrade(req, socket, head);
    } else if (req.url === "/ws/terminal") {
      termMgr.handleUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });
}

start().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});

export { app };
