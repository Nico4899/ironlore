import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobRow } from "../jobs/types.js";
import { revertAgentRun } from "./revert-run.js";

/**
 * revert-run tests.
 *
 * Builds a real throw-away git repo so we can exercise `git revert`
 * end-to-end without stubbing. Each test:
 *
 *   - Initializes a new repo in a tempdir
 *   - Creates initial commits, records their SHAs
 *   - Calls revertAgentRun with a synthetic JobRow that carries the
 *     commit range
 *   - Asserts the reverted state of working tree + commit log
 */

function makeTmpRepo(): { projectDir: string } {
  const projectDir = join(tmpdir(), `revert-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(projectDir, { recursive: true });
  execSync("git init", { cwd: projectDir, stdio: "pipe" });
  execSync("git config user.email test@example.com", { cwd: projectDir, stdio: "pipe" });
  execSync("git config user.name Tester", { cwd: projectDir, stdio: "pipe" });
  return { projectDir };
}

function commit(projectDir: string, filename: string, content: string, message: string): string {
  writeFileSync(join(projectDir, filename), content);
  execSync(`git add "${filename}"`, { cwd: projectDir, stdio: "pipe" });
  execSync(`git commit -m "${message}"`, { cwd: projectDir, stdio: "pipe" });
  return execSync("git rev-parse HEAD", { cwd: projectDir, encoding: "utf-8" }).trim();
}

function readFile(projectDir: string, filename: string): string {
  return execSync(`cat "${filename}"`, { cwd: projectDir, encoding: "utf-8" });
}

function makeJob(overrides: Partial<JobRow>): JobRow {
  const now = Date.now();
  return {
    id: "test-job-1",
    project_id: "main",
    kind: "agent.run",
    mode: "autonomous",
    owner_id: "editor",
    payload: "{}",
    status: "done",
    lease_until: null,
    worker_id: null,
    attempts: 1,
    max_attempts: 3,
    scheduled_at: now,
    started_at: now,
    finished_at: now,
    result: null,
    commit_sha_start: null,
    commit_sha_end: null,
    batch_handle: null,
    egress_downgraded: null,
    created_at: now,
    ...overrides,
  };
}

describe("revertAgentRun", () => {
  let projectDir: string;
  let seedSha: string;

  beforeEach(() => {
    const repo = makeTmpRepo();
    projectDir = repo.projectDir;
    // Initial commit so there's a parent for the first agent commit.
    // Capture its SHA — tests that simulate a "0-commit run" use it
    // as both start and end (the canonical no-op signature).
    seedSha = commit(projectDir, "seed.md", "seed\n", "initial");
  });

  afterEach(() => {
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("returns an error when the job has no commit range", () => {
    const result = revertAgentRun(makeJob({}), projectDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain("no commit range");
  });

  it("reverts a single-commit run cleanly", () => {
    // Correct semantics: a run that produced one commit has
    // `start = parent_sha, end = new_sha`. Previously this test
    // used `start === end === shaA`, which is the *bug pattern*
    // (a 0-commit run that the new guard now refuses) — the only
    // reason the assertion passed was that `git log shaA^..shaA`
    // happens to return the single commit at shaA.
    const shaA = commit(projectDir, "a.md", "agent wrote a\n", "agent: add a");

    const result = revertAgentRun(
      makeJob({ commit_sha_start: seedSha, commit_sha_end: shaA }),
      projectDir,
    );

    expect(result.success).toBe(true);
    expect(result.revertedCommits).toEqual([shaA]);
    expect(result.conflicts).toEqual([]);

    // File should be gone (or rather, deleted by the revert commit).
    const log = execSync("git log --format=%s", { cwd: projectDir, encoding: "utf-8" });
    expect(log).toContain("Revert");
  });

  it("refuses to revert a 0-commit run (start === end)", () => {
    // The smoking-gun bug from the AI-panel audit: wiki-gardener
    // ran an analysis that wrote nothing (`filesChanged: []`,
    // `commitShaStart === commitShaEnd === 668da795`), yet
    // POST /jobs/.../revert returned `success: true` and reported
    // commit 668da795 as "reverted" — that commit was the project's
    // *initial state*, not anything this run touched. The guard
    // refuses these jobs at the function boundary so chat-only
    // turns can't accidentally roll back unrelated history.
    const result = revertAgentRun(
      makeJob({ commit_sha_start: seedSha, commit_sha_end: seedSha }),
      projectDir,
    );
    expect(result.success).toBe(false);
    expect(result.revertedCommits).toEqual([]);
    expect(result.error).toMatch(/no commits|start === end/i);

    // Project HEAD must be untouched — the seed commit is still HEAD.
    const head = execSync("git rev-parse HEAD", {
      cwd: projectDir,
      encoding: "utf-8",
    }).trim();
    expect(head).toBe(seedSha);

    // No revert commit was created.
    const log = execSync("git log --format=%s", { cwd: projectDir, encoding: "utf-8" });
    expect(log).not.toContain("Revert");
  });

  it("reverts a multi-commit range in newest-first order", () => {
    const shaA = commit(projectDir, "a.md", "first\n", "agent: add a");
    const shaB = commit(projectDir, "b.md", "second\n", "agent: add b");
    const shaC = commit(projectDir, "c.md", "third\n", "agent: add c");

    const result = revertAgentRun(
      makeJob({ commit_sha_start: shaA, commit_sha_end: shaC }),
      projectDir,
    );

    expect(result.success).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.revertedCommits.sort()).toEqual([shaA, shaB, shaC].sort());

    // All three files should have been removed by the reverts.
    expect(() => readFile(projectDir, "a.md")).toThrow();
    expect(() => readFile(projectDir, "b.md")).toThrow();
    expect(() => readFile(projectDir, "c.md")).toThrow();
  });

  it("records conflicts without aborting the whole batch", () => {
    // Agent adds a line, user then edits the same line (dirty merge base),
    // revert should conflict. We simulate this by making the agent's
    // commit add content, then overwriting the same line in a later
    // non-agent commit.
    const agentSha = commit(
      projectDir,
      "shared.md",
      "line one (agent)\nline two\n",
      "agent: edit shared",
    );
    // Non-agent commit rewrites what the agent wrote.
    commit(projectDir, "shared.md", "line one (user)\nline two\n", "user: overwrite");

    const result = revertAgentRun(
      makeJob({ commit_sha_start: agentSha, commit_sha_end: agentSha }),
      projectDir,
    );

    // Revert conflicts with the later user commit → conflict recorded,
    // process aborts cleanly (git state is clean afterwards).
    expect(result.success).toBe(false);
    expect(result.conflicts).toContain(agentSha);

    // Git should be in a clean state (no in-progress revert merge).
    const status = execSync("git status --porcelain", {
      cwd: projectDir,
      encoding: "utf-8",
    });
    expect(status.trim()).toBe("");
  });

  it("returns error when the commit range doesn't exist", () => {
    const result = revertAgentRun(
      makeJob({
        commit_sha_start: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        commit_sha_end: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      }),
      projectDir,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
