import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { load as loadYaml } from "js-yaml";

/**
 * Per-agent observability queries — the read-only projections behind
 * the `AgentDetailPage` recent-runs table, hourly histogram, and
 * config rows.
 *
 * See docs/04-ai-and-agents.md §§Run history and activity histogram
 * and §§Exposing persona frontmatter. Every query reuses the same
 * `agent_runs (project_id, slug, started_at)` index that powers
 * `AgentRails.canEnqueue()` so the UI and the rate limiter can never
 * disagree about what's been happening.
 */

/** One run row as the client sees it on the detail page. */
export interface AgentRunRecord {
  jobId: string;
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "healthy" | "warn" | "error";
  /** Number of `tool_use` events emitted during the run. */
  stepCount: number;
  /** One-line human description — from the final event's `summary` field when present. */
  note: string | null;
  commitShaStart: string | null;
  commitShaEnd: string | null;
}

export interface AgentHistogramResponse {
  /** Inclusive window bound in ms since epoch. */
  windowStart: number;
  /** Exclusive window bound in ms since epoch — the "now" at query time. */
  windowEnd: number;
  /** Always 24 today; reserved for future zoom ranges. */
  bucketHours: number;
  /** Counts per hour, oldest → newest. Empty buckets are zero-padded. */
  buckets: number[];
  cap: { perHour: number; perDay: number };
}

export interface AgentConfigResponse {
  slug: string;
  status: "active" | "paused";
  pauseReason: string | null;
  maxRunsPerHour: number;
  maxRunsPerDay: number;
  failureStreak: number;
  personaPath: string | null;
  /**
   * Positive seconds when persona.md's mtime is newer than
   * `agent_state.updated_at`. Zero or null means the rails state is
   * in sync with the file on disk. Lets the UI surface a drift chip
   * without a separate endpoint.
   */
  personaMtimeDriftSeconds: number | null;
  /**
   * Persona-frontmatter projection — only populated when the file is
   * readable. Every field is independently nullable so a persona that
   * omits (say) `heartbeat` still renders the rest of the rail. The
   * values here are the file's source of truth; rails mirror them on
   * next reload.
   */
  persona: {
    /**
     * One-line prose description from the persona frontmatter. Surfaces
     * as the sub-heading on the Agent-detail hero so the surface
     * actually introduces each agent instead of showing boilerplate.
     * Null when the frontmatter omits `description`.
     */
    description: string | null;
    heartbeat: string | null;
    reviewMode: "auto-commit" | "inbox" | null;
    tools: string[] | null;
    budget: { tokens: number | null; toolCalls: number | null; fsyncMs: number | null } | null;
    scope: { pages: string[] | null; writableKinds: string[] | null } | null;
  } | null;
}

const HOUR_MS = 3_600_000;
const WINDOW_BUCKETS = 24;

/** Matches the leading YAML frontmatter block of a persona file. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * Parse the persona's YAML frontmatter into the projection shape the
 * AgentDetailPage expects. Returns `null` for any field whose source
 * is missing, malformed, or the wrong type — callers render "—" and
 * move on, rather than tanking the whole config rail on one bad key.
 *
 * This is a projection, not a schema. The executor has the canonical
 * view of persona fields for runtime; this helper only surfaces the
 * ones visible on the detail page.
 */
