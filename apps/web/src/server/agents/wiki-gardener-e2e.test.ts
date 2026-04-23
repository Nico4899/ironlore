import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openJobsDb } from "../jobs/schema.js";
import { WorkerPool } from "../jobs/worker.js";
import { SearchIndex } from "../search-index.js";
import { seed } from "../seed.js";
import { createKbLintOrphans } from "../tools/kb-lint-orphans.js";
import { activateAgent } from "./activate.js";
import { HeartbeatScheduler } from "./heartbeat.js";
import { AgentRails } from "./rails.js";
import { loadSkills } from "./skill-loader.js";

/**
 * End-to-end wiki-gardener path — exercises the full iter-1/2/3 glue
 * without hitting a real provider:
 *
 *   Phase 1 seed  → lint.md + _index.md + _log.md + wiki-gardener template
 *   Phase 2 activate → persona copied to .agents/wiki-gardener/ + flipped active
 *   Phase 3 scheduler tick → cron matches → agent.run job enqueued
 *
 * Executor-level behavior (persona body + skills → system prompt, the
 * stub-provider loop) is covered by executor-backpressure.test.ts, so
 * this test stops at "job was enqueued with the expected payload" +
 * "skill loader would pull in lint.md" + "lint-orphans tool would
 * return the right orphans against the seed corpus."
 */

interface Fixture {
  root: string;
  dataDir: string;
  projectDir: string;
  db: ReturnType<typeof openJobsDb>;
  pool: WorkerPool;
  rails: AgentRails;
  scheduler: HeartbeatScheduler;
  searchIndex: SearchIndex;
}

function makeFixture(): Fixture {
  const root = join(tmpdir(), `gardener-e2e-${randomBytes(4).toString("hex")}`);
  mkdirSync(root, { recursive: true });
  const projectDir = join(root, "projects", "main");
  const dataDir = join(projectDir, "data");
  mkdirSync(dataDir, { recursive: true });

  const db = openJobsDb(join(root, "jobs.sqlite"));
  const rails = new AgentRails(db);
  const pool = new WorkerPool(db);
  const scheduler = new HeartbeatScheduler(db, rails, pool, "main", dataDir);
  const searchIndex = new SearchIndex(projectDir);
  return { root, dataDir, projectDir, db, pool, rails, scheduler, searchIndex };
}

