import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { HealthResponse, ReadyResponse } from "@ironlore/core";
import { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_PROJECT_ID } from "@ironlore/core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { createAgentApi, createInboxApi, createJobApi } from "./agents/api.js";
import { DryRunBridge } from "./agents/dry-run-bridge.js";
import { executeAgentRun } from "./agents/executor.js";
import { AgentInbox } from "./agents/inbox.js";
import { AgentRails } from "./agents/rails.js";
import { seedAgents } from "./agents/seed-agents.js";
import { createAuthApi, SessionStore } from "./auth.js";
import { bootstrap } from "./bootstrap.js";
import { createCorsConfig } from "./cors.js";
import { FileWatcher } from "./file-watcher.js";
import { GitWorker } from "./git-worker.js";
import { createIpcAuthMiddleware } from "./ipc-auth.js";
import { BackpressureController } from "./jobs/backpressure.js";
import { openJobsDb } from "./jobs/schema.js";
import { WorkerPool } from "./jobs/worker.js";
import { LinksRegistry } from "./links-registry.js";
import { createMetricsEndpoint, metricsMiddleware } from "./metrics.js";
import { validateBind } from "./network.js";
import { createPagesApi, createRawApi } from "./pages-api.js";
import { checkPermissions } from "./permissions.js";
import { ProviderRegistry } from "./providers/registry.js";
import { authRateLimiter } from "./rate-limit.js";
import { createSearchApi } from "./search-api.js";
import { SearchIndex } from "./search-index.js";
import { StorageWriter } from "./storage-writer.js";
import { TerminalManager } from "./terminal.js";
import { createAgentJournal } from "./tools/agent-journal.js";
import { ToolDispatcher } from "./tools/dispatcher.js";
import { createKbCreatePage } from "./tools/kb-create-page.js";
import { createKbDeleteBlock } from "./tools/kb-delete-block.js";
import { createKbInsertAfter } from "./tools/kb-insert-after.js";
import { createKbReadBlock } from "./tools/kb-read-block.js";
import { createKbReadPage } from "./tools/kb-read-page.js";
import { createKbReplaceBlock } from "./tools/kb-replace-block.js";
import { createKbSearch } from "./tools/kb-search.js";
import type { Wal } from "./wal.js";
import { WebSocketManager } from "./ws.js";

