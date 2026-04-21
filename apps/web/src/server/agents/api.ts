import type Database from "better-sqlite3";
import { Hono } from "hono";
import type { WorkerPool } from "../jobs/worker.js";
import { estimateRunCost } from "./cost-estimate.js";
import type { DryRunBridge } from "./dry-run-bridge.js";
import type { AgentInbox } from "./inbox.js";
import { getAgentConfig, getHourlyHistogram, getRecentRuns } from "./observability.js";
import type { AgentRails } from "./rails.js";
import { revertAgentRun } from "./revert-run.js";

/**
 * Agent API routes.
 *
 * Endpoints:
 *   POST /agents/:slug/run    — start an interactive or autonomous run
 *   GET  /agents/:slug/state  — get agent status (active/paused/rate-limited)
 *   PATCH /agents/:slug/state — manual pause/resume
 *   GET  /jobs/:id            — get job status + metadata
 *   GET  /jobs/:id/events     — get durable event stream (with ?since=N)
 *
 * All routes are project-scoped via the parent mount path
 * (`/api/projects/:id/agents`). The `projectId` comes from the URL,
 * not from a header — consistent with the pages API.
 */
export function createAgentApi(
  pool: WorkerPool,
  rails: AgentRails,
  jobsDb: Database.Database,
  projectId: string,
  projectDir?: string,
): Hono {
  const api = new Hono();

  // -----------------------------------------------------------------------
  // Start an agent run
  // -----------------------------------------------------------------------
  api.post("/:slug/run", async (c) => {
    const slug = c.req.param("slug") ?? "";
    if (!slug) return c.json({ error: "Agent slug required" }, 400);

    const body = await c.req.json<{
      prompt?: string;
      mode?: "interactive" | "autonomous";
      /**
       * Effort preference forwarded from the composer's `/ → Model →
       *  Effort` slider (low/medium/high). Persisted per-session on
       *  the client; the executor is free to map this to provider
       *  params (e.g. temperature, max_tokens) once the provider
       *  protocol grows an `effort` field. Stored verbatim in the
       *  job payload today so recorded runs can later be replayed
       *  with the same preference.
       */
      effort?: "low" | "medium" | "high";
    }>();

    const mode = body.mode ?? "interactive";
    const effort: "low" | "medium" | "high" =
      body.effort === "low" || body.effort === "high" ? body.effort : "medium";

    // Check rails before enqueuing.
    if (mode === "autonomous") {
      const check = rails.canEnqueue(projectId, slug);
      if (!check.allowed) {
        return c.json({ error: check.reason }, 429);
      }
    }

    const jobId = pool.enqueue({
      projectId,
      kind: "agent.run",
      mode,
      ownerId: slug,
      payload: { prompt: body.prompt ?? "", effort },
    });

    // Record the run start for rate-limit tracking (autonomous only).
    if (mode === "autonomous") {
      rails.recordStart(projectId, slug, jobId);
    }

    return c.json({ jobId });
  });

  // -----------------------------------------------------------------------
  // Get agent state
  // -----------------------------------------------------------------------
  api.get("/:slug/state", (c) => {
    const slug = c.req.param("slug") ?? "";
    if (!slug) return c.json({ error: "Agent slug required" }, 400);

    // Ensure the state row exists (idempotent).
    rails.ensureState(projectId, slug);

    const check = rails.canEnqueue(projectId, slug);
    return c.json({
      slug,
      canRun: check.allowed,
      reason: check.allowed ? null : (check as { reason: string }).reason,
    });
  });

  // -----------------------------------------------------------------------
  // Manual pause / resume
  // -----------------------------------------------------------------------
  api.patch("/:slug/state", async (c) => {
    const slug = c.req.param("slug") ?? "";
    if (!slug) return c.json({ error: "Agent slug required" }, 400);

    const body = await c.req.json<{ paused: boolean }>();
    if (typeof body.paused !== "boolean") {
      return c.json({ error: "Body must include { paused: boolean }" }, 400);
    }

    rails.ensureState(projectId, slug);
    rails.setPauseState(projectId, slug, body.paused);

    return c.json({ ok: true, paused: body.paused });
  });

  // -----------------------------------------------------------------------
  // Agent observability — recent runs, hourly histogram, config.
  // See docs/04-ai-and-agents.md §§Run history and activity histogram
  // and §§Exposing persona frontmatter.
  // -----------------------------------------------------------------------
  api.get("/:slug/runs", (c) => {
    const slug = c.req.param("slug") ?? "";
    if (!slug) return c.json({ error: "Agent slug required" }, 400);

    // Clamp `limit` here too so bogus query strings don't reach SQLite.
    const rawLimit = Number.parseInt(c.req.query("limit") ?? "24", 10);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 24;

    const runs = getRecentRuns(jobsDb, projectId, slug, limit);
    return c.json({ runs });
  });

  api.get("/:slug/histogram", (c) => {
    const slug = c.req.param("slug") ?? "";
    if (!slug) return c.json({ error: "Agent slug required" }, 400);

    // `?hours=` lets the caller widen the window. The Home §03
    //  Run-rate viz asks for 48 h so it can compute the
    //  "current 24 h vs. prior 24 h" delta; Agent detail keeps the
    //  default 24. Clamped 1..48 in `getHourlyHistogram`.
    const rawHours = Number.parseInt(c.req.query("hours") ?? "24", 10);
    const hours = Number.isFinite(rawHours) ? rawHours : 24;

    // Ensure a state row so the cap falls back to defaults rather than
    //  returning 10/50 with no corresponding row downstream.
    rails.ensureState(projectId, slug);
    return c.json(getHourlyHistogram(jobsDb, projectId, slug, Date.now(), hours));
  });

  api.get("/:slug/config", (c) => {
    const slug = c.req.param("slug") ?? "";
    if (!slug) return c.json({ error: "Agent slug required" }, 400);

    rails.ensureState(projectId, slug);
    const config = getAgentConfig(jobsDb, projectId, slug, projectDir ?? null);
    if (!config) return c.json({ error: "Agent not found" }, 404);
    return c.json(config);
  });

  // -----------------------------------------------------------------------
  // List all agents (slugs only). Consumers that want the full config
  //  issue `GET /:slug/config` for each entry — keeps the list endpoint
  //  cheap when the UI only needs to populate a dropdown / nav.
  //
  //  The Settings → Security tab (docs/06-implementation-roadmap.md
  //  Phase 8) is the first consumer; it fetches this list and then one
  //  config per slug so the user can review scopes, tools, and rate
  //  caps across every installed agent.
  // -----------------------------------------------------------------------
  api.get("/", (c) => {
    const rows = jobsDb
      .prepare("SELECT slug, status FROM agent_state WHERE project_id = ? ORDER BY slug")
      .all(projectId) as Array<{ slug: string; status: "active" | "paused" }>;
    return c.json({ agents: rows });
  });

  // -----------------------------------------------------------------------
  // Onboarding: apply template variables to library personas
  // -----------------------------------------------------------------------
  api.post("/onboarding", async (c) => {
    const body = await c.req.json<{
      company_name?: string;
      company_description?: string;
      goals?: string;
    }>();

    // Read all library personas and replace {{...}} template variables.
    // Templates are seeded as `.library/<slug>/persona.md`, so walk the
    // tree rather than reading a flat directory — the pre-fix version
    // globbed top-level `.md` files only and never matched anything.
    const { existsSync, readFileSync, writeFileSync, readdirSync, statSync } = await import(
      "node:fs"
    );
    const { join } = await import("node:path");

    if (!projectDir) return c.json({ ok: false, error: "No project dir" }, 500);
    const libDir = join(projectDir, "data", ".agents", ".library");
    if (!existsSync(libDir)) {
      return c.json({ ok: true, updated: 0 });
    }

    function collectMarkdownFiles(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) {
            out.push(...collectMarkdownFiles(full));
          } else if (entry.endsWith(".md")) {
            out.push(full);
          }
        } catch {
          // Skip unreadable entries — don't fail the whole substitution pass.
        }
      }
      return out;
    }

    let updated = 0;
    for (const filePath of collectMarkdownFiles(libDir)) {
      let content = readFileSync(filePath, "utf-8");
      let changed = false;

      for (const [key, value] of Object.entries(body)) {
        if (!value) continue;
        const placeholder = `{{${key}}}`;
        if (content.includes(placeholder)) {
          content = content.replaceAll(placeholder, value);
          changed = true;
        }
      }

      if (changed) {
        writeFileSync(filePath, content, "utf-8");
        updated++;
      }
    }

    return c.json({ ok: true, updated });
  });

  // -----------------------------------------------------------------------
  // Pre-run cost estimate
  // -----------------------------------------------------------------------
  api.get("/:slug/cost-estimate", (c) => {
    const model = c.req.query("model") ?? "claude-sonnet-4-20250514";
    const estimate = estimateRunCost(model, 2000, 4000, 8000);
    return c.json(estimate);
  });

  return api;
}

