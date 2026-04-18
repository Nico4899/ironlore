import { randomBytes } from "node:crypto";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openJobsDb } from "../jobs/schema.js";
import { getAgentConfig, getHourlyHistogram, getRecentRuns } from "./observability.js";
import { AgentRails } from "./rails.js";

/**
 * Observability queries — covers the three endpoints the
 * AgentDetailPage depends on. Reuses the rails.test pattern:
 * real SQLite in a temp dir, no mocks.
 *
 * These tests are the contract for docs/04-ai-and-agents.md §§Run
 * history and activity histogram + §§Exposing persona frontmatter.
 * If the shape on the wire changes, the client and docs must change
 * together.
 */

type JobsDb = ReturnType<typeof openJobsDb>;

function makeJobsDb(): { db: JobsDb; dir: string } {
  const dir = join(tmpdir(), `observability-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return { db: openJobsDb(join(dir, "jobs.sqlite")), dir };
}

/** Insert a synthetic job + agent_run + optional tool-use events. */
function insertRun(
  db: JobsDb,
  opts: {
    projectId?: string;
    slug: string;
    jobId: string;
    startedAt: number;
    finishedAt?: number | null;
    status?: string;
    result?: unknown;
    toolUseCount?: number;
    commitShaStart?: string;
    commitShaEnd?: string;
  },
): void {
  const {
    projectId = "main",
    slug,
    jobId,
    startedAt,
    finishedAt = null,
    status = "done",
    result = null,
    toolUseCount = 0,
    commitShaStart = null,
    commitShaEnd = null,
  } = opts;

  db.prepare(
    `INSERT INTO jobs (id, project_id, kind, scheduled_at, status, started_at, finished_at,
                       result, commit_sha_start, commit_sha_end, created_at)
     VALUES (?, ?, 'agent_run', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobId,
    projectId,
    startedAt,
    status,
    startedAt,
    finishedAt,
    result == null ? null : JSON.stringify(result),
    commitShaStart,
    commitShaEnd,
    startedAt,
  );

  db.prepare(
    "INSERT INTO agent_runs (project_id, slug, started_at, job_id) VALUES (?, ?, ?, ?)",
  ).run(projectId, slug, startedAt, jobId);

  for (let i = 0; i < toolUseCount; i++) {
    db.prepare(
      `INSERT INTO job_events (project_id, job_id, seq, ts, kind, data)
       VALUES (?, ?, ?, ?, 'tool_use', '{}')`,
    ).run(projectId, jobId, i + 1, startedAt + i * 10);
  }
}

// ─── getRecentRuns ────────────────────────────────────────────────

describe("getRecentRuns", () => {
  let db: JobsDb;

  beforeEach(() => {
    ({ db } = makeJobsDb());
  });
  afterEach(() => db.close());

  it("returns runs in reverse chronological order", () => {
    const now = Date.now();
    insertRun(db, { slug: "a", jobId: "j1", startedAt: now - 3_000 });
    insertRun(db, { slug: "a", jobId: "j2", startedAt: now - 1_000 });
    insertRun(db, { slug: "a", jobId: "j3", startedAt: now - 2_000 });

    const runs = getRecentRuns(db, "main", "a");
    expect(runs.map((r) => r.jobId)).toEqual(["j2", "j3", "j1"]);
  });

  it("clamps limit to [1, 200] and never 0", () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      insertRun(db, { slug: "a", jobId: `j${i}`, startedAt: now - i * 1_000 });
    }
    expect(getRecentRuns(db, "main", "a", 0)).toHaveLength(1);
    expect(getRecentRuns(db, "main", "a", -5)).toHaveLength(1);
    expect(getRecentRuns(db, "main", "a", 999)).toHaveLength(5);
  });

  it("counts tool_use events as stepCount", () => {
    insertRun(db, { slug: "a", jobId: "j1", startedAt: Date.now(), toolUseCount: 4 });
    const runs = getRecentRuns(db, "main", "a");
    expect(runs[0]?.stepCount).toBe(4);
  });

  it("maps jobs.status to the four display states", () => {
    const now = Date.now();
    insertRun(db, { slug: "a", jobId: "j1", startedAt: now - 4_000, status: "running" });
    insertRun(db, { slug: "a", jobId: "j2", startedAt: now - 3_000, status: "done" });
    insertRun(db, { slug: "a", jobId: "j3", startedAt: now - 2_000, status: "failed" });
    insertRun(db, { slug: "a", jobId: "j4", startedAt: now - 1_000, status: "cancelled" });

    const runs = getRecentRuns(db, "main", "a");
    const byJob = new Map(runs.map((r) => [r.jobId, r.status]));
    expect(byJob.get("j1")).toBe("running");
    expect(byJob.get("j2")).toBe("healthy");
    expect(byJob.get("j3")).toBe("error");
    expect(byJob.get("j4")).toBe("error");
  });

  it("extracts a human note from the executor result blob", () => {
    insertRun(db, {
      slug: "a",
      jobId: "j1",
      startedAt: Date.now(),
      result: { outcome: "finalized", filesChanged: ["a.md", "b.md"], inboxBranch: "agents/a/r1" },
    });
    const [run] = getRecentRuns(db, "main", "a");
    expect(run?.note).toBe("inbox branch · 2 files");
  });

  it("returns null note when the job has no result yet", () => {
    insertRun(db, { slug: "a", jobId: "j1", startedAt: Date.now(), status: "running" });
    expect(getRecentRuns(db, "main", "a")[0]?.note).toBeNull();
  });

  it("isolates runs by project + slug", () => {
    const now = Date.now();
    insertRun(db, { projectId: "main", slug: "a", jobId: "j1", startedAt: now });
    insertRun(db, { projectId: "other", slug: "a", jobId: "j2", startedAt: now });
    insertRun(db, { projectId: "main", slug: "b", jobId: "j3", startedAt: now });

    const runs = getRecentRuns(db, "main", "a");
    expect(runs.map((r) => r.jobId)).toEqual(["j1"]);
  });
});