const app = new Hono();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let ready = false;
let readyReason = "Server starting up";
let wal: Wal | null = null;
let workerPool: WorkerPool | null = null;
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
    activeJobs: workerPool?.activeCount ?? 0,
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
  const { recovered, warnings, warningsStructured } = writer.recover();
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

  // ─── Jobs + agents engine ───────────────────────────────────────
  const jobsDbPath = join(installRoot, "jobs.sqlite");
  const jobsDb = openJobsDb(jobsDbPath);
  const pool = new WorkerPool(jobsDb);
  const rails = new AgentRails(jobsDb);
  const dryRunBridge = new DryRunBridge();
  // Backpressure is created up front (not deep in the route mounting
  // section) so the agent.run job handler closure can capture a live
  // reference. The controller's recovery timer is kick-started below.
  const backpressure = new BackpressureController();

  // Seed agent_state rows for default agents.
  seedAgents(writer.getDataRoot(), jobsDb);

  // Provider registry — auto-detect Ollama, register Anthropic from env.
  const providerRegistry = new ProviderRegistry();
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    providerRegistry.registerAnthropic(anthropicKey);
    console.log("Provider: Anthropic registered");
  }
  const ollamaDetected = await providerRegistry.autoDetectOllama();
  if (ollamaDetected) {
    console.log(`Provider: Ollama detected (${providerRegistry.getOllamaModels().length} models)`);
  }

  // Tool dispatcher — register all kb.* tools + agent.journal.
  const dispatcher = new ToolDispatcher();
  dispatcher.register(createKbSearch(searchIndex));
  dispatcher.register(createKbReadPage(writer));
  dispatcher.register(createKbReadBlock(writer));
  dispatcher.register(createKbReplaceBlock(writer, searchIndex));
  dispatcher.register(createKbInsertAfter(writer, searchIndex));
  dispatcher.register(createKbDeleteBlock(writer, searchIndex));
  dispatcher.register(createKbCreatePage(writer, searchIndex));
  dispatcher.register(createAgentJournal(writer.getDataRoot()));

  // Register the agent.run job handler.
  pool.register("agent.run", async (job, jobCtx) => {
    const payload = JSON.parse(job.payload) as { prompt?: string };
    const agentSlug = job.owner_id ?? "general";
    const provider = providerRegistry.resolve();
    if (!provider) {
      jobCtx.emitEvent("message.error", { text: "No AI provider configured" });
      return { status: "failed", result: "No AI provider configured" };
    }
    const projectContext = ProviderRegistry.buildContext(jobCtx.projectId, fetch);
    const result = await executeAgentRun(job, jobCtx, {
      provider,
      projectContext,
      dispatcher,
      dataRoot: writer.getDataRoot(),
      projectDir,
      model:
        provider.name === "ollama"
          ? (providerRegistry.getOllamaModels()[0] ?? "llama3")
          : "claude-sonnet-4-20250514",
      agentSlug,
      prompt: payload.prompt,
      dryRunBridge,
      backpressure,
    });

    // Record outcome for auto-pause rails.
    rails.recordOutcome(jobCtx.projectId, agentSlug, result.status === "done");

    // Write commit SHA range back to the job row + create inbox entry if applicable.
    if (result.result) {
      try {
        const parsed = JSON.parse(result.result) as {
          commitShaStart?: string;
          commitShaEnd?: string;
          filesChanged?: string[];
          inboxBranch?: string;
        };
        if (parsed.commitShaStart || parsed.commitShaEnd) {
          jobsDb
            .prepare("UPDATE jobs SET commit_sha_start = ?, commit_sha_end = ? WHERE id = ?")
            .run(parsed.commitShaStart ?? null, parsed.commitShaEnd ?? null, job.id);
        }
        // Create inbox entry for inbox-mode runs.
        if (parsed.inboxBranch) {
          inbox.createEntry({
            id: `inbox-${job.id}`,
            projectId: jobCtx.projectId,
            agentSlug,
            branch: parsed.inboxBranch,
            jobId: job.id,
            filesChanged: parsed.filesChanged ?? [],
            startedAt: job.started_at ?? Date.now(),
            finalizedAt: Date.now(),
          });
        }
      } catch {
        // Non-JSON result — skip.
      }
    }

    return result;
  });

  // Start the worker pool + backpressure controller recovery timer.
  backpressure.start();
  pool.start();
  workerPool = pool;
  console.log("Worker pool started");

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
  const searchProvider = providerRegistry.resolve();
  const searchApi = createSearchApi(searchIndex, {
    provider: searchProvider,
    projectId: DEFAULT_PROJECT_ID,
    projectDir,
    defaultModel:
      searchProvider?.name === "ollama"
        ? (providerRegistry.getOllamaModels()[0] ?? "llama3")
        : "claude-haiku-4-20250514",
  });
  app.route(`/api/projects/${DEFAULT_PROJECT_ID}/search`, searchApi);

  // Mount agent API (run, state, pause/resume)
  app.use("/api/projects/*/agents/*", authMiddleware);
  const agentApi = createAgentApi(pool, rails, DEFAULT_PROJECT_ID, projectDir);
  app.route(`/api/projects/${DEFAULT_PROJECT_ID}/agents`, agentApi);

  // Mount job API (status, events)
  app.use("/api/projects/*/jobs/*", authMiddleware);
  const jobApi = createJobApi(pool, projectDir, dryRunBridge);
  app.route(`/api/projects/${DEFAULT_PROJECT_ID}/jobs`, jobApi);

  // Mount inbox API (staging branch review)
  const inbox = new AgentInbox(jobsDb);
  const inboxApi = createInboxApi(inbox, DEFAULT_PROJECT_ID, projectDir);
  app.route(`/api/projects/${DEFAULT_PROJECT_ID}/inbox`, inboxApi);

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

  // Surface any recovery warnings as a persistent WS event. The event
  // enters the replay buffer, so any client that connects afterward
  // receives it via replay — matching
  // docs/02-storage-and-sync.md §User-visible recovery surface.
  if (warningsStructured.length > 0) {
    wsManager.broadcast({
      type: "recovery:pending",
      paths: warningsStructured.map((w) => w.path),
      messages: warningsStructured.map((w) => w.message),
    });
  }

  // Initialize terminal manager (single-session PTY over WS)
  terminalManager = new TerminalManager(
    writer.getDataRoot(),
    sessionStore,
    validateCookie,
    DEFAULT_PROJECT_ID,
  );

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
