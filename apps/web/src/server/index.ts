import { serve } from "@hono/node-server";
import type { HealthResponse, InstallRecord, ReadyResponse } from "@ironlore/core";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_PROJECT_ID,
  INSTALL_JSON,
  SENSITIVE_FILE_MODE,
} from "@ironlore/core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { bootstrap } from "./bootstrap.js";
import { createCorsConfig } from "./cors.js";
import { validateBind } from "./network.js";

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
// API placeholder
// ---------------------------------------------------------------------------
app.get("/api/projects/:projectId/pages", (c) => {
  return c.json({ pages: [], projectId: c.req.param("projectId") });
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
