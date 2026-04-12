import { serve } from "@hono/node-server";
import type { HealthResponse, ReadyResponse } from "@ironlore/core";
import { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_PROJECT_ID } from "@ironlore/core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { bootstrap } from "./bootstrap.js";
import { createCorsConfig } from "./cors.js";
import { FileWatcher } from "./file-watcher.js";
import { GitWorker } from "./git-worker.js";
import { validateBind } from "./network.js";
import { createPagesApi } from "./pages-api.js";
import { StorageWriter } from "./storage-writer.js";

const app = new Hono();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let ready = false;
let readyReason = "Server starting up";

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use("*", logger());

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
    walDepth: 0,
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

  // Mount page API
  const pagesApi = createPagesApi(writer);
  app.route(`/api/projects/${DEFAULT_PROJECT_ID}/pages`, pagesApi);

  // Start git worker (background commit grouping)
  const gitWorker = new GitWorker(projectDir, writer.getWal());
  await gitWorker.start();

  // Start filesystem watcher for external edits
  const fileWatcher = new FileWatcher(writer.getDataRoot(), writer.getWal());
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
