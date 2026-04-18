import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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

  it("getFileDiffStats returns [] for unknown entries", () => {
    expect(inbox.getFileDiffStats("nonexistent", projectDir)).toEqual([]);
  });

  it("getFileDiffStats classifies adds/mods/deletes and counts line deltas", () => {
    // Seed main with two files we'll touch from the staging branch.
    writeFileSync(join(projectDir, "mod.md"), "a\nb\nc\n");
    writeFileSync(join(projectDir, "del.md"), "one\ntwo\n");
    execSync("git add mod.md del.md", { cwd: projectDir, stdio: "pipe" });
    execSync("git commit -m base", { cwd: projectDir, stdio: "pipe" });

    // Branch — modify, delete, and add files.
    execSync("git checkout -b agents/editor/diff1", { cwd: projectDir, stdio: "pipe" });
    writeFileSync(join(projectDir, "mod.md"), "a\nB-CHANGED\nc\nd\n");
    execSync("rm del.md", { cwd: projectDir, stdio: "pipe" });
    writeFileSync(join(projectDir, "new.md"), "fresh\nlines\nhere\n");
    execSync("git add -A", { cwd: projectDir, stdio: "pipe" });
    execSync("git commit -m agent-diff", { cwd: projectDir, stdio: "pipe" });
    execSync("git checkout main", { cwd: projectDir, stdio: "pipe" });

    inbox.createEntry({
      id: "diff1",
      projectId: "main",
      agentSlug: "editor",
      branch: "agents/editor/diff1",
      jobId: "diff1",
      filesChanged: ["mod.md", "del.md", "new.md"],
      startedAt: 1,
      finalizedAt: 2,
    });

    const stats = inbox.getFileDiffStats("diff1", projectDir);
    const byPath = new Map(stats.map((s) => [s.path, s]));

    expect(byPath.get("mod.md")?.status).toBe("M");
    expect(byPath.get("mod.md")?.added).toBeGreaterThan(0);
    expect(byPath.get("mod.md")?.removed).toBeGreaterThan(0);

    expect(byPath.get("del.md")?.status).toBe("D");
    // del.md had 2 lines; removing the file removes them.
    expect(byPath.get("del.md")?.removed).toBe(2);
    expect(byPath.get("del.md")?.added).toBe(0);

    expect(byPath.get("new.md")?.status).toBe("A");
    expect(byPath.get("new.md")?.added).toBe(3);
    expect(byPath.get("new.md")?.removed).toBe(0);
  });

  it("getFileDiffStats returns [] when the staging branch is missing", () => {
    inbox.createEntry({
      id: "ghost",
      projectId: "main",
      agentSlug: "editor",
      branch: "agents/editor/never-was",
      jobId: "ghost",
      filesChanged: ["ghost.md"],
      startedAt: 1,
      finalizedAt: 2,
    });

    expect(inbox.getFileDiffStats("ghost", projectDir)).toEqual([]);
  });

  it("setFileDecision round-trips approved/rejected/null and surfaces it on stats", () => {
    execSync("git checkout -b agents/editor/dec1", { cwd: projectDir, stdio: "pipe" });
    writeFileSync(join(projectDir, "a.md"), "alpha\n");
    writeFileSync(join(projectDir, "b.md"), "beta\n");
    execSync("git add -A", { cwd: projectDir, stdio: "pipe" });
    execSync("git commit -m agent-dec", { cwd: projectDir, stdio: "pipe" });
    execSync("git checkout main", { cwd: projectDir, stdio: "pipe" });

    inbox.createEntry({
      id: "dec1",
      projectId: "main",
      agentSlug: "editor",
      branch: "agents/editor/dec1",
      jobId: "dec1",
      filesChanged: ["a.md", "b.md"],
      startedAt: 1,
      finalizedAt: 2,
    });

    expect(inbox.setFileDecision("dec1", "a.md", "approved").success).toBe(true);
    expect(inbox.setFileDecision("dec1", "b.md", "rejected").success).toBe(true);
    expect(inbox.getFileDecisions("dec1")).toEqual({ "a.md": "approved", "b.md": "rejected" });

    const stats = inbox.getFileDiffStats("dec1", projectDir);
    const byPath = new Map(stats.map((s) => [s.path, s]));
    expect(byPath.get("a.md")?.decision).toBe("approved");
    expect(byPath.get("b.md")?.decision).toBe("rejected");

    // Clearing a decision removes that path from the map and
    //  surfaces as null on stats.
    expect(inbox.setFileDecision("dec1", "a.md", null).success).toBe(true);
    expect(inbox.getFileDecisions("dec1")).toEqual({ "b.md": "rejected" });
    const statsAfter = inbox.getFileDiffStats("dec1", projectDir);
    const aAfter = statsAfter.find((s) => s.path === "a.md");
    expect(aAfter?.decision).toBeNull();
  });

  it("setFileDecision returns error for unknown entries", () => {
    const r = inbox.setFileDecision("nope", "a.md", "approved");
    expect(r.success).toBe(false);
    expect(r.error).toBe("Entry not found");
  });

  it("approveAll partial-approves only non-rejected files and marks entry partial", () => {
    execSync("git checkout -b agents/editor/mix1", { cwd: projectDir, stdio: "pipe" });
    writeFileSync(join(projectDir, "keep.md"), "keep me\n");
    writeFileSync(join(projectDir, "drop.md"), "drop me\n");
    execSync("git add -A", { cwd: projectDir, stdio: "pipe" });
    execSync("git commit -m agent-mix", { cwd: projectDir, stdio: "pipe" });
    execSync("git checkout main", { cwd: projectDir, stdio: "pipe" });

    inbox.createEntry({
      id: "mix1",
      projectId: "main",
      agentSlug: "editor",
      branch: "agents/editor/mix1",
      jobId: "mix1",
      filesChanged: ["keep.md", "drop.md"],
      startedAt: 1,
      finalizedAt: 2,
    });
    inbox.setFileDecision("mix1", "drop.md", "rejected");

    const result = inbox.approveAll("mix1", projectDir);
    expect(result.success).toBe(true);

    // Only the non-rejected file landed on main.
    const files = execSync("ls", { cwd: projectDir, encoding: "utf-8" });
    expect(files).toContain("keep.md");
    expect(files).not.toContain("drop.md");

    // Branch deleted, entry marked partial.
    expect(branchExists(projectDir, "agents/editor/mix1")).toBe(false);
    expect(inbox.getPending("main")).toHaveLength(0);
  });

  it("approveAll falls through to rejectAll when every file is rejected", () => {
    execSync("git checkout -b agents/editor/all-rej", { cwd: projectDir, stdio: "pipe" });
    writeFileSync(join(projectDir, "x.md"), "x\n");
    execSync("git add -A", { cwd: projectDir, stdio: "pipe" });
    execSync("git commit -m agent-all-rej", { cwd: projectDir, stdio: "pipe" });
    execSync("git checkout main", { cwd: projectDir, stdio: "pipe" });
    const mainHeadBefore = gitHead(projectDir);

    inbox.createEntry({
      id: "arej",
      projectId: "main",
      agentSlug: "editor",
      branch: "agents/editor/all-rej",
      jobId: "arej",
      filesChanged: ["x.md"],
      startedAt: 1,
      finalizedAt: 2,
    });
    inbox.setFileDecision("arej", "x.md", "rejected");

    const result = inbox.approveAll("arej", projectDir);
    expect(result.success).toBe(true);
    expect(gitHead(projectDir)).toBe(mainHeadBefore); // nothing merged
    expect(branchExists(projectDir, "agents/editor/all-rej")).toBe(false);
  });
});