// ─── getHourlyHistogram ───────────────────────────────────────────

describe("getHourlyHistogram", () => {
  let db: JobsDb;

  beforeEach(() => {
    ({ db } = makeJobsDb());
  });
  afterEach(() => db.close());

  it("returns a 24-slot array zero-padded for empty windows", () => {
    const h = getHourlyHistogram(db, "main", "a");
    expect(h.buckets).toHaveLength(24);
    expect(h.buckets.every((n) => n === 0)).toBe(true);
    expect(h.bucketHours).toBe(24);
  });

  it("counts runs into the correct hour bucket", () => {
    const now = 1_700_000_000_000; // fixed point so the buckets line up
    const nowHour = Math.floor(now / 3_600_000);

    // Two runs in the current hour, one in 3h ago, one >24h ago.
    insertRun(db, { slug: "a", jobId: "j1", startedAt: nowHour * 3_600_000 });
    insertRun(db, { slug: "a", jobId: "j2", startedAt: nowHour * 3_600_000 + 100 });
    insertRun(db, { slug: "a", jobId: "j3", startedAt: (nowHour - 3) * 3_600_000 });
    insertRun(db, { slug: "a", jobId: "j4", startedAt: (nowHour - 30) * 3_600_000 });

    const h = getHourlyHistogram(db, "main", "a", now);
    expect(h.buckets[23]).toBe(2); // "now" is the last slot
    expect(h.buckets[20]).toBe(1); // 3 hours before now
    expect(h.buckets.reduce((a, b) => a + b, 0)).toBe(3); // >24h run is excluded
  });

  it("surfaces the configured caps alongside the buckets", () => {
    const rails = new AgentRails(db);
    rails.ensureState("main", "a");
    db.prepare(
      "UPDATE agent_state SET max_runs_per_hour = 5, max_runs_per_day = 40 WHERE slug = 'a'",
    ).run();

    const h = getHourlyHistogram(db, "main", "a");
    expect(h.cap).toEqual({ perHour: 5, perDay: 40 });
  });

  it("falls back to default caps when no agent_state row exists", () => {
    const h = getHourlyHistogram(db, "main", "nonexistent");
    expect(h.cap).toEqual({ perHour: 10, perDay: 50 });
  });
});

// ─── getAgentConfig ───────────────────────────────────────────────

describe("getAgentConfig", () => {
  let db: JobsDb;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeJobsDb());
  });
  afterEach(() => db.close());

  it("returns null when the agent_state row is absent", () => {
    const cfg = getAgentConfig(db, "main", "ghost", null);
    expect(cfg).toBeNull();
  });

  it("mirrors agent_state values exactly", () => {
    const rails = new AgentRails(db);
    rails.ensureState("main", "a");
    db.prepare(
      "UPDATE agent_state SET max_runs_per_hour = 6, max_runs_per_day = 30 WHERE slug = 'a'",
    ).run();

    const cfg = getAgentConfig(db, "main", "a", null);
    expect(cfg).not.toBeNull();
    expect(cfg?.maxRunsPerHour).toBe(6);
    expect(cfg?.maxRunsPerDay).toBe(30);
    expect(cfg?.status).toBe("active");
    expect(cfg?.personaPath).toBeNull(); // projectDir was null
    expect(cfg?.personaMtimeDriftSeconds).toBeNull();
  });

  it("reports positive drift when persona.md is newer than agent_state", () => {
    const rails = new AgentRails(db);
    rails.ensureState("main", "a");
    // Backdate agent_state.updated_at so the drift math has room.
    const backdated = Date.now() - 5_000;
    db.prepare("UPDATE agent_state SET updated_at = ? WHERE slug = 'a'").run(backdated);

    // Seed a persona.md whose mtime is `now` — newer than updated_at.
    const personaDir = join(dir, "data", ".agents", "a");
    mkdirSync(personaDir, { recursive: true });
    const personaFile = join(personaDir, "persona.md");
    writeFileSync(personaFile, "---\nslug: a\n---\n", "utf-8");
    // Force mtime to a known "now" so the drift window is deterministic.
    const nowSec = Date.now() / 1000;
    utimesSync(personaFile, nowSec, nowSec);

    const cfg = getAgentConfig(db, "main", "a", dir);
    expect(cfg?.personaPath).toBe("data/.agents/a/persona.md");
    expect(cfg?.personaMtimeDriftSeconds).not.toBeNull();
    expect((cfg?.personaMtimeDriftSeconds ?? 0) >= 0).toBe(true);
  });

  it("reports null drift when persona.md is missing on disk", () => {
    const rails = new AgentRails(db);
    rails.ensureState("main", "a");
    const cfg = getAgentConfig(db, "main", "a", dir); // dir exists but no persona file
    expect(cfg?.personaMtimeDriftSeconds).toBeNull();
  });

  it("reflects paused status and reason after rails.setPauseState", () => {
    const rails = new AgentRails(db);
    rails.ensureState("main", "a");
    rails.setPauseState("main", "a", true);
    const cfg = getAgentConfig(db, "main", "a", null);
    expect(cfg?.status).toBe("paused");
    expect(cfg?.pauseReason).toBe("user");
  });
});
