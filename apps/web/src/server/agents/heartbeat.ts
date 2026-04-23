import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_DIR } from "@ironlore/core";
import type Database from "better-sqlite3";
import type { WorkerPool } from "../jobs/worker.js";
import { type CronFields, parseCron, shouldFire } from "./cron.js";
import type { AgentRails } from "./rails.js";

/**
 * Heartbeat dispatcher.
 *
 * Wakes personas on the schedule their `heartbeat:` frontmatter
 * declares and enqueues an autonomous `agent.run` job per fire. Runs
 * in-process alongside the worker pool as a second `setInterval`; the
 * pool's own poll loop is atomic-UPDATE-based and can't be piggybacked
 * on without racing, so a parallel timer is simpler and correct.
 *
 * Tick order:
 *   1. `readdirSync(.agents/)` to enumerate all installed agents.
 *   2. For each, read persona.md; skip when `active` is false or
 *      `heartbeat` is missing / malformed.
 *   3. Check `shouldFire(cron, now, lastHeartbeatAt)`.
 *   4. Check `rails.canEnqueue()` — pause + sliding-window rate caps.
 *   5. Enqueue `agent.run` with `mode: "autonomous"`, `ownerId: slug`,
 *      `payload: { prompt: "" }` — the executor pulls the prompt from
 *      the persona body, so an empty user prompt is legitimate.
 *   6. `UPDATE agent_state SET last_heartbeat_at = now` so the next
 *      tick doesn't double-fire.
 *
 * State persisted to `agent_state.last_heartbeat_at` (additive column,
 * migrated in schema.ts). Server restarts preserve it; a scheduler
 * outage shorter than 31 days catches up on a single missed fire per
 * agent (see `shouldFire`). Longer outages silently drop the missed
 * fires — better than firing 720 heartbeats for a monthly cron that
 * missed a month.
 */
export interface HeartbeatSchedulerOptions {
  /** Poll cadence. Default 60s because cron granularity is 1 minute. */
  intervalMs?: number;
}

export class HeartbeatScheduler {
  private readonly db: Database.Database;
  private readonly rails: AgentRails;
  private readonly pool: WorkerPool;
  private readonly projectId: string;
  private readonly dataRoot: string;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Optional hook for logging fires; left undefined in production. */
  onFire?: (slug: string, jobId: string) => void;
  /** Optional hook for logging skipped agents; left undefined in production. */
  onSkip?: (slug: string, reason: string) => void;

  constructor(
    db: Database.Database,
    rails: AgentRails,
    pool: WorkerPool,
    projectId: string,
    dataRoot: string,
    opts?: HeartbeatSchedulerOptions,
  ) {
    this.db = db;
    this.rails = rails;
    this.pool = pool;
    this.projectId = projectId;
    this.dataRoot = dataRoot;
    this.intervalMs = opts?.intervalMs ?? 60_000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        // A crash in one tick must not take down the dispatcher.
        // eslint-disable-next-line no-console
        console.error("[heartbeat] tick failed:", err);
      }
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass over installed agents. Exposed for tests — production
   * wiring should use `start()` instead.
   */
  tick(now: Date = new Date()): void {
    const agentsDir = join(this.dataRoot, AGENTS_DIR);
    if (!existsSync(agentsDir)) return;

    for (const slug of listActiveSlugs(agentsDir)) {
      const persona = readPersonaMeta(agentsDir, slug);
      if (!persona || !persona.active || !persona.heartbeat) continue;

      let cron: CronFields;
      try {
        cron = parseCron(persona.heartbeat);
      } catch {
        // Malformed cron — skip this agent quietly. A noisy error
        // every minute for one misconfigured persona would drown the
        // real log signal.
        this.onSkip?.(slug, "malformed heartbeat");
        continue;
      }

      const lastFiredAt = this.readLastHeartbeatAt(slug);
      if (!shouldFire(cron, now, lastFiredAt)) continue;

      const allowed = this.rails.canEnqueue(this.projectId, slug);
      if (!allowed.allowed) {
        this.onSkip?.(slug, allowed.reason);
        continue;
      }

      // Enqueue + mark fired in a single transaction so a crash
      // between the two can't leak a queued job whose state row
      // still thinks it hasn't fired (which would then double-fire
      // on the next tick).
      const fire = this.db.transaction((nowMs: number) => {
        const jobId = this.pool.enqueue({
          projectId: this.projectId,
          kind: "agent.run",
          mode: "autonomous",
          ownerId: slug,
          payload: { prompt: "" },
        });
        this.writeLastHeartbeatAt(slug, nowMs);
        return jobId;
      });
      const jobId = fire(now.getTime());
      this.onFire?.(slug, jobId);
    }
  }

  private readLastHeartbeatAt(slug: string): number | null {
    const row = this.db
      .prepare(
        "SELECT last_heartbeat_at AS lastAt FROM agent_state WHERE project_id = ? AND slug = ?",
      )
      .get(this.projectId, slug) as { lastAt: number | null } | undefined;
    return row?.lastAt ?? null;
  }

  private writeLastHeartbeatAt(slug: string, nowMs: number): void {
    // UPSERT so a persona that has no agent_state row yet (never run,
    // never queried) still gets one on first fire. `updated_at` is
    // bumped so observability's "last seen" fields reflect reality.
    this.db
      .prepare(
        `INSERT INTO agent_state (project_id, slug, status, last_heartbeat_at, updated_at)
         VALUES (?, ?, 'active', ?, ?)
         ON CONFLICT(project_id, slug) DO UPDATE
           SET last_heartbeat_at = excluded.last_heartbeat_at,
               updated_at = excluded.updated_at`,
      )
      .run(this.projectId, slug, nowMs, nowMs);
  }
}

/**
 * Enumerate slugs under `.agents/` that are activated agent
 * directories (have a `persona.md`). Skips `.shared/` and `.library/`
 * which start with a dot.
 */
function listActiveSlugs(agentsDir: string): string[] {
  const slugs: string[] = [];
  for (const entry of readdirSync(agentsDir)) {
    if (entry.startsWith(".")) continue;
    const personaPath = join(agentsDir, entry, "persona.md");
    if (!existsSync(personaPath)) continue;
    // Defensive: skip entries that happen to be files or symlinks to
    // non-directory targets.
    const st = statSync(join(agentsDir, entry));
    if (!st.isDirectory()) continue;
    slugs.push(entry);
  }
  return slugs;
}

/** Persona metadata read by the scheduler. */
interface PersonaMeta {
  active: boolean;
  heartbeat: string | null;
}

/**
 * Two-regex read of the minimal fields the scheduler needs. Reuses
 * the same fast path the executor uses — see executor.ts
 * `parseDeclaredSkills()` — rather than pulling in `js-yaml`.
 */
function readPersonaMeta(agentsDir: string, slug: string): PersonaMeta | null {
  const personaPath = join(agentsDir, slug, "persona.md");
  let raw: string;
  try {
    raw = readFileSync(personaPath, "utf-8");
  } catch {
    return null;
  }
  const match = /^---[^\n]*\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match?.[1]) return null;
  const fm = match[1];
  const activeMatch = /^active\s*:\s*(true|false)\s*$/m.exec(fm);
  const heartbeatMatch = /^heartbeat\s*:\s*"?([^"\n]+?)"?\s*$/m.exec(fm);
  return {
    active: activeMatch?.[1] === "true",
    heartbeat: heartbeatMatch?.[1]?.trim() ?? null,
  };
}
