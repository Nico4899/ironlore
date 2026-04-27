import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openJobsDb } from "./schema.js";
import type { JobRow } from "./types.js";
import { WorkerPool } from "./worker.js";

/**
 * Phase-11 Airlock — `jobs.egress_downgraded` forensic audit trail.
 *
 * The in-memory `AirlockSession` enforces the lockdown; this column
 * exists so an incident-response query can SELECT every run that
 * touched foreign-project content without replaying `job_events`.
 *
 * Tests pin three behaviours:
 *   1. Default value is null on a fresh row.
 *   2. `markEgressDowngraded` writes the JSON envelope.
 *   3. First reason wins — re-calling with a different reason is a
 *      no-op (matches `AirlockSession`'s idempotent semantics).
 */

let tmp: string;
let db: Database.Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "egress-persist-"));
  db = openJobsDb(join(tmp, "jobs.sqlite"));
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("WorkerPool.markEgressDowngraded", () => {
  it("a fresh job row has egress_downgraded = null", () => {
    const pool = new WorkerPool(db, { maxParallel: 1 });
    const id = pool.enqueue({ projectId: "main", kind: "noop" });
    const row = pool.getJob(id) as JobRow | undefined;
    expect(row?.egress_downgraded).toBeNull();
  });

  it("writes the JSON envelope when called", () => {
    const pool = new WorkerPool(db, { maxParallel: 1 });
    const id = pool.enqueue({ projectId: "main", kind: "noop" });
    pool.markEgressDowngraded(id, {
      reason: "kb.global_search returned cross-project hits",
      at: "2026-04-25T12:00:00.000Z",
    });
    const row = pool.getJob(id) as JobRow | undefined;
    expect(row?.egress_downgraded).not.toBeNull();
    const payload = JSON.parse(row?.egress_downgraded ?? "{}") as {
      reason: string;
      at: string;
    };
    expect(payload.reason).toBe("kb.global_search returned cross-project hits");
    expect(payload.at).toBe("2026-04-25T12:00:00.000Z");
  });

  it("first reason wins — re-calling with a different reason is a no-op", () => {
    // Mirrors `AirlockSession.downgrade`'s idempotency: the
    // first downgrade is the one the audit trail records, even
    // if a later cascade fires another reason. Pins the contract
    // so a future "always overwrite" refactor fails the test.
    const pool = new WorkerPool(db, { maxParallel: 1 });
    const id = pool.enqueue({ projectId: "main", kind: "noop" });
    pool.markEgressDowngraded(id, { reason: "first", at: "2026-04-25T12:00:00.000Z" });
    pool.markEgressDowngraded(id, { reason: "second", at: "2026-04-25T12:00:30.000Z" });
    const row = pool.getJob(id) as JobRow | undefined;
    const payload = JSON.parse(row?.egress_downgraded ?? "{}") as { reason: string };
    expect(payload.reason).toBe("first");
  });

  it("forensic SELECT — find every tainted run by SQL", () => {
    // The whole point of the column: an incident-response engineer
    // can SELECT every run that touched cross-project content
    // without replaying `job_events`. Pin the query shape so a
    // future column rename breaks loudly.
    const pool = new WorkerPool(db, { maxParallel: 1 });
    const clean = pool.enqueue({ projectId: "main", kind: "noop" });
    const tainted1 = pool.enqueue({ projectId: "main", kind: "noop" });
    const tainted2 = pool.enqueue({ projectId: "research", kind: "noop" });
    pool.markEgressDowngraded(tainted1, { reason: "x", at: null });
    pool.markEgressDowngraded(tainted2, { reason: "y", at: null });

    const rows = db
      .prepare("SELECT id FROM jobs WHERE egress_downgraded IS NOT NULL ORDER BY id")
      .all() as Array<{ id: string }>;
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(tainted1);
    expect(ids).toContain(tainted2);
    expect(ids).not.toContain(clean);
  });
});