function parsePersonaFrontmatter(raw: string): AgentConfigResponse["persona"] {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match?.[1]) return null;

  let doc: Record<string, unknown>;
  try {
    const parsed = loadYaml(match[1]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    doc = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  // Description — one-liner shown on the Agent-detail hero. We
  //  accept a few common key spellings (`description`, `summary`,
  //  `purpose`) so older personas written against an earlier schema
  //  still render useful text without a migration.
  const rawDescription =
    (typeof doc.description === "string" && doc.description) ||
    (typeof doc.summary === "string" && doc.summary) ||
    (typeof doc.purpose === "string" && doc.purpose) ||
    null;
  const description = rawDescription ? rawDescription.trim() : null;

  const heartbeat = typeof doc.heartbeat === "string" ? doc.heartbeat : null;

  const rawReview = typeof doc.review_mode === "string" ? doc.review_mode : null;
  const reviewMode =
    rawReview === "auto-commit" || rawReview === "inbox"
      ? (rawReview as "auto-commit" | "inbox")
      : null;

  const tools = Array.isArray(doc.tools)
    ? (doc.tools.filter((t: unknown): t is string => typeof t === "string") as string[])
    : null;

  // Budget can live either as three top-level keys (token_budget,
  //  tool_call_cap, fsync_ms) or nested under `budget:`. Accept both.
  const budgetNested =
    doc.budget && typeof doc.budget === "object" && !Array.isArray(doc.budget)
      ? (doc.budget as Record<string, unknown>)
      : null;
  const budgetTokens = pickNumber(doc.token_budget ?? budgetNested?.tokens);
  const budgetToolCalls = pickNumber(doc.tool_call_cap ?? budgetNested?.tool_calls);
  const budgetFsyncMs = pickNumber(doc.fsync_ms ?? budgetNested?.fsync_ms);
  const budget =
    budgetTokens !== null || budgetToolCalls !== null || budgetFsyncMs !== null
      ? { tokens: budgetTokens, toolCalls: budgetToolCalls, fsyncMs: budgetFsyncMs }
      : null;

  const scopeSrc =
    doc.scope && typeof doc.scope === "object" && !Array.isArray(doc.scope)
      ? (doc.scope as Record<string, unknown>)
      : null;
  const scopePages = Array.isArray(scopeSrc?.pages)
    ? (scopeSrc.pages.filter((p: unknown): p is string => typeof p === "string") as string[])
    : null;
  const scopeWritable = Array.isArray(scopeSrc?.writable_kinds)
    ? (scopeSrc.writable_kinds.filter(
        (k: unknown): k is string => typeof k === "string",
      ) as string[])
    : null;
  const scope =
    scopePages !== null || scopeWritable !== null
      ? { pages: scopePages, writableKinds: scopeWritable }
      : null;

  return { description, heartbeat, reviewMode, tools, budget, scope };
}

function pickNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Collapse a raw `jobs.status` into the four display states the
 * StatusPip uses. Deliberately conservative: anything the job table
 * reports as `failed` or `cancelled` is an `error` for the user.
 */
function mapStatus(raw: string): AgentRunRecord["status"] {
  switch (raw) {
    case "running":
      return "running";
    case "done":
      return "healthy";
    case "failed":
    case "cancelled":
      return "error";
    default:
      // queued/unknown show as `running` so the user sees the job is
      //  in flight even before the worker claims it.
      return "running";
  }
}

/**
 * Extract a short human-readable note from the job result blob. The
 * executor writes a JSON object like `{ outcome, filesChanged, ... }`;
 * we reduce it to a single sentence without inventing fields that
 * aren't in the payload.
 */
function extractNote(resultRaw: string | null): string | null {
  if (!resultRaw) return null;
  try {
    const parsed = JSON.parse(resultRaw) as {
      outcome?: string;
      filesChanged?: string[];
      inboxBranch?: string;
      error?: string;
    };
    if (parsed.error) return parsed.error;
    const files = parsed.filesChanged?.length ?? 0;
    if (parsed.outcome === "finalized" && parsed.inboxBranch) {
      return `inbox branch · ${files} file${files === 1 ? "" : "s"}`;
    }
    if (parsed.outcome === "completed") {
      return `${files} file${files === 1 ? "" : "s"} written`;
    }
    return parsed.outcome ?? null;
  } catch {
    return null;
  }
}

/**
 * Last N runs for an agent, newest first. Joins `agent_runs` to the
 * canonical `jobs` row so status, commit range, and the raw result
 * blob flow through in one query.
 *
 * `limit` is clamped to [1, 200]; callers that pass junk get a sane
 * default rather than an error — this is an observability surface,
 * not a security one.
 */
export function getRecentRuns(
  db: Database.Database,
  projectId: string,
  slug: string,
  limit = 24,
): AgentRunRecord[] {
  const clamped = Math.max(1, Math.min(200, Math.floor(limit)));

  const rows = db
    .prepare(
      `SELECT
         ar.job_id       AS jobId,
         ar.started_at   AS startedAt,
         j.finished_at   AS finishedAt,
         j.status        AS status,
         j.result        AS result,
         j.commit_sha_start AS commitShaStart,
         j.commit_sha_end   AS commitShaEnd
       FROM agent_runs ar
       LEFT JOIN jobs j ON j.id = ar.job_id
       WHERE ar.project_id = ? AND ar.slug = ?
       ORDER BY ar.started_at DESC
       LIMIT ?`,
    )
    .all(projectId, slug, clamped) as Array<{
    jobId: string;
    startedAt: number;
    finishedAt: number | null;
    status: string | null;
    result: string | null;
    commitShaStart: string | null;
    commitShaEnd: string | null;
  }>;

  // Step count comes from `tool_use` events. Batch the lookup so we
  //  don't issue N+1 queries when the runs list has 24 entries.
  const stepCounts = new Map<string, number>();
  if (rows.length > 0) {
    const placeholders = rows.map(() => "?").join(",");
    const eventRows = db
      .prepare(
        `SELECT job_id AS jobId, COUNT(*) AS cnt FROM job_events
         WHERE kind = 'tool_use' AND job_id IN (${placeholders})
         GROUP BY job_id`,
      )
      .all(...rows.map((r) => r.jobId)) as Array<{ jobId: string; cnt: number }>;
    for (const ev of eventRows) stepCounts.set(ev.jobId, ev.cnt);
  }

  return rows.map((r) => ({
    jobId: r.jobId,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    status: mapStatus(r.status ?? "running"),
    stepCount: stepCounts.get(r.jobId) ?? 0,
    note: extractNote(r.result),
    commitShaStart: r.commitShaStart,
    commitShaEnd: r.commitShaEnd,
  }));
}

/**
 * Rolling 24-hour histogram of runs-per-hour for a given agent. The
 * bucketing logic mirrors `AgentRails.canEnqueue()`'s window exactly:
 * we bucket by floor(started_at / HOUR_MS) so an hour "1713358920000"
 * lands in the same bucket whether the user asks at :00 or :59.
 *
 * Empty buckets are zero-padded so the client can render 24 bars
 * without defensive coding.
 */
export function getHourlyHistogram(
  db: Database.Database,
  projectId: string,
  slug: string,
  now: number = Date.now(),
  hours: number = WINDOW_BUCKETS,
): AgentHistogramResponse {
  // Clamp `hours` to a sensible range (1..48). The Home §03 Run-rate
  //  viz asks for 48 to compute a "vs. prior day" delta; the Agent
  //  detail page sticks to 24. The bucketing math is identical, only
  //  the slot count and window start shift.
  const bucketCount = Math.max(1, Math.min(48, Math.floor(hours)));
  const windowEnd = now;
  const windowStart = windowEnd - bucketCount * HOUR_MS;

  const rawRows = db
    .prepare(
      `SELECT CAST(started_at / ? AS INTEGER) AS hourBucket, COUNT(*) AS cnt
       FROM agent_runs
       WHERE project_id = ? AND slug = ? AND started_at >= ?
       GROUP BY hourBucket`,
    )
    .all(HOUR_MS, projectId, slug, windowStart) as Array<{ hourBucket: number; cnt: number }>;

  // Build an oldest → newest array. `endBucket` is the hour bucket
  //  the window's end moment falls into; the oldest we show is
  //  `bucketCount - 1` buckets before that (inclusive).
  const endBucket = Math.floor(windowEnd / HOUR_MS);
  const startBucket = endBucket - (bucketCount - 1);
  const buckets = new Array<number>(bucketCount).fill(0);
  for (const row of rawRows) {
    const idx = row.hourBucket - startBucket;
    if (idx >= 0 && idx < bucketCount) buckets[idx] = row.cnt;
  }

  // Rate caps from agent_state. Missing row → the rails defaults.
  const state = db
    .prepare(
      "SELECT max_runs_per_hour AS perHour, max_runs_per_day AS perDay FROM agent_state WHERE project_id = ? AND slug = ?",
    )
    .get(projectId, slug) as { perHour: number; perDay: number } | undefined;

  return {
    windowStart,
    windowEnd,
    bucketHours: bucketCount,
    buckets,
    cap: { perHour: state?.perHour ?? 10, perDay: state?.perDay ?? 50 },
  };
}

/**
 * Read-only projection of persona frontmatter via `agent_state`.
 * Never re-parses the on-disk persona file — `agent_state` is the
 * canonical mirror and what the scheduler actually obeys. The returned
 * `personaMtimeDriftSeconds` tells the UI when the file's mtime is
 * newer than the mirror, so a "reload persona" hint can surface.
 *
 * Passing `null` for `projectDir` suppresses the mtime check —
 * callers without filesystem access (tests, embedded shells) just
 * get `personaPath: null, personaMtimeDriftSeconds: null` back.
 */
export function getAgentConfig(
  db: Database.Database,
  projectId: string,
  slug: string,
  projectDir: string | null,
): AgentConfigResponse | null {
  const row = db
    .prepare(
      `SELECT slug, status, max_runs_per_hour AS maxRunsPerHour,
              max_runs_per_day AS maxRunsPerDay,
              failure_streak  AS failureStreak,
              pause_reason    AS pauseReason,
              updated_at      AS updatedAt
       FROM agent_state WHERE project_id = ? AND slug = ?`,
    )
    .get(projectId, slug) as
    | {
        slug: string;
        status: "active" | "paused";
        maxRunsPerHour: number;
        maxRunsPerDay: number;
        failureStreak: number;
        pauseReason: string | null;
        updatedAt: number;
      }
    | undefined;

  if (!row) return null;

  let personaPath: string | null = null;
  let personaMtimeDriftSeconds: number | null = null;
  let persona: AgentConfigResponse["persona"] = null;

  if (projectDir) {
    personaPath = join("data", ".agents", slug, "persona.md");
    const absPath = join(projectDir, personaPath);
    try {
      const stat = statSync(absPath);
      const driftMs = stat.mtime.getTime() - row.updatedAt;
      personaMtimeDriftSeconds = driftMs > 0 ? Math.floor(driftMs / 1000) : 0;
    } catch {
      // File missing — treat as no drift; agent may live elsewhere.
      personaMtimeDriftSeconds = null;
    }

    // The persona parse is independent of the mtime stat — a fresh
    //  file with corrupt YAML still gets a drift number but a null
    //  persona projection. Reading on every request is cheap (one
    //  small markdown file) and guarantees the UI never shows a
    //  stale frontmatter projection.
    try {
      const raw = readFileSync(absPath, "utf-8");
      persona = parsePersonaFrontmatter(raw);
    } catch {
      persona = null;
    }
  }

  return {
    slug: row.slug,
    status: row.status,
    pauseReason: row.pauseReason,
    maxRunsPerHour: row.maxRunsPerHour,
    maxRunsPerDay: row.maxRunsPerDay,
    failureStreak: row.failureStreak,
    personaPath,
    personaMtimeDriftSeconds,
    persona,
  };
}