/**
 * Job-level API routes (not agent-scoped).
 *
 * Mounted at `/api/projects/:id/jobs`.
 */
export function createJobApi(
  pool: WorkerPool,
  projectDir: string,
  dryRunBridge?: DryRunBridge,
): Hono {
  const api = new Hono();

  // -----------------------------------------------------------------------
  // Get job status
  // -----------------------------------------------------------------------
  api.get("/:id", (c) => {
    const jobId = c.req.param("id") ?? "";
    const job = pool.getJob(jobId);
    if (!job) return c.json({ error: "Job not found" }, 404);

    return c.json({
      id: job.id,
      kind: job.kind,
      mode: job.mode,
      status: job.status,
      ownerId: job.owner_id,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
      result: job.result,
    });
  });

  // -----------------------------------------------------------------------
  // Get job events (durable stream with ?since=N replay)
  // -----------------------------------------------------------------------
  api.get("/:id/events", (c) => {
    const jobId = c.req.param("id") ?? "";
    const since = Number(c.req.query("since") ?? "0");

    const job = pool.getJob(jobId);
    if (!job) return c.json({ error: "Job not found" }, 404);

    const events = pool.getJobEvents(jobId, since);
    return c.json({ events, jobStatus: job.status });
  });

  // -----------------------------------------------------------------------
  // Revert a completed agent run
  // -----------------------------------------------------------------------
  // -----------------------------------------------------------------------
  // Revert a completed agent run
  // -----------------------------------------------------------------------
  api.post("/:id/revert", (c) => {
    const jobId = c.req.param("id") ?? "";
    const job = pool.getJob(jobId);
    if (!job) return c.json({ error: "Job not found" }, 404);
    if (job.status !== "done") {
      return c.json({ error: "Can only revert completed jobs" }, 400);
    }
    if (!job.commit_sha_start || !job.commit_sha_end) {
      return c.json({ error: "Job has no commit range to revert" }, 400);
    }

    const result = revertAgentRun(job, projectDir);
    return c.json(result);
  });

  // -----------------------------------------------------------------------
  // Submit a dry-run verdict for a pending tool call
  // -----------------------------------------------------------------------
  // When an agent runs under `review_mode: dry_run`, every destructive
  // tool call emits `diff_preview` and waits on the DryRunBridge. The
  // AI panel's DiffPreview component posts here when the user hits
  // approve or reject; a `true` response means the verdict routed back
  // to the pending dispatcher call.
  api.post("/:id/approve", async (c) => {
    if (!dryRunBridge) {
      return c.json({ error: "Dry-run bridge not configured" }, 501);
    }
    const jobId = c.req.param("id") ?? "";
    const job = pool.getJob(jobId);
    if (!job) return c.json({ error: "Job not found" }, 404);

    const body = await c.req.json<{ toolCallId?: string; verdict?: "approve" | "reject" }>();
    if (!body.toolCallId || (body.verdict !== "approve" && body.verdict !== "reject")) {
      return c.json(
        { error: "Body must include toolCallId + verdict ('approve' | 'reject')" },
        400,
      );
    }

    const delivered = dryRunBridge.submitVerdict(body.toolCallId, body.verdict);
    if (!delivered) {
      return c.json({ error: "No pending verdict for that tool call" }, 404);
    }
    return c.json({ ok: true });
  });

  return api;
}