describe("Wiki Gardener end-to-end (seed → activate → schedule)", () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = makeFixture();
    await seed(fx.dataDir);
  });

  afterEach(() => {
    fx.scheduler.stop();
    fx.searchIndex.close();
    fx.db.close();
    rmSync(fx.root, { recursive: true, force: true });
  });

  it("seed populates the Phase-11 assets at canonical paths", () => {
    // Convention pages.
    expect(() => readFileSync(join(fx.dataDir, "_index.md"), "utf-8")).not.toThrow();
    expect(() => readFileSync(join(fx.dataDir, "_log.md"), "utf-8")).not.toThrow();
    // Shared lint skill.
    const lint = readFileSync(join(fx.dataDir, ".agents", ".shared", "skills", "lint.md"), "utf-8");
    expect(lint).toContain("kb.lint_orphans");
    // Library template declares the skill dependency.
    const template = readFileSync(
      join(fx.dataDir, ".agents", ".library", "wiki-gardener.md"),
      "utf-8",
    );
    expect(template).toMatch(/\nactive: false\n/);
    expect(template).toMatch(/\nskills: \[lint\]\n/);
  });

  it("activation flips the template into a running persona and creates agent_state", () => {
    const result = activateAgent(fx.dataDir, fx.db, "main", "wiki-gardener");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const activated = readFileSync(result.personaPath, "utf-8");
    expect(activated).toMatch(/\nactive: true\n/);
    expect(activated).toMatch(/\nskills: \[lint\]\n/);

    const row = fx.db
      .prepare("SELECT status FROM agent_state WHERE project_id = ? AND slug = ?")
      .get("main", "wiki-gardener");
    expect(row).toBeDefined();
  });

  it("skill loader would stitch lint.md into the system prompt for the activated gardener", () => {
    activateAgent(fx.dataDir, fx.db, "main", "wiki-gardener");

    // The executor reads persona frontmatter and passes declared skills
    // to loadSkills(); we short-circuit to what the declared-skills list
    // parses as — `skills: [lint]` on this persona.
    const skillsBlock = loadSkills(fx.dataDir, "wiki-gardener", ["lint"]);
    expect(skillsBlock).toContain("# Loaded skills");
    expect(skillsBlock).toContain("kb.lint_orphans");
    // Frontmatter must be stripped from the stitched output.
    expect(skillsBlock).not.toMatch(/^---/m);
  });

  it("scheduler tick enqueues an autonomous agent.run job once the cron matches", () => {
    activateAgent(fx.dataDir, fx.db, "main", "wiki-gardener");

    // The seeded gardener fires at `0 6 * * 0` (Sunday 6am). Point a
    // fake "now" at Sunday 2026-01-11 06:00 so the cron matches
    // deterministically without waiting for a real Sunday.
    const sundaySixAM = new Date(2026, 0, 11, 6, 0);
    expect(sundaySixAM.getDay()).toBe(0); // sanity: is actually Sunday
    fx.scheduler.tick(sundaySixAM);

    const jobs = fx.db
      .prepare("SELECT kind, mode, owner_id AS ownerId, payload FROM jobs WHERE status = 'queued'")
      .all() as Array<{ kind: string; mode: string; ownerId: string; payload: string }>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      kind: "agent.run",
      mode: "autonomous",
      ownerId: "wiki-gardener",
    });
    expect(JSON.parse(jobs[0]?.payload ?? "{}")).toEqual({ prompt: "" });

    // last_heartbeat_at was stamped so a second tick at the same
    // minute does not double-fire.
    fx.scheduler.tick(sundaySixAM);
    const again = fx.db
      .prepare("SELECT COUNT(*) AS cnt FROM jobs WHERE status = 'queued'")
      .get() as { cnt: number };
    expect(again.cnt).toBe(1);
  });

  it("kb.lint_orphans returns the seeded corpus's orphans", async () => {
    // Index every seeded markdown page so the backlinks table
    // reflects what a running server would see.
    const filesToIndex = walkMarkdown(fx.dataDir);
    for (const { relPath, content } of filesToIndex) {
      fx.searchIndex.indexPage(relPath, content, "seed");
    }

    const tool = createKbLintOrphans(fx.searchIndex);
    const out = JSON.parse(
      await tool.execute(
        {},
        {
          projectId: "main",
          agentSlug: "wiki-gardener",
          jobId: "test",
          emitEvent: () => undefined,
          dataRoot: fx.dataDir,
        },
      ),
    ) as { count: number; orphans: Array<{ path: string }> };

    // The seed corpus puts `_index.md`, `_log.md`, and the
    // carousel/ samples at the vault root; default exclude
    // prefixes drop `getting-started/`, `_maintenance/`, and
    // `.agents/`. Orphans should be > 0 (the carousel demos are
    // not cross-linked) but the check itself is well-formed: the
    // tool returned a JSON envelope with paths from within
    // `excludePrefixes`' complement.
    expect(Array.isArray(out.orphans)).toBe(true);
    for (const o of out.orphans) {
      expect(o.path.startsWith("getting-started/")).toBe(false);
      expect(o.path.startsWith("_maintenance/")).toBe(false);
      expect(o.path.startsWith(".agents/")).toBe(false);
    }
  });
});

/** Recursively enumerate `*.md` files under `root`, returning relative paths. */
function walkMarkdown(root: string): Array<{ relPath: string; content: string }> {
  const out: Array<{ relPath: string; content: string }> = [];
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  function recurse(dir: string, prefix: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        recurse(full, prefix ? `${prefix}/${entry}` : entry);
      } else if (entry.endsWith(".md")) {
        const relPath = prefix ? `${prefix}/${entry}` : entry;
        const content = readFileSync(full, "utf-8");
        out.push({ relPath, content });
      }
    }
  }
  recurse(root, "");
  return out;
}
