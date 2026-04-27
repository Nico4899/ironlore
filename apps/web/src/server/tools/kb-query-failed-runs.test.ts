import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openJobsDb } from "../jobs/schema.js";
import { createKbQueryFailedRuns } from "./kb-query-failed-runs.js";
import type { ToolCallContext } from "./types.js";

/**
 * `kb.query_failed_runs` — evolver-agent helper.
 *
 * Pinning four behaviours:
 *   1. Project isolation — only runs from `ctx.projectId` are
 *      returned (a research-project run can't read main's failures).
 *   2. Per-agent bucket includes runCount, retryCount, and the
 *      most-recent error string truncated to 240 chars.
 *   3. Per-tool bucket aggregates `tool.error` events from the
 *      same window, sorted by errorCount desc.
 *   4. The look-back window honors `sinceHours` — older rows are
 *      excluded.
 */

let tmp: string;
let db: Database.Database;

const ctx: ToolCallContext = {
  projectId: "main",
  agentSlug: "evolver",
  jobId: "evo-test",
  emitEvent: () => undefined,
  dataRoot: "",
  fetch: globalThis.fetch,
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "failed-runs-"));
  db = openJobsDb(join(tmp, "jobs.sqlite"));
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Insert a finished job row directly. Bypasses the worker pool so
 * tests stay synchronous. Mirrors the columns the worker would
 * have written on completion.
 */