/**
 * Inbox API routes.
 *
 * Mounted at `/api/projects/:id/inbox`.
 */
export function createInboxApi(inbox: AgentInbox, projectId: string, projectDir: string): Hono {
  const api = new Hono();

  api.get("/", (c) => {
    const entries = inbox.getPending(projectId);
    return c.json({ entries });
  });

  api.get("/:entryId/files", (c) => {
    const entryId = c.req.param("entryId") ?? "";
    if (!entryId) return c.json({ error: "Entry id required" }, 400);
    const files = inbox.getFileDiffStats(entryId, projectDir);
    return c.json({ files });
  });

  api.post("/:entryId/files/decision", async (c) => {
    const entryId = c.req.param("entryId") ?? "";
    if (!entryId) return c.json({ error: "Entry id required" }, 400);
    const body = await c.req.json<{ path?: string; decision?: string | null }>();
    if (!body.path || typeof body.path !== "string") {
      return c.json({ error: "Body must include a file path" }, 400);
    }
    const decision =
      body.decision === "approved" || body.decision === "rejected" ? body.decision : null;
    return c.json(inbox.setFileDecision(entryId, body.path, decision));
  });

  api.post("/:entryId/approve", (c) => {
    const entryId = c.req.param("entryId") ?? "";
    const result = inbox.approveAll(entryId, projectDir);
    return c.json(result);
  });

  api.post("/:entryId/reject", (c) => {
    const entryId = c.req.param("entryId") ?? "";
    const result = inbox.rejectAll(entryId, projectDir);
    return c.json(result);
  });

  return api;
}
