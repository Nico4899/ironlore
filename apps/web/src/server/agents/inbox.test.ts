import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentInbox } from "./inbox.js";

/**
 * AgentInbox tests.
 *
 * Exercises the staging-branch → main merge flow against a real git
 * repo. Covers the three outcomes:
 *
 *   - Fast-forward approve: main hasn't moved, branch merges cleanly
 *   - Non-ff approve: main has diverged; falls back to merge commit
 *   - Reject: staging branch is deleted without merging
 *
 * Plus DB-only checks (createEntry, getPending, partial statuses).
 */

function makeTmpRepo(): { projectDir: string } {
  const projectDir = join(tmpdir(), `inbox-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(projectDir, { recursive: true });
  execSync("git init -b main", { cwd: projectDir, stdio: "pipe" });
  execSync("git config user.email test@example.com", { cwd: projectDir, stdio: "pipe" });
  execSync("git config user.name Tester", { cwd: projectDir, stdio: "pipe" });
  writeFileSync(join(projectDir, "seed.md"), "seed\n");
  execSync("git add seed.md", { cwd: projectDir, stdio: "pipe" });
  execSync("git commit -m initial", { cwd: projectDir, stdio: "pipe" });
  return { projectDir };
}

function makeInbox(): { inbox: AgentInbox; close: () => void } {
  // In-memory DB — each test gets a fresh one.
  const db = new Database(":memory:");
  const inbox = new AgentInbox(db);
  return {
    inbox,
    close: () => db.close(),
  };
}

function gitHead(projectDir: string): string {
  return execSync("git rev-parse HEAD", { cwd: projectDir, encoding: "utf-8" }).trim();
}

function branchExists(projectDir: string, branch: string): boolean {
  try {
    execSync(`git rev-parse --verify ${branch}`, { cwd: projectDir, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

describe("AgentInbox — DB-only", () => {
  it("createEntry + getPending round-trip", () => {
    const { inbox, close } = makeInbox();
    inbox.createEntry({
      id: "e1",
      projectId: "main",
      agentSlug: "editor",
      branch: "agents/editor/j1",
      jobId: "j1",
      filesChanged: ["a.md", "b.md"],
      startedAt: 1000,
      finalizedAt: 2000,
    });

    const entries = inbox.getPending("main");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("e1");
    expect(entries[0]?.filesChanged).toEqual(["a.md", "b.md"]);
    expect(entries[0]?.status).toBe("pending");
    close();
  });

  it("getPending filters by project and status=pending", () => {
    const { inbox, close } = makeInbox();
    inbox.createEntry({
      id: "e1",
      projectId: "main",
      agentSlug: "editor",
      branch: "b1",
      jobId: "j1",
      filesChanged: [],
      startedAt: 1,
      finalizedAt: 2,
    });
    inbox.createEntry({
      id: "e2",
      projectId: "other",
      agentSlug: "editor",
      branch: "b2",
      jobId: "j2",
      filesChanged: [],
      startedAt: 1,
      finalizedAt: 2,
    });
    expect(inbox.getPending("main")).toHaveLength(1);
    expect(inbox.getPending("other")).toHaveLength(1);
    expect(inbox.getPending("nonexistent")).toHaveLength(0);
    close();
  });
});

describe("AgentInbox — approve/reject against real git", () => {
  let projectDir: string;
  let inbox: AgentInbox;
  let close: () => void;

  beforeEach(() => {
    const repo = makeTmpRepo();
    projectDir = repo.projectDir;
    ({ inbox, close } = makeInbox());
  });

  afterEach(() => {
    close();
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("approveAll fast-forwards a clean staging branch", () => {
    // Create staging branch, commit on it, return to main.
    execSync("git checkout -b agents/editor/run1", { cwd: projectDir, stdio: "pipe" });
    writeFileSync(join(projectDir, "agent.md"), "agent wrote this\n");
    execSync("git add agent.md", { cwd: projectDir, stdio: "pipe" });
    execSync("git commit -m agent-work", { cwd: projectDir, stdio: "pipe" });
    execSync("git checkout main", { cwd: projectDir, stdio: "pipe" });

    inbox.createEntry({
      id: "e1",
      projectId: "main",
      agentSlug: "editor",
      branch: "agents/editor/run1",
      jobId: "run1",
      filesChanged: ["agent.md"],
      startedAt: 1,
      finalizedAt: 2,
    });

    const mainHeadBefore = gitHead(projectDir);
    const result = inbox.approveAll("e1", projectDir);
    expect(result.success).toBe(true);

    // Main should now have advanced to include the agent commit.
    const mainHeadAfter = gitHead(projectDir);
    expect(mainHeadAfter).not.toBe(mainHeadBefore);

    // Branch should be deleted.
    expect(branchExists(projectDir, "agents/editor/run1")).toBe(false);

    // Entry should be marked approved.
    expect(inbox.getPending("main")).toHaveLength(0);
  });

  it("approveAll falls back to merge commit when main has diverged", () => {
    // Branch off main, commit on staging.
    execSync("git checkout -b agents/editor/run2", { cwd: projectDir, stdio: "pipe" });
    writeFileSync(join(projectDir, "agent.md"), "agent\n");
    execSync("git add agent.md", { cwd: projectDir, stdio: "pipe" });
    execSync("git commit -m agent-work", { cwd: projectDir, stdio: "pipe" });
    // Return to main and commit something unrelated so main diverges.
    execSync("git checkout main", { cwd: projectDir, stdio: "pipe" });
    writeFileSync(join(projectDir, "user.md"), "user\n");
    execSync("git add user.md", { cwd: projectDir, stdio: "pipe" });
    execSync("git commit -m user-work", { cwd: projectDir, stdio: "pipe" });

    inbox.createEntry({
      id: "e2",
      projectId: "main",
      agentSlug: "editor",
      branch: "agents/editor/run2",
      jobId: "run2",
      filesChanged: ["agent.md"],
      startedAt: 1,
      finalizedAt: 2,
    });

    const result = inbox.approveAll("e2", projectDir);
    expect(result.success).toBe(true);

    // Both files should now exist on main after the merge commit.
    const files = execSync("ls", { cwd: projectDir, encoding: "utf-8" });
    expect(files).toContain("agent.md");
    expect(files).toContain("user.md");

    // Branch should be deleted.
    expect(branchExists(projectDir, "agents/editor/run2")).toBe(false);

    // The last commit should be a merge commit (two parents).
    const parents = execSync("git log -1 --format=%P HEAD", {
      cwd: projectDir,
      encoding: "utf-8",
    }).trim();
    expect(parents.split(" ").length).toBe(2);
  });

  it("approveAll records an error and cleans up on conflict", () => {
    // Branch off main, both branches edit the same line of the same
    // file → merge conflict.
    writeFileSync(join(projectDir, "shared.md"), "original\n");
    execSync("git add shared.md", { cwd: projectDir, stdio: "pipe" });
    execSync("git commit -m base", { cwd: projectDir, stdio: "pipe" });

    execSync("git checkout -b agents/editor/run3", { cwd: projectDir, stdio: "pipe" });
    writeFileSync(join(projectDir, "shared.md"), "agent version\n");
    execSync("git add shared.md", { cwd: projectDir, stdio: "pipe" });
    execSync("git commit -m agent-work", { cwd: projectDir, stdio: "pipe" });

    execSync("git checkout main", { cwd: projectDir, stdio: "pipe" });
    writeFileSync(join(projectDir, "shared.md"), "user version\n");
    execSync("git add shared.md", { cwd: projectDir, stdio: "pipe" });
    execSync("git commit -m user-work", { cwd: projectDir, stdio: "pipe" });

    inbox.createEntry({
      id: "e3",
      projectId: "main",
      agentSlug: "editor",
      branch: "agents/editor/run3",
      jobId: "run3",
      filesChanged: ["shared.md"],
      startedAt: 1,
      finalizedAt: 2,
    });

    const result = inbox.approveAll("e3", projectDir);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();

    // The repo should be clean (merge aborted).
    const status = execSync("git status --porcelain", {
      cwd: projectDir,
      encoding: "utf-8",
    });
    expect(status.trim()).toBe("");

    // Staging branch should still exist so the user can retry.
    expect(branchExists(projectDir, "agents/editor/run3")).toBe(true);
  });

  it("rejectAll deletes the staging branch without merging", () => {
    execSync("git checkout -b agents/editor/run4", { cwd: projectDir, stdio: "pipe" });
    writeFileSync(join(projectDir, "agent.md"), "will be discarded\n");
    execSync("git add agent.md", { cwd: projectDir, stdio: "pipe" });
    execSync("git commit -m agent-work", { cwd: projectDir, stdio: "pipe" });
    execSync("git checkout main", { cwd: projectDir, stdio: "pipe" });

    const mainHeadBefore = gitHead(projectDir);

    inbox.createEntry({
      id: "e4",
      projectId: "main",
      agentSlug: "editor",
      branch: "agents/editor/run4",
      jobId: "run4",
      filesChanged: ["agent.md"],
      startedAt: 1,
      finalizedAt: 2,
    });

    const result = inbox.rejectAll("e4", projectDir);
    expect(result.success).toBe(true);

    // Main should NOT have advanced.
    expect(gitHead(projectDir)).toBe(mainHeadBefore);

    // Branch should be gone.
    expect(branchExists(projectDir, "agents/editor/run4")).toBe(false);

    // Entry removed from pending list.
    expect(inbox.getPending("main")).toHaveLength(0);
  });

  it("approveAll returns an error for unknown entry IDs", () => {
    const result = inbox.approveAll("nonexistent", projectDir);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Entry not found");
  });

  it("rejectAll returns an error for unknown entry IDs", () => {
    const result = inbox.rejectAll("nonexistent", projectDir);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Entry not found");
  });
});