function insertJob(opts: {
  id: string;
  projectId: string;
  ownerId: string;
  status: "done" | "failed";
  attempts: number;
  finishedAtOffsetHours: number;
  result: string | null;
}): void {
  const finishedAt = Date.now() - opts.finishedAtOffsetHours * 60 * 60 * 1000;
  db.prepare(
    `INSERT INTO jobs (
       id, project_id, kind, mode, owner_id, payload, status,
       attempts, max_attempts, scheduled_at, started_at, finished_at,
       result, created_at
     ) VALUES (?, ?, 'agent.run', 'autonomous', ?, '{}', ?, ?, 3, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.projectId,
    opts.ownerId,
    opts.status,
    opts.attempts,
    finishedAt,
    finishedAt,
    finishedAt,
    opts.result,
    finishedAt,
  );
}

function insertEvent(opts: {
  projectId: string;
  jobId: string;
  kind: string;
  data: object;
  tsOffsetHours: number;
}): void {
  const ts = Date.now() - opts.tsOffsetHours * 60 * 60 * 1000;
  db.prepare(
    `INSERT INTO job_events (project_id, job_id, seq, ts, kind, data)
     VALUES (?, ?, 1, ?, ?, ?)`,
  ).run(opts.projectId, opts.jobId, ts, opts.kind, JSON.stringify(opts.data));
}

describe("kb.query_failed_runs", () => {
  it("returns empty buckets when no failed runs exist", async () => {
    const tool = createKbQueryFailedRuns(db);
    const out = JSON.parse(await tool.execute({}, ctx)) as {
      perAgent: unknown[];
      perTool: unknown[];
    };
    expect(out.perAgent).toEqual([]);
    expect(out.perTool).toEqual([]);
  });

  it("buckets failed runs by agent slug with runCount + retryCount + lastError", async () => {
    insertJob({
      id: "j1",
      projectId: "main",
      ownerId: "researcher",
      status: "failed",
      attempts: 2,
      finishedAtOffsetHours: 1,
      result: "kb.replace_block: ETag mismatch — page modified concurrently",
    });
    insertJob({
      id: "j2",
      projectId: "main",
      ownerId: "researcher",
      status: "failed",
      attempts: 1,
      finishedAtOffsetHours: 2,
      result: "rate limited (429)",
    });
    insertJob({
      id: "j3",
      projectId: "main",
      ownerId: "editor",
      status: "failed",
      attempts: 3,
      finishedAtOffsetHours: 4,
      result: "missing block id",
    });

    const tool = createKbQueryFailedRuns(db);
    const out = JSON.parse(await tool.execute({}, ctx)) as {
      perAgent: Array<{
        agent: string;
        runCount: number;
        retryCount: number;
        lastError: string;
      }>;
    };

    // Sorted by runCount desc — researcher first (2 failed), editor second.
    expect(out.perAgent[0]?.agent).toBe("researcher");
    expect(out.perAgent[0]?.runCount).toBe(2);
    expect(out.perAgent[0]?.retryCount).toBe(1); // j1 had attempts=2
    expect(out.perAgent[0]?.lastError).toMatch(/ETag mismatch/);
    expect(out.perAgent[1]?.agent).toBe("editor");
    expect(out.perAgent[1]?.runCount).toBe(1);
  });

  it("isolates by project — runs in `research` are invisible to a `main` query", async () => {
    insertJob({
      id: "main-fail",
      projectId: "main",
      ownerId: "agent",
      status: "failed",
      attempts: 1,
      finishedAtOffsetHours: 1,
      result: "main error",
    });
    insertJob({
      id: "research-fail",
      projectId: "research",
      ownerId: "agent",
      status: "failed",
      attempts: 1,
      finishedAtOffsetHours: 1,
      result: "research error — should not surface",
    });

    const tool = createKbQueryFailedRuns(db);
    const out = JSON.parse(await tool.execute({}, ctx)) as {
      perAgent: Array<{ lastError: string }>;
    };
    expect(out.perAgent).toHaveLength(1);
    expect(out.perAgent[0]?.lastError).toBe("main error");
  });

  it("excludes runs older than the sinceHours window (default 24h)", async () => {
    insertJob({
      id: "fresh",
      projectId: "main",
      ownerId: "a",
      status: "failed",
      attempts: 1,
      finishedAtOffsetHours: 1,
      result: "fresh error",
    });
    insertJob({
      id: "stale",
      projectId: "main",
      ownerId: "a",
      status: "failed",
      attempts: 1,
      finishedAtOffsetHours: 48,
      result: "stale error — outside default 24h window",
    });

    const tool = createKbQueryFailedRuns(db);
    const out = JSON.parse(await tool.execute({}, ctx)) as {
      perAgent: Array<{ runCount: number; lastError: string }>;
    };
    expect(out.perAgent[0]?.runCount).toBe(1);
    expect(out.perAgent[0]?.lastError).toBe("fresh error");
  });

  it("respects a caller-supplied sinceHours override", async () => {
    insertJob({
      id: "older",
      projectId: "main",
      ownerId: "a",
      status: "failed",
      attempts: 1,
      finishedAtOffsetHours: 36,
      result: "two-day-old error",
    });

    const tool = createKbQueryFailedRuns(db);
    const out = JSON.parse(await tool.execute({ sinceHours: 48 }, ctx)) as {
      perAgent: Array<{ runCount: number }>;
    };
    expect(out.perAgent[0]?.runCount).toBe(1);
  });

  it("aggregates tool.error events into the per-tool bucket sorted by errorCount", async () => {
    // Three tool errors: replace_block ×2, search ×1.
    insertEvent({
      projectId: "main",
      jobId: "j1",
      kind: "tool.error",
      data: { tool: "kb.replace_block", error: "stale etag" },
      tsOffsetHours: 1,
    });
    insertEvent({
      projectId: "main",
      jobId: "j2",
      kind: "tool.error",
      data: { tool: "kb.replace_block", error: "missing block" },
      tsOffsetHours: 2,
    });
    insertEvent({
      projectId: "main",
      jobId: "j3",
      kind: "tool.error",
      data: { tool: "kb.search", error: "fts5 syntax" },
      tsOffsetHours: 3,
    });
    // A non-error event — must not be counted.
    insertEvent({
      projectId: "main",
      jobId: "j4",
      kind: "tool.call",
      data: { tool: "kb.replace_block" },
      tsOffsetHours: 1,
    });

    const tool = createKbQueryFailedRuns(db);
    const out = JSON.parse(await tool.execute({}, ctx)) as {
      perTool: Array<{ tool: string; errorCount: number }>;
    };
    expect(out.perTool).toEqual([
      { tool: "kb.replace_block", errorCount: 2 },
      { tool: "kb.search", errorCount: 1 },
    ]);
  });

  it("truncates a multi-kilobyte error message to 240 chars (context-budget hygiene)", async () => {
    const longError = "A".repeat(2000);
    insertJob({
      id: "verbose",
      projectId: "main",
      ownerId: "a",
      status: "failed",
      attempts: 1,
      finishedAtOffsetHours: 1,
      result: longError,
    });

    const tool = createKbQueryFailedRuns(db);
    const out = JSON.parse(await tool.execute({}, ctx)) as {
      perAgent: Array<{ lastError: string }>;
    };
    expect(out.perAgent[0]?.lastError.length).toBe(240);
  });

  it("handles a malformed tool.error event row without crashing", async () => {
    db.prepare(
      `INSERT INTO job_events (project_id, job_id, seq, ts, kind, data)
       VALUES ('main', 'j1', 1, ?, 'tool.error', 'not-json{}}')`,
    ).run(Date.now() - 60 * 60 * 1000);

    const tool = createKbQueryFailedRuns(db);
    const out = JSON.parse(await tool.execute({}, ctx)) as { perTool: unknown[] };
    // Bad JSON → silently skipped, no entry. The query returns
    // empty `perTool` rather than throwing.
    expect(out.perTool).toEqual([]);
  });
});
