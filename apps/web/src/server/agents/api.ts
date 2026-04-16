import { Hono } from "hono";
import type { WorkerPool } from "../jobs/worker.js";
import type { AgentRails } from "./rails.js";

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
export function createAgentApi(pool: WorkerPool, rails: AgentRails, projectId: string): Hono {
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
    }>();

    const mode = body.mode ?? "interactive";

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
      payload: { prompt: body.prompt ?? "" },
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

  return api;
}

/**
 * Job-level API routes (not agent-scoped).
 *
 * Mounted at `/api/projects/:id/jobs`.
 */
export function createJobApi(pool: WorkerPool): Hono {
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

  return api;
}
