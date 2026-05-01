import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { HealthResponse, ProjectPreset, ReadyResponse } from "@ironlore/core";
import { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_PROJECT_ID } from "@ironlore/core";
import {
  InvalidPresetError,
  InvalidProjectIdError,
  ProjectAlreadyExistsError,
  scaffoldProjectOnDisk,
  validatePreset,
  validateProjectId,
} from "@ironlore/core/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { createAgentApi, createInboxApi, createJobApi } from "./agents/api.js";
import { DryRunBridge } from "./agents/dry-run-bridge.js";
import { executeAgentRun } from "./agents/executor.js";
import { HeartbeatScheduler } from "./agents/heartbeat.js";
import { AgentInbox } from "./agents/inbox.js";
import { McpBridge } from "./agents/mcp-bridge.js";
import { AgentRails } from "./agents/rails.js";
import { seedAgents } from "./agents/seed-agents.js";
import { createAuthApi, SessionStore } from "./auth.js";
import { bootstrap } from "./bootstrap.js";
import { createCorsConfig } from "./cors.js";
import { createCrossProjectCopyApi } from "./cross-project-copy.js";
import { ContextualizationWorker } from "./contextualization-worker.js";
import { EmbeddingWorker } from "./embedding-worker.js";
import { createEmbeddingsApi } from "./embeddings-api.js";
import { loadProjectConfig } from "./fetch-for-project.js";
import { createIpcAuthMiddleware } from "./ipc-auth.js";
import { BackpressureController } from "./jobs/backpressure.js";
import { openJobsDb } from "./jobs/schema.js";
import { WorkerPool } from "./jobs/worker.js";
import { createMetricsEndpoint, metricsMiddleware } from "./metrics.js";
import { validateBind } from "./network.js";
import { createPagesApi, createRawApi } from "./pages-api.js";
import { checkPermissions } from "./permissions.js";
import { ProjectRegistry } from "./project-registry.js";
import { ProjectServices } from "./project-services.js";
import { EmbeddingProviderRegistry } from "./providers/embedding-registry.js";
import { getProviderKey } from "./providers/key-store.js";
import { OllamaEmbeddingProvider } from "./providers/ollama-embedding.js";
import { ProviderRegistry } from "./providers/registry.js";
import { resolveProviderForRun } from "./providers/resolve.js";
import { createProvidersApi } from "./providers-api.js";
import { authRateLimiter } from "./rate-limit.js";
import { createSearchApi } from "./search-api.js";
import type { SearchIndex } from "./search-index.js";
import { TerminalManager } from "./terminal.js";
import { createAgentJournal } from "./tools/agent-journal.js";
import { ToolDispatcher } from "./tools/dispatcher.js";
import { createKbAppendMemory } from "./tools/kb-append-memory.js";
import { createKbCreatePage } from "./tools/kb-create-page.js";
import { createKbDeleteBlock } from "./tools/kb-delete-block.js";
import { createKbGlobalSearch } from "./tools/kb-global-search.js";
import { createKbInsertAfter } from "./tools/kb-insert-after.js";
import { createKbLintContradictions } from "./tools/kb-lint-contradictions.js";
import { createKbLintCoverageGaps } from "./tools/kb-lint-coverage-gaps.js";
import { createKbLintOrphans } from "./tools/kb-lint-orphans.js";
import { createKbLintProvenanceGaps } from "./tools/kb-lint-provenance-gaps.js";
import { createKbLintStaleSources } from "./tools/kb-lint-stale-sources.js";
import { createKbQueryFailedRuns } from "./tools/kb-query-failed-runs.js";
import { createKbReadBlock } from "./tools/kb-read-block.js";
import { createKbReadPage } from "./tools/kb-read-page.js";
import { createKbReplaceBlock } from "./tools/kb-replace-block.js";
import { createKbSearch } from "./tools/kb-search.js";
import { createKbSemanticSearch } from "./tools/kb-semantic-search.js";
import { sweepStagingOnBoot } from "./uploads.js";
import { createUploadsApi } from "./uploads-api.js";
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
  // `IRONLORE_INSTALL_ROOT` overrides `process.cwd()` for the
  // install layout. Used by the fresh-install Playwright e2e so a
  // single Node process can host an isolated bootstrap root without
  // chdir'ing the entire process. Production deployments leave it
  // unset and inherit cwd as before.
  const installRoot = process.env.IRONLORE_INSTALL_ROOT ?? process.cwd();
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

  // ─── Project discovery ──────────────────────────────────────────
  //  Load the list of known projects from `projects.sqlite` (already
  //  seeded by bootstrap()). For each, spin up its per-project
  //  service bundle (writer, search index, links registry, git
  //  worker, file watcher). Everything below mounts per-project
  //  routes by iterating this map.
  const projectRegistry = new ProjectRegistry(installRoot);
  const projectList = projectRegistry.list();
  const servicesById = new Map<string, ProjectServices>();
  for (const p of projectList) {
    servicesById.set(p.id, ProjectServices.forProject(installRoot, p.id));
  }

  const {
    api: authApi,
    middleware: authMiddleware,
    validateCookie,
  } = createAuthApi(installRoot, sessionStore, {
    getProjectDirs: () => Array.from(servicesById.values()).map((s) => s.projectDir),
    isProjectValid: (projectId) => servicesById.has(projectId),
  });
  app.use("/api/auth/*", authRateLimiter());
  app.route("/api/auth", authApi);

  // Protect all non-auth API routes with session middleware
  app.use("/api/projects/*", authMiddleware);
  // `/api/providers` is install-global (one registry across all
  //  projects) but carries credentials and therefore requires
  //  auth just like the per-project routes.
  app.use("/api/providers/*", authMiddleware);

  // ─── Jobs + agents engine (install-global; all rows carry project_id) ───
  const jobsDbPath = join(installRoot, "jobs.sqlite");
  const jobsDb = openJobsDb(jobsDbPath);
  const pool = new WorkerPool(jobsDb);
  const rails = new AgentRails(jobsDb);
  const dryRunBridge = new DryRunBridge();
  // Backpressure is created up front (not deep in the route mounting
  // section) so the agent.run job handler closure can capture a live
  // reference. The controller's recovery timer is kick-started below.
  const backpressure = new BackpressureController();
  const inbox = new AgentInbox(jobsDb);

  // Provider registry — auto-detect Ollama, register Anthropic from env.
  const providerRegistry = new ProviderRegistry();
  // Anthropic key sourced from env > key-store. Env wins so
  //  operators running under systemd / launchd can rotate keys
  //  without touching the install-local file. Key-store fills in
  //  for installs that configure credentials through the UI.
  const envAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const storedAnthropicKey = envAnthropicKey ? null : getProviderKey(installRoot, "anthropic");
  const anthropicKey = envAnthropicKey ?? storedAnthropicKey;
  if (anthropicKey) {
    providerRegistry.registerAnthropic(anthropicKey);
    console.log(`Provider: Anthropic registered (${envAnthropicKey ? "env" : "key-store"})`);
  }
  const ollamaDetected = await providerRegistry.autoDetectOllama();
  if (ollamaDetected) {
    console.log(`Provider: Ollama detected (${providerRegistry.getOllamaModels().length} models)`);
  }

  // Embedding-provider registry — sibling to the chat registry, only
  //  populated when the user opts into hybrid retrieval by configuring
  //  an embedding API key. Absent → `kb.semantic_search` stays
  //  unavailable and every caller gracefully degrades to BM25-only
  //  (docs/04-ai-and-agents.md §Graceful degradation).
  const embeddingRegistry = new EmbeddingProviderRegistry();
  const envOpenAiKey = process.env.OPENAI_API_KEY;
  const storedOpenAiKey = envOpenAiKey ? null : getProviderKey(installRoot, "openai");
  const openAiKey = envOpenAiKey ?? storedOpenAiKey;
  if (openAiKey) {
    embeddingRegistry.registerOpenAI({ apiKey: openAiKey });
    console.log(`Embedding provider: OpenAI registered (${envOpenAiKey ? "env" : "key-store"})`);
  } else {
    // Local fallback — when no OpenAI key is configured, probe
    // Ollama for an installed embedding model (`nomic-embed-text` /
    // `mxbai-embed-large` / `all-minilm`). If found, register the
    // local provider so hybrid retrieval works without a paid API.
    // Skipped when OpenAI is configured to avoid dim-mismatched
    // chunk_vectors rows when the user later swaps providers.
    const ollamaEmbedModel = await OllamaEmbeddingProvider.detectEmbeddingModel();
    if (ollamaEmbedModel) {
      // Pick dimensionality from the model family; the user can
      // override via an env or future Settings selector.
      const dims = ollamaEmbedModel.startsWith("mxbai-embed-large")
        ? 1024
        : ollamaEmbedModel.startsWith("all-minilm")
          ? 384
          : 768;
      embeddingRegistry.registerOllama({ model: ollamaEmbedModel, dimensions: dims });
      console.log(
        `Embedding provider: Ollama registered (model: ${ollamaEmbedModel}, ${dims} dims)`,
      );
    }
  }

  // Per-project tool dispatchers — tools close over that project's
  //  writer / searchIndex, so we build one dispatcher per project and
  //  the agent.run handler resolves it by `jobCtx.projectId`.
  const dispatchersById = new Map<string, ToolDispatcher>();
  // MCP bridges are also per-project: a server registered in
  // `research/project.yaml` must stay invisible to `main`. Held at
  // module scope so the shutdown path can SIGTERM the stdio
  // children before the Node process exits.
  const mcpBridgesById = new Map<string, McpBridge>();
  for (const [projectId, services] of servicesById) {
    const dispatcher = new ToolDispatcher();
    dispatcher.register(createKbSearch(services.searchIndex));
    dispatcher.register(createKbReadPage(services.writer));
    dispatcher.register(createKbReadBlock(services.writer));
    dispatcher.register(createKbReplaceBlock(services.writer, services.searchIndex));
    dispatcher.register(createKbInsertAfter(services.writer, services.searchIndex));
    dispatcher.register(createKbDeleteBlock(services.writer, services.searchIndex));
    dispatcher.register(createKbCreatePage(services.writer, services.searchIndex));
    dispatcher.register(createKbLintOrphans(services.searchIndex));
    dispatcher.register(createKbLintStaleSources(services.searchIndex));
    dispatcher.register(createKbLintContradictions(services.searchIndex));
    dispatcher.register(createKbLintCoverageGaps(services.searchIndex));
    dispatcher.register(createKbLintProvenanceGaps(services.getDataRoot()));
    // Phase-11 evolver-agent helper. Reads from the install-level
    // jobsDb (shared across projects) but filters by `ctx.projectId`
    // at execute time, so a research-project run can't read main's
    // failure history.
    dispatcher.register(createKbQueryFailedRuns(jobsDb));
    // Phase-11 cognitive-offloading tool — agents append facts to
    // `.agents/<slug>/memory/<topic>.md` (Principle 5b). The
    // executor hydrates these files into the system prompt at run
    // start, so anything written here surfaces in the next run.
    dispatcher.register(createKbAppendMemory());

    // Phase-11 Airlock — cross-project search with dynamic egress
    // downgrade. Off by default; opted in per-install via
    // `IRONLORE_AIRLOCK=true`. The capability only makes sense in
    // multi-user setups where projects have differing trust
    // levels (docs/05 §Threat-model boundaries — 1.0 vs Airlock).
    // Single-user installs leave the env unset, the tool is
    // never registered, and the executor's airlock session never
    // fires. Same `getAllProjectIndexes` closure shape the HTTP
    // ?scope=all path uses.
    if (process.env.IRONLORE_AIRLOCK === "true") {
      dispatcher.register(
        createKbGlobalSearch({
          getAllProjectIndexes: () => {
            const m = new Map<string, SearchIndex>();
            for (const [pid, svc] of servicesById) m.set(pid, svc.searchIndex);
            return m;
          },
          // Per-project trust gate — strict projects sit out the
          // cross-project fan-out entirely. Resolved live so a
          // project.yaml edit + restart picks it up without
          // touching the dispatcher wiring.
          getProjectTrust: (pid) => {
            const svc = servicesById.get(pid);
            if (!svc) return undefined;
            try {
              return loadProjectConfig(svc.projectDir).trust;
            } catch {
              return undefined;
            }
          },
        }),
      );
    }
    // Hybrid retrieval — register `kb.semantic_search` only when an
    // embedding provider is configured. Absent a provider, the tool
    // stays off the agent's palette and every caller gracefully
    // degrades to `kb.search`. See docs/04-ai-and-agents.md §Graceful
    // degradation.
    const embeddingProvider = embeddingRegistry.resolve();
    if (embeddingProvider) {
      // No projectDir / projectId here — the tool resolves the
      // airlock-wrapped fetch at execute() time off `ToolCallContext`,
      // so the embedding call honors the run's downgrade.
      dispatcher.register(createKbSemanticSearch(services.searchIndex, embeddingProvider));
    }
    dispatcher.register(createAgentJournal(services.getDataRoot()));
    dispatchersById.set(projectId, dispatcher);

    // MCP bridge — read `mcp_servers` from `project.yaml`, connect,
    // and merge each discovered tool into the dispatcher as
    // `mcp.<server>.<tool>`. Discovery runs in parallel across
    // projects in the background so a slow / dead server doesn't
    // block startup; per-project failures are logged inside
    // `discoverAndRegister` and never throw.
    let mcpServers: McpBridge | null = null;
    try {
      const config = loadProjectConfig(services.projectDir);
      if (config.mcp_servers && config.mcp_servers.length > 0) {
        mcpServers = new McpBridge(config.mcp_servers, {
          projectId,
          dataRoot: services.getDataRoot(),
          projectDir: services.projectDir,
        });
        mcpBridgesById.set(projectId, mcpServers);
        // Fire-and-await deliberately not used here: discovery is
        // async network/IO that we don't want gating server boot.
        // The agent.run handler reads the dispatcher live, so a
        // tool that registers later (after the first run starts)
        // is still picked up on the next tool-list emission.
        void mcpServers
          .discoverAndRegister(dispatcher)
          .then(() =>
            console.log(`[mcp] ${projectId}: ${mcpServers?.toolCount() ?? 0} tools registered`),
          )
          .catch((err) =>
            console.warn(
              `[mcp] ${projectId}: discovery failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      }
    } catch (err) {
      // Missing / malformed project.yaml is non-fatal — the project
      // boots without MCP, same as if it had no `mcp_servers` key.
      console.warn(
        `[mcp] ${projectId}: project.yaml read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Register the agent.run job handler. Resolves per-project state
  //  (dispatcher, services) from the job's project_id — one handler
  //  fans out across every project.
  pool.register("agent.run", async (job, jobCtx) => {
    const payload = JSON.parse(job.payload) as {
      prompt?: string;
      effort?: "low" | "medium" | "high";
      /** Per-message action override from the composer's `/model …` slash command. */
      modelOverride?: string;
      /** Per-message action override from the composer's `/provider …` slash command. */
      providerOverride?: "anthropic" | "ollama" | "openai" | "claude-cli";
    };
    const agentSlug = job.owner_id ?? "general";
    if (!providerRegistry.hasAny()) {
      jobCtx.emitEvent("message.error", { text: "No AI provider configured" });
      return { status: "failed", result: "No AI provider configured" };
    }
    const services = servicesById.get(jobCtx.projectId);
    const dispatcher = dispatchersById.get(jobCtx.projectId);
    if (!services || !dispatcher) {
      jobCtx.emitEvent("message.error", { text: `Unknown project ${jobCtx.projectId}` });
      return { status: "failed", result: `Unknown project ${jobCtx.projectId}` };
    }
    // Resolve provider/model/effort through the four-level chain
    //  (action → runtime → persona → global). Action overrides come
    //  from the job payload; persona reads frontmatter; global is the
    //  installed default per provider.
    let resolved: Awaited<ReturnType<typeof resolveProviderForRun>>;
    try {
      resolved = resolveProviderForRun({
        registry: providerRegistry,
        globalDefaults: {
          // Pick a reasonable default per the first registered provider.
          //  When the action override changes that, the resolver swaps
          //  the model field to the correct default for the new family.
          provider: (providerRegistry.list()[0] ?? "anthropic") as
            | "anthropic"
            | "ollama"
            | "openai"
            | "claude-cli",
          model:
            providerRegistry.list()[0] === "ollama"
              ? (providerRegistry.getOllamaModels()[0] ?? "llama3")
              : "claude-sonnet-4-20250514",
          effort: "medium",
        },
        dataRoot: services.getDataRoot(),
        agentSlug,
        actionOverride: {
          provider: payload.providerOverride,
          model: payload.modelOverride,
          effort: payload.effort,
        },
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      jobCtx.emitEvent("message.error", { text });
      return { status: "failed", result: text };
    }
    // Stamp the resolution onto the agent_runs row (autonomous runs
    //  only — interactive runs don't have a row, the call no-ops).
    rails.recordResolution(job.id, resolved.resolution);
    // Emit a structured event so the AI panel can surface the
    //  "resolved as: <model> (from <level>)" chip + any
    //  normalization notes (e.g. "effort dropped on Haiku").
    jobCtx.emitEvent("provider.resolved", resolved.resolution);
    const projectContext = ProviderRegistry.buildContext(jobCtx.projectId, fetch);
    const result = await executeAgentRun(job, jobCtx, {
      provider: resolved.provider,
      projectContext,
      dispatcher,
      dataRoot: services.getDataRoot(),
      projectDir: services.projectDir,
      model: resolved.model,
      agentSlug,
      prompt: payload.prompt,
      dryRunBridge,
      backpressure,
      // Phase-11 lint banner — when the wiki-gardener (or any
      // future lint workflow) finalizes via
      // `agent.journal({ lintReport: ... })`, fire one
      // `lint:findings` WS event so the UI surfaces the report.
      // Generic agent runs don't supply the field and this
      // callback never fires.
      onLintReport: (report) => {
        broadcast({
          type: "lint:findings",
          reportPath: report.reportPath,
          counts: report.counts,
          agent: agentSlug,
          runId: job.id,
        });
      },
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

  // Phase-11 async-batch resume tick. The worker pool enqueues a
  //  job of this kind every time `agent.run` returns
  //  `batch_pending` — see WorkerPool.parkBatchPending. The handler
  //  polls the upstream once, emits events on the *original* job's
  //  id, and either finalizes the original or re-enqueues another
  //  tick. The original job stays in `status='batch_pending'`
  //  while we wait, so its slot is free.
  pool.register("agent.batch_resume", async (job) => {
    const payload = JSON.parse(job.payload) as {
      originalJobId?: string;
      attempt?: number;
      delayMs?: number;
    };
    const originalJobId = payload.originalJobId;
    if (!originalJobId) return { status: "failed", result: "missing originalJobId" };

    const original = pool.getJob(originalJobId);
    if (!original || original.status !== "batch_pending") {
      // Race: the original was finalized by another path
      // (cancellation, manual revert) — drop the tick.
      return { status: "done", result: "stale" };
    }

    const handle = pool.getBatchHandle(originalJobId);
    if (!handle) {
      pool.finalizeBatchedJob(originalJobId, "failed", "missing batch handle on resume");
      return { status: "failed", result: "missing batch handle" };
    }

    const provider = providerRegistry.resolve();
    if (!provider) {
      pool.finalizeBatchedJob(originalJobId, "failed", "no AI provider configured at resume time");
      return { status: "failed", result: "no provider" };
    }
    const projectContext = ProviderRegistry.buildContext(job.project_id, fetch);
    const attempt = payload.attempt ?? 1;
    const delayMs = payload.delayMs ?? 5_000;

    const { resumeBatchedTurn } = await import("./agents/executor.js");
    const { outcome } = await resumeBatchedTurn({
      provider,
      projectContext,
      originalJobId,
      handle,
      emitOriginal: (kind, data) => pool.emitEventForJob(originalJobId, kind, data),
      finalizeOriginal: (status, result) => pool.finalizeBatchedJob(originalJobId, status, result),
      attempt,
      // 720 ticks × default 5 s = 1 h cap. Anthropic's batch SLA
      // is 24 h; the cap is conservative and keeps a misbehaving
      // upstream from queueing resume-tick jobs forever.
      attemptCap: 720,
    });

    if (outcome === "rescheduled") {
      pool.enqueue({
        projectId: job.project_id,
        kind: "agent.batch_resume",
        mode: "autonomous",
        ownerId: job.owner_id ?? undefined,
        payload: { originalJobId, attempt: attempt + 1, delayMs },
        scheduledAt: Date.now() + delayMs,
      });
    }

    return { status: "done", result: outcome };
  });

  // Start the worker pool + backpressure controller recovery timer.
  backpressure.start();
  pool.start();
  workerPool = pool;
  console.log("Worker pool started");

  // Start one heartbeat scheduler per project. Each scheduler reads
  //  its own `.agents/` tree, parses each persona's cron, and enqueues
  //  autonomous `agent.run` jobs when a heartbeat fires. Single-process
  //  deployment only — a second server running the same `jobs.sqlite`
  //  would race on fires (see docs/05-jobs-and-security.md §Durable
  //  Jobs).
  const schedulers: HeartbeatScheduler[] = [];
  for (const [projectId, services] of servicesById) {
    const scheduler = new HeartbeatScheduler(
      jobsDb,
      rails,
      pool,
      projectId,
      services.getDataRoot(),
    );
    scheduler.onFire = (slug, jobId) =>
      console.log(`[heartbeat] ${projectId}/${slug} fired → job ${jobId}`);
    scheduler.start();
    schedulers.push(scheduler);
  }
  console.log(`Heartbeat scheduler started for ${schedulers.length} project(s)`);

  // Start one embedding worker per project when a provider is
  //  registered. Each tick (default 30 s) drains up to 50 chunks from
  //  `pages_chunks_fts` that lack entries in `chunk_vectors` — covers
  //  both bulk backfill after first activation and auto-embed on new
  //  writes from indexPage. Absent an embedding provider this block
  //  is a no-op; hybrid retrieval stays off (see docs/04 §Graceful
  //  degradation).
  const embeddingWorkers = new Map<string, EmbeddingWorker>();
  const startupEmbeddingProvider = embeddingRegistry.resolve();
  if (startupEmbeddingProvider) {
    for (const [projectId, services] of servicesById) {
      const worker = new EmbeddingWorker(
        services.searchIndex,
        startupEmbeddingProvider,
        projectId,
        services.projectDir,
      );
      worker.onError = (err) => console.warn(`[embed-worker] ${projectId}: ${err.message}`);
      worker.start();
      embeddingWorkers.set(projectId, worker);
    }
    console.log(`Embedding worker started for ${embeddingWorkers.size} project(s)`);
  }

  // Phase-11 Contextual Retrieval — drains chunks missing a CR summary
  //  on a 30 s tick. Runs only when a chat provider is registered;
  //  absent that, BM25 keeps working unaugmented (NULL-fallback contract
  //  in `bm25PrefilterPaths`). Per-project worker so each project's
  //  backlog drains independently and a slow Anthropic round-trip on
  //  one project doesn't stall another.
  const contextualizationWorkers = new Map<string, ContextualizationWorker>();
  const startupChatProvider = providerRegistry.resolve();
  if (startupChatProvider) {
    for (const [projectId, services] of servicesById) {
      const worker = new ContextualizationWorker(
        services.searchIndex,
        startupChatProvider,
        projectId,
        services.projectDir,
      );
      worker.onError = (err) => console.warn(`[ctx-worker] ${projectId}: ${err.message}`);
      worker.start();
      contextualizationWorkers.set(projectId, worker);
    }
    console.log(
      `Contextualization worker started for ${contextualizationWorkers.size} project(s)`,
    );
  }

  // Create broadcast callback that forwards to the WebSocket manager
  // (wsManager is assigned below; the closure reads the module-level
  // reference at call time, so late binding is fine).
  const broadcast = (event: Parameters<WebSocketManager["broadcast"]>[0]) => {
    wsManager?.broadcast(event);
  };

  // ─── Per-project start-up + route mounting ──────────────────────
  //  Start every project's services in parallel, seed agent_state,
  //  then mount the Hono sub-routers under `/api/projects/<id>/…`.
  //  Recovery warnings are aggregated and rebroadcast once the WS
  //  manager is up.
  const searchProvider = providerRegistry.resolve();
  const allWarningsStructured: Array<{ projectId: string; path: string; message: string }> = [];
  let totalIndexed = 0;

  for (const [projectId, services] of servicesById) {
    const { recovered, warnings, warningsStructured, indexed } = await services.start(broadcast);
    totalIndexed += indexed;
    if (recovered > 0) {
      console.log(`[${projectId}] WAL recovery: replayed ${recovered} entries`);
    }
    for (const w of warnings) {
      console.warn(`[${projectId}] WAL recovery warning: ${w}`);
    }
    for (const w of warningsStructured) {
      allWarningsStructured.push({ projectId, ...w });
    }

    // Seed agent_state rows for default agents into this project.
    seedAgents(services.getDataRoot(), jobsDb);

    // Mount page / raw / upload / search APIs for this project.
    // `mode` (single-user default, multi-user opt-in) is read from
    // `project.yaml` once at boot — toggling at runtime would race
    // in-flight writes (docs/08 §Multi-user mode and per-page ACLs).
    let projectMode: "single-user" | "multi-user" = "single-user";
    try {
      const cfg = loadProjectConfig(services.projectDir);
      if (cfg.mode === "multi-user") projectMode = "multi-user";
    } catch {
      // Missing / malformed project.yaml → safe default.
    }
    app.route(
      `/api/projects/${projectId}/pages`,
      createPagesApi(services.writer, services.searchIndex, broadcast, { mode: projectMode }),
    );
    app.route(
      `/api/projects/${projectId}/raw`,
      createRawApi(services.writer, services.getDataRoot()),
    );
    app.route(
      `/api/projects/${projectId}/uploads`,
      createUploadsApi(services.writer, services.getDataRoot()),
    );
    sweepStagingOnBoot(services.getDataRoot());
    app.route(
      `/api/projects/${projectId}/search`,
      createSearchApi(services.searchIndex, {
        provider: searchProvider,
        projectId,
        projectDir: services.projectDir,
        defaultModel:
          searchProvider?.name === "ollama"
            ? (providerRegistry.getOllamaModels()[0] ?? "llama3")
            : "claude-haiku-4-20250514",
        // Phase-11 hybrid retrieval: `vec` + `hyde` rewrites fuse with
        // BM25 when an embedding provider is registered. Null → old
        // two-channel (original + lex) behavior stays intact.
        embeddingProvider: embeddingRegistry.resolve(),
        // ?scope=all fan-out: capture the live `servicesById` map by
        // closure so projects added later become searchable without
        // restarting this route. The agent tool path
        // (`kb.search` / dispatcher) doesn't receive this — only the
        // user-facing HTTP endpoint can blend results across projects.
        getAllProjectIndexes: () => {
          const m = new Map<string, SearchIndex>();
          for (const [pid, svc] of servicesById) m.set(pid, svc.searchIndex);
          return m;
        },
      }),
    );

    // Agent, job, inbox sub-routers — these already accept `projectId`
    //  + `projectDir` as parameters; the jobs / inbox DB itself is
    //  install-global and project-scoped via `project_id` columns.
    app.route(
      `/api/projects/${projectId}/agents`,
      createAgentApi(pool, rails, jobsDb, projectId, services.projectDir),
    );
    app.route(
      `/api/projects/${projectId}/jobs`,
      createJobApi(pool, services.projectDir, dryRunBridge),
    );
    app.route(
      `/api/projects/${projectId}/inbox`,
      createInboxApi(inbox, projectId, services.projectDir),
    );
    // Phase-11 hybrid retrieval: embedding status + manual backfill.
    // The router is always mounted; individual routes gracefully
    // return 503 when no provider is registered.
    app.route(
      `/api/projects/${projectId}/embeddings`,
      createEmbeddingsApi({
        searchIndex: services.searchIndex,
        provider: startupEmbeddingProvider,
        worker: embeddingWorkers.get(projectId) ?? null,
        chatProvider: startupChatProvider,
        contextualizationWorker: contextualizationWorkers.get(projectId) ?? null,
      }),
    );
  }
  console.log(`Search index: ${totalIndexed} pages indexed across ${servicesById.size} projects`);

  // Middleware for per-project routes (same authMiddleware covers
  //  every per-project sub-router — mounted before the sub-routers
  //  so it runs first).
  app.use("/api/projects/*/agents/*", authMiddleware);
  app.use("/api/projects/*/jobs/*", authMiddleware);

  // Top-level list endpoint for the project switcher.
  app.get("/api/projects", (c) => {
    const list = projectRegistry.list();
    return c.json({ projects: list });
  });

  // Install-global providers API (list / save key / test) —
  //  protected by the auth middleware above.
  app.route("/api/providers", createProvidersApi({ registry: providerRegistry, installRoot }));

  /**
   * Create a new project — parity with `ironlore new-project`.
   *
   * Writes the on-disk layout (data/, .ironlore/{locks,wal}/,
   * project.yaml) via the shared `scaffoldProjectOnDisk` helper,
   * then idempotently inserts the row into `projects.sqlite`.
   * The in-flight server cannot yet mount `/api/projects/:id/*`
   * without a restart — that's a Phase-9 follow-up per
   * docs/06-implementation-roadmap.md. We surface the restart
   * requirement in the response so the client can tell the user.
   *
   * Returns 400 on invalid id / preset, 409 when the project
   * directory already exists.
   */
  app.post("/api/projects", async (c) => {
    let body: { id?: unknown; name?: unknown; preset?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Body must be JSON" }, 400);
    }
    if (typeof body.id !== "string" || typeof body.preset !== "string") {
      return c.json({ error: "Body must include { id: string, preset: string }" }, 400);
    }

    let id: string;
    try {
      id = validateProjectId(body.id);
    } catch (err) {
      if (err instanceof InvalidProjectIdError) return c.json({ error: err.message }, 400);
      throw err;
    }

    let preset: ProjectPreset;
    try {
      preset = validatePreset(body.preset);
    } catch (err) {
      if (err instanceof InvalidPresetError) return c.json({ error: err.message }, 400);
      throw err;
    }

    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : id;

    try {
      scaffoldProjectOnDisk({ installRoot, id, name, preset });
    } catch (err) {
      if (err instanceof ProjectAlreadyExistsError) {
        return c.json({ error: "A project with that id already exists." }, 409);
      }
      throw err;
    }

    // Register the project so `GET /api/projects` includes it
    //  immediately. The routes under `/api/projects/:id/*` won't
    //  exist until the server restarts — that's explicit in the
    //  response.
    projectRegistry.ensureProject(id, name, preset);

    return c.json(
      {
        id,
        name,
        preset,
        restartRequired: true,
        message:
          "Project created. Restart the Ironlore server to activate its routes, then switch from the project list.",
      },
      201,
    );
  });

  // Cross-project copy. Mounted under `/api/projects` (not per-project)
  //  because it spans two projects' StorageWriters — the source is in
  //  the URL, the target comes from the request body. Protected by the
  //  same /api/projects/* auth middleware.
  app.route(
    "/api/projects",
    createCrossProjectCopyApi({
      resolveProject: (projectId) => servicesById.get(projectId) ?? null,
    }),
  );

  // Expose an aggregated WAL for the health endpoint — sum of depths
  //  across every project. A single `wal` module-level was wrong for
  //  multi-project anyway.
  const primaryServices =
    servicesById.get(DEFAULT_PROJECT_ID) ?? Array.from(servicesById.values())[0];
  wal = primaryServices?.wal ?? null;

  // Mount /metrics endpoint (Prometheus text format, behind auth, opt-in)
  if (process.env.IRONLORE_METRICS === "true") {
    const metricsApi = createMetricsEndpoint(() => wal);
    app.use("/metrics", authMiddleware);
    app.route("/metrics", metricsApi);
  }

  // Static SPA serving — opt-in via `IRONLORE_SERVE_STATIC=<dir>`.
  // The Electron shell sets this to its bundled `dist/client`
  // path; normal dev keeps Vite as the SPA host and the env
  // unset. The middleware sits AFTER every API route so a path
  // collision never shadows an endpoint, with an SPA fallback to
  // `index.html` for unknown paths so client-side routing works.
  // Per docs/07-tech-stack.md §Electron shell.
  const staticDir = process.env.IRONLORE_SERVE_STATIC;
  if (staticDir) {
    const { serveStatic } = await import("@hono/node-server/serve-static");
    const { resolve, isAbsolute } = await import("node:path");
    const root = isAbsolute(staticDir) ? staticDir : resolve(process.cwd(), staticDir);
    app.use(
      "*",
      serveStatic({
        root,
        // serve-static treats `root` as relative to cwd. We always
        // hand it an absolute path; the rewriter is a no-op that
        // still lets the middleware match against any URL.
        rewriteRequestPath: (path) => path.replace(/^\/+/, "/"),
      }),
    );
    // SPA fallback — for any non-API path that didn't hit a static
    // file, return index.html so client-side routes hydrate.
    const { readFileSync } = await import("node:fs");
    const indexHtml = readFileSync(`${root}/index.html`, "utf-8");
    app.notFound((c) => {
      const path = new URL(c.req.url).pathname;
      // API / WS / health / ready paths are real 404s — we only
      // fall through to index.html for "looks like a page" paths.
      if (
        path.startsWith("/api/") ||
        path.startsWith("/ws") ||
        path === "/health" ||
        path === "/ready"
      ) {
        return c.json({ error: "Not Found" }, 404);
      }
      return c.html(indexHtml);
    });
    console.log(`Serving static SPA from ${root}`);
  }

  // Initialize WebSocket manager for real-time events
  wsManager = new WebSocketManager(sessionStore, validateCookie);

  // Surface any recovery warnings as a persistent WS event. The event
  // enters the replay buffer, so any client that connects afterward
  // receives it via replay — matching
  // docs/02-storage-and-sync.md §User-visible recovery surface.
  if (allWarningsStructured.length > 0) {
    wsManager.broadcast({
      type: "recovery:pending",
      paths: allWarningsStructured.map((w) => `${w.projectId}:${w.path}`),
      messages: allWarningsStructured.map((w) => w.message),
    });
  }

  // Initialize terminal manager (single-session PTY over WS). The
  //  terminal binds to the primary project's data root for now; a
  //  per-session project-scoped terminal is a follow-up once the
  //  project switcher lands client-side.
  if (primaryServices) {
    terminalManager = new TerminalManager(
      primaryServices.getDataRoot(),
      sessionStore,
      validateCookie,
      primaryServices === servicesById.get(DEFAULT_PROJECT_ID)
        ? DEFAULT_PROJECT_ID
        : (projectList[0]?.id ?? DEFAULT_PROJECT_ID),
    );
  }

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
    } else if (req.url === "/ws/terminal" && termMgr) {
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
