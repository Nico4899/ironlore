import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openJobsDb } from "../jobs/schema.js";
import { AgentRails } from "./rails.js";

/**
 * AgentRails tests.
 *
 * Verifies:
 *   - Auto-pause fires at the 3-failure threshold
 *   - Success resets the failure streak
 *   - Manual pause/resume toggles status
 *   - Rate limits enforce per-hour and per-day caps
 *   - recordOutcome works for agents without pre-seeded state rows
 */

function makeJobsDb() {
  const dir = join(tmpdir(), `rails-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return openJobsDb(join(dir, "jobs.sqlite"));
}

describe("AgentRails — auto-pause", () => {
  let db: ReturnType<typeof makeJobsDb>;
  let rails: AgentRails;

  beforeEach(() => {
    db = makeJobsDb();
    rails = new AgentRails(db);
    rails.ensureState("main", "editor");
  });

  afterEach(() => {
    db.close();
  });

  it("does not pause after 1 or 2 failures", () => {
    rails.recordOutcome("main", "editor", false);
    expect(rails.canEnqueue("main", "editor")).toEqual({ allowed: true });
    rails.recordOutcome("main", "editor", false);
    expect(rails.canEnqueue("main", "editor")).toEqual({ allowed: true });
  });

  it("pauses after 3 consecutive failures", () => {
    rails.recordOutcome("main", "editor", false);
    rails.recordOutcome("main", "editor", false);
    rails.recordOutcome("main", "editor", false);
    const check = rails.canEnqueue("main", "editor");
    expect(check.allowed).toBe(false);
    if (!check.allowed) expect(check.reason).toContain("paused");
  });

  it("resets the streak on success", () => {
    rails.recordOutcome("main", "editor", false);
    rails.recordOutcome("main", "editor", false);
    rails.recordOutcome("main", "editor", true);
    rails.recordOutcome("main", "editor", false);
    rails.recordOutcome("main", "editor", false);
    // After success + 2 fails, streak is 2 — still allowed.
    expect(rails.canEnqueue("main", "editor")).toEqual({ allowed: true });
  });

  it("recordOutcome creates state row for custom agents (regression)", () => {
    // Custom agent without pre-seeded state row.
    rails.recordOutcome("main", "custom-agent", false);
    rails.recordOutcome("main", "custom-agent", false);
    rails.recordOutcome("main", "custom-agent", false);
    const check = rails.canEnqueue("main", "custom-agent");
    expect(check.allowed).toBe(false);
  });
});

describe("AgentRails — manual pause/resume", () => {
  let db: ReturnType<typeof makeJobsDb>;
  let rails: AgentRails;

  beforeEach(() => {
    db = makeJobsDb();
    rails = new AgentRails(db);
    rails.ensureState("main", "editor");
  });

  afterEach(() => {
    db.close();
  });

  it("setPauseState(true) blocks canEnqueue", () => {
    rails.setPauseState("main", "editor", true);
    const check = rails.canEnqueue("main", "editor");
    expect(check.allowed).toBe(false);
  });

  it("setPauseState(false) re-enables", () => {
    rails.setPauseState("main", "editor", true);
    rails.setPauseState("main", "editor", false);
    expect(rails.canEnqueue("main", "editor")).toEqual({ allowed: true });
  });

  it("resume clears failure_streak so paused-by-threshold unpauses cleanly", () => {
    rails.recordOutcome("main", "editor", false);
    rails.recordOutcome("main", "editor", false);
    rails.recordOutcome("main", "editor", false);
    expect(rails.canEnqueue("main", "editor").allowed).toBe(false);

    rails.setPauseState("main", "editor", false);
    // After resume, next failure should restart streak from 1, not continue from 3.
    rails.recordOutcome("main", "editor", false);
    expect(rails.canEnqueue("main", "editor").allowed).toBe(true);
  });
});

describe("AgentRails — rate limits", () => {
  let db: ReturnType<typeof makeJobsDb>;
  let rails: AgentRails;

  beforeEach(() => {
    db = makeJobsDb();
    rails = new AgentRails(db);
    rails.ensureState("main", "editor");
  });

  afterEach(() => {
    db.close();
  });

  it("enforces hourly cap (default 10)", () => {
    for (let i = 0; i < 10; i++) rails.recordStart("main", "editor", `job-${i}`);
    const check = rails.canEnqueue("main", "editor");
    expect(check.allowed).toBe(false);
    if (!check.allowed) expect(check.reason).toContain("rate limited");
  });

  it("allows runs under the hourly cap", () => {
    for (let i = 0; i < 9; i++) rails.recordStart("main", "editor", `job-${i}`);
    expect(rails.canEnqueue("main", "editor")).toEqual({ allowed: true });
  });

  it("rate limits are per-agent, not global", () => {
    for (let i = 0; i < 10; i++) rails.recordStart("main", "editor", `job-${i}`);
    rails.ensureState("main", "general");
    expect(rails.canEnqueue("main", "general")).toEqual({ allowed: true });
  });
});

describe("AgentRails — no state row", () => {
  let db: ReturnType<typeof makeJobsDb>;
  let rails: AgentRails;

  beforeEach(() => {
    db = makeJobsDb();
    rails = new AgentRails(db);
  });

  afterEach(() => {
    db.close();
  });

  it("canEnqueue returns allowed when no state row exists", () => {
    expect(rails.canEnqueue("main", "nonexistent")).toEqual({ allowed: true });
  });
});
