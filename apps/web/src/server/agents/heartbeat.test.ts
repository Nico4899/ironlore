import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openJobsDb } from "../jobs/schema.js";
import { WorkerPool } from "../jobs/worker.js";
import { HeartbeatScheduler } from "./heartbeat.js";
import { AgentRails } from "./rails.js";

/**
 * HeartbeatScheduler tests. Real SQLite + temp dirs, no mocks. Each
 * test builds a fresh `data/.agents/<slug>/persona.md` tree so the
 * scheduler can enumerate and read it exactly as it would in
 * production.
 */

type JobsDb = ReturnType<typeof openJobsDb>;

interface Fixture {
  root: string;
  dataDir: string;
  db: JobsDb;
  rails: AgentRails;
  pool: WorkerPool;
  scheduler: HeartbeatScheduler;
}

function makeFixture(): Fixture {
  const root = join(tmpdir(), `heartbeat-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(root, { recursive: true });
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const db = openJobsDb(join(root, "jobs.sqlite"));
  const rails = new AgentRails(db);
  const pool = new WorkerPool(db);
  const scheduler = new HeartbeatScheduler(db, rails, pool, "main", dataDir);
  return { root, dataDir, db, rails, pool, scheduler };
}

function writePersona(
  dataDir: string,
  slug: string,
  frontmatter: { active: boolean; heartbeat?: string | null },
): void {
  const dir = join(dataDir, ".agents", slug);
  mkdirSync(dir, { recursive: true });
  const lines = ["---", `slug: ${slug}`, `active: ${frontmatter.active}`];
  if (frontmatter.heartbeat !== undefined && frontmatter.heartbeat !== null) {
    lines.push(`heartbeat: "${frontmatter.heartbeat}"`);
  }
  lines.push("---", "", "body");
  writeFileSync(join(dir, "persona.md"), lines.join("\n"), "utf-8");
}

function queuedJobs(db: JobsDb): Array<{ kind: string; mode: string; ownerId: string | null }> {
  return db
    .prepare("SELECT kind, mode, owner_id as ownerId FROM jobs WHERE status = 'queued'")
    .all() as Array<{ kind: string; mode: string; ownerId: string | null }>;
}

describe("HeartbeatScheduler", () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    fx.scheduler.stop();
    fx.db.close();
    rmSync(fx.root, { recursive: true, force: true });
  });

  it("fires an active persona whose cron matches", () => {
    // `* * * * *` fires every minute, so any `now` triggers a fire.
    writePersona(fx.dataDir, "wiki-gardener", { active: true, heartbeat: "* * * * *" });
    fx.scheduler.tick();

    const jobs = queuedJobs(fx.db);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual({ kind: "agent.run", mode: "autonomous", ownerId: "wiki-gardener" });
  });

  it("does not fire when `active: false`", () => {
    writePersona(fx.dataDir, "wiki-gardener", { active: false, heartbeat: "* * * * *" });
    fx.scheduler.tick();
    expect(queuedJobs(fx.db)).toHaveLength(0);
  });

  it("does not fire when `heartbeat` is missing", () => {
    writePersona(fx.dataDir, "general", { active: true });
    fx.scheduler.tick();
    expect(queuedJobs(fx.db)).toHaveLength(0);
  });

  it("does not double-fire within the same minute", () => {
    writePersona(fx.dataDir, "wiki-gardener", { active: true, heartbeat: "* * * * *" });
    const now = new Date();
    fx.scheduler.tick(now);
    fx.scheduler.tick(now);
    expect(queuedJobs(fx.db)).toHaveLength(1);
  });

  it("fires again on the next matching minute", () => {
    writePersona(fx.dataDir, "wiki-gardener", { active: true, heartbeat: "* * * * *" });
    const t0 = new Date();
    t0.setSeconds(0, 0);
    fx.scheduler.tick(t0);

    const t1 = new Date(t0.getTime() + 60_000);
    fx.scheduler.tick(t1);

    expect(queuedJobs(fx.db)).toHaveLength(2);
  });

  it("skips rate-limited personas", () => {
    writePersona(fx.dataDir, "wiki-gardener", { active: true, heartbeat: "* * * * *" });
    fx.rails.ensureState("main", "wiki-gardener");
    // Slam the hour cap: 10 runs in the last hour.
    const insertRun = fx.db.prepare(
      "INSERT INTO agent_runs (project_id, slug, started_at, job_id) VALUES (?, ?, ?, ?)",
    );
    for (let i = 0; i < 10; i++) {
      insertRun.run("main", "wiki-gardener", Date.now() - 60_000 * i, `prior-${i}`);
    }

    const skips: string[] = [];
    fx.scheduler.onSkip = (_slug, reason) => skips.push(reason);
    fx.scheduler.tick();

    expect(queuedJobs(fx.db)).toHaveLength(0);
    expect(skips.some((r) => /rate limited/.test(r))).toBe(true);
  });

  it("skips paused personas", () => {
    writePersona(fx.dataDir, "wiki-gardener", { active: true, heartbeat: "* * * * *" });
    fx.rails.ensureState("main", "wiki-gardener");
    fx.rails.setPauseState("main", "wiki-gardener", true);

    fx.scheduler.tick();
    expect(queuedJobs(fx.db)).toHaveLength(0);
  });

  it("does not crash on malformed cron — skips the agent quietly", () => {
    writePersona(fx.dataDir, "broken", { active: true, heartbeat: "not a cron" });
    writePersona(fx.dataDir, "good", { active: true, heartbeat: "* * * * *" });

    const skips: string[] = [];
    fx.scheduler.onSkip = (slug) => skips.push(slug);
    fx.scheduler.tick();

    // Good persona still fires.
    expect(queuedJobs(fx.db).map((j) => j.ownerId)).toEqual(["good"]);
    // Broken persona was skipped with a reason.
    expect(skips).toContain("broken");
  });

  it("updates last_heartbeat_at after a successful fire", () => {
    writePersona(fx.dataDir, "wiki-gardener", { active: true, heartbeat: "* * * * *" });
    const before = Date.now();
    fx.scheduler.tick();

    const row = fx.db
      .prepare(
        "SELECT last_heartbeat_at FROM agent_state WHERE project_id = ? AND slug = ?",
      )
      .get("main", "wiki-gardener") as { last_heartbeat_at: number } | undefined;
    expect(row?.last_heartbeat_at).toBeGreaterThanOrEqual(before);
  });

  it("enumerates only directories under .agents (ignores .library, .shared)", () => {
    writePersona(fx.dataDir, "wiki-gardener", { active: true, heartbeat: "* * * * *" });
    // Dot-prefixed directories should be skipped — they hold templates/skills,
    // not running agents.
    mkdirSync(join(fx.dataDir, ".agents", ".library"), { recursive: true });
    writeFileSync(
      join(fx.dataDir, ".agents", ".library", "wiki-gardener.md"),
      `---\nslug: wiki-gardener\nactive: true\nheartbeat: "* * * * *"\n---\n`,
      "utf-8",
    );

    fx.scheduler.tick();
    // Exactly one fire — from `.agents/wiki-gardener/`, not from the
    // library file.
    expect(queuedJobs(fx.db)).toHaveLength(1);
  });

  it("emits an onFire callback with (slug, jobId) on a successful fire", () => {
    writePersona(fx.dataDir, "wiki-gardener", { active: true, heartbeat: "* * * * *" });
    const fires: Array<{ slug: string; jobId: string }> = [];
    fx.scheduler.onFire = (slug, jobId) => fires.push({ slug, jobId });
    fx.scheduler.tick();

    expect(fires).toHaveLength(1);
    expect(fires[0]?.slug).toBe("wiki-gardener");
    expect(fires[0]?.jobId).toMatch(/^[0-9A-Z]{26}$/); // ULID
  });
});
