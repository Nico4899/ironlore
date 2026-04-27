import type Database from "better-sqlite3";
import type { ToolCallContext, ToolImplementation } from "./types.js";

/**
 * `kb.query_failed_runs` — Phase-11 evolver-agent helper.
 *
 * Surfaces aggregated failure patterns from the past N hours so the
 * evolver workflow can spot recurring problems (e.g. "the
 * researcher keeps failing on `kb.replace_block` with stale
 * ETags") and propose a skill-file edit. Project-scoped — the
 * tool only ever returns rows for the calling agent's
 * `ctx.projectId`, so a run in `research` can't read failures
 * from `main`.
 *
 * Returns two layers:
 *   1. **Per-agent buckets** — each agent that had a failure or a
 *      retry in the window, with the run count + the most-common
 *      failure reason verbatim. The evolver uses this to decide
 *      *which* skill to inspect.
 *   2. **Per-tool error counts** — across the same set of runs, the
 *      tools that errored most often. The evolver pulls this into
 *      the "what specifically failed" framing of its proposed edit.
 *
 * Read-only by construction — no mutations, no `writable_kinds`
 * gate. The evolver runs under `review_mode: inbox` so any skill
 * file it then edits via `kb.replace_block` lands on a staging
 * branch the user reviews before merge.
 */

interface FailedRunRow {
  agent: string;
  runCount: number;
  retryCount: number;
  /** Most-recent error string seen across the agent's failed
   *  runs. Truncated to 240 chars so the evolver's context budget
   *  doesn't get eaten by a stack trace. */
  lastError: string;
}

interface ToolErrorRow {
  tool: string;
  errorCount: number;
}

const DEFAULT_SINCE_HOURS = 24;
const DEFAULT_LIMIT = 50;
const ERROR_TRUNCATE = 240;

export function createKbQueryFailedRuns(jobsDb: Database.Database): ToolImplementation {
  return {
    definition: {
      name: "kb.query_failed_runs",
      description:
        "Aggregate failed + retried agent runs from the past N hours, grouped by " +
        "agent slug + by tool name. Returns { window, perAgent, perTool } so the " +
        "evolver workflow can spot recurring failure patterns and propose skill " +
        "edits. Read-only. Project-scoped: only surfaces runs from the calling " +
        "agent's project.",
      inputSchema: {
        type: "object",
        properties: {
          sinceHours: {
            type: "number",
            description: "Look-back window in hours. Default 24.",
          },
          limit: {
            type: "number",
            description: "Max rows in each bucket. Default 50.",
          },
        },
      },
    },
    async execute(args: unknown, ctx: ToolCallContext): Promise<string> {
      const input = (args as { sinceHours?: number; limit?: number }) ?? {};
      const sinceHours =
        typeof input.sinceHours === "number" && input.sinceHours > 0
          ? input.sinceHours
          : DEFAULT_SINCE_HOURS;
      const limit =
        typeof input.limit === "number" && input.limit > 0 ? input.limit : DEFAULT_LIMIT;
      const sinceTs = Date.now() - sinceHours * 60 * 60 * 1000;

      // Per-agent bucket — count failed + retried runs grouped by
      // owner_id (the persona slug). Picks `attempts > 1` OR
      // `status = 'failed'` so a successful retry on a flaky run
      // still surfaces as a learning signal.
      const perAgentRaw = jobsDb
        .prepare(
          `SELECT
             owner_id           AS agent,
             COUNT(*)           AS runCount,
             SUM(CASE WHEN attempts > 1 THEN 1 ELSE 0 END) AS retryCount
           FROM jobs
           WHERE project_id = ?
             AND finished_at IS NOT NULL
             AND finished_at >= ?
             AND (status = 'failed' OR attempts > 1)
             AND owner_id IS NOT NULL
           GROUP BY owner_id
           ORDER BY runCount DESC
           LIMIT ?`,
        )
        .all(ctx.projectId, sinceTs, limit) as Array<{
        agent: string;
        runCount: number;
        retryCount: number;
      }>;

      // For each agent, fetch the last error string — kept as a
      // separate query because SQLite's GROUP BY + last-value
      // semantics are murky across versions. One small lookup per
      // bucket; the bucket count is bounded by `limit`.
      const lastErrorStmt = jobsDb.prepare(
        `SELECT result FROM jobs
         WHERE project_id = ?
           AND owner_id = ?
           AND status = 'failed'
           AND result IS NOT NULL
           AND finished_at >= ?
         ORDER BY finished_at DESC
         LIMIT 1`,
      );

      const perAgent: FailedRunRow[] = perAgentRaw.map((row) => {
        const errRow = lastErrorStmt.get(ctx.projectId, row.agent, sinceTs) as
          | { result: string }
          | undefined;
        const lastError = errRow?.result
          ? errRow.result.slice(0, ERROR_TRUNCATE)
          : "(no error message recorded)";
        return { ...row, lastError };
      });

      // Per-tool bucket — count `tool.error` events from the same
      // window across the same project. The dispatcher emits
      // `tool.error` with `{tool, error}` — pull tool name out of
      // the JSON payload and group.
      const toolErrorRows = jobsDb
        .prepare(
          `SELECT data FROM job_events
           WHERE project_id = ?
             AND kind = 'tool.error'
             AND ts >= ?`,
        )
        .all(ctx.projectId, sinceTs) as Array<{ data: string }>;

      const toolCounts = new Map<string, number>();
      for (const row of toolErrorRows) {
        try {
          const parsed = JSON.parse(row.data) as { tool?: string };
          const tool = parsed.tool ?? "unknown";
          toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
        } catch {
          // Malformed event row — skip silently rather than poison
          // the whole evolver run.
        }
      }

      const perTool: ToolErrorRow[] = [...toolCounts.entries()]
        .map(([tool, errorCount]) => ({ tool, errorCount }))
        .sort((a, b) => b.errorCount - a.errorCount)
        .slice(0, limit);

      return JSON.stringify({
        window: { sinceHours, sinceTs },
        perAgent,
        perTool,
      });
    },
  };
}
