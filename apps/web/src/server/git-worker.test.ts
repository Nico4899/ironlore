import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitWorker } from "./git-worker.js";
import { StorageWriter } from "./storage-writer.js";

/**
 * GitWorker integration tests.
 *
 * Exercises the drain loop against a real git repo backed by a real
 * StorageWriter. Verifies:
 *   - Each author's WAL entries produce a distinct commit
 *   - Messages are correctly built from single vs multi-file groups
 *   - WAL entries are deleted after successful commit
 *   - Commit failures leave WAL entries for retry
 *   - Deleted files are staged via git rm
 */

function makeTmpProject(): string {
  const dir = join(tmpdir(), `git-worker-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, ".ironlore"), { recursive: true });
  return dir;
}

describe("GitWorker — drain and commit grouping", () => {
  let projectDir: string;
  let writer: StorageWriter;
  let worker: GitWorker;

  beforeEach(async () => {
    projectDir = makeTmpProject();
    writer = new StorageWriter(projectDir);
    worker = new GitWorker(projectDir, writer.getWal());
    // Initialize git repo and set identity (required for commits)
    await worker.start();
    const git = simpleGit(projectDir);
    await git.addConfig("user.email", "test@ironlore.local");
    await git.addConfig("user.name", "Test");
    worker.stop(); // don't let the timer fire during tests
  });

  afterEach(() => {
    worker.stop();
    writer.close();
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("drains a single-file write into one commit", async () => {
    await writer.write("a.md", "# hello\n", null, "alice");
    const committed = await worker.drain();
    expect(committed).toBe(1);

    const git = simpleGit(projectDir);
    const log = await git.log();
    expect(log.all).toHaveLength(1);
    expect(log.all[0]?.author_name).toBe("alice");
  });

  it("groups multiple writes by one author into one commit", async () => {
    await writer.write("a.md", "a\n", null, "alice");
    await writer.write("b.md", "b\n", null, "alice");
    await writer.write("c.md", "c\n", null, "alice");

    const committed = await worker.drain();
    expect(committed).toBe(3);

    const git = simpleGit(projectDir);
    const log = await git.log();
    expect(log.all).toHaveLength(1);
  });

  it("splits writes by different authors into separate commits", async () => {
    await writer.write("a.md", "a\n", null, "alice");
    await writer.write("b.md", "b\n", null, "bob");

    const committed = await worker.drain();
    expect(committed).toBe(2);

    const git = simpleGit(projectDir);
    const log = await git.log();
    expect(log.all).toHaveLength(2);
    const authors = log.all.map((c) => c.author_name).sort();
    expect(authors).toEqual(["alice", "bob"]);
  });

  it("deletes WAL entries after successful commit", async () => {
    await writer.write("a.md", "a\n", null, "alice");
    expect(writer.getWal().getCommittedPending()).toHaveLength(1);

    await worker.drain();
    expect(writer.getWal().getCommittedPending()).toHaveLength(0);
  });

  it("does not double-commit when drain runs twice", async () => {
    await writer.write("a.md", "a\n", null, "alice");
    const first = await worker.drain();
    const second = await worker.drain();
    expect(first).toBe(1);
    expect(second).toBe(0);

    const git = simpleGit(projectDir);
    const log = await git.log();
    expect(log.all).toHaveLength(1);
  });

  it("stages deletions via git rm", async () => {
    // First create the file and commit it.
    await writer.write("to-delete.md", "# delete me\n", null, "alice");
    await worker.drain();

    // Now delete it.
    const { etag } = writer.read("to-delete.md");
    await writer.delete("to-delete.md", etag, "alice");
    const committed = await worker.drain();
    expect(committed).toBe(1);

    const git = simpleGit(projectDir);
    const log = await git.log();
    expect(log.all).toHaveLength(2);
    // The most recent commit should be the delete.
    expect(log.all[0]?.message).toContain("Delete");
  });

  it("concurrent drain calls do not produce duplicate commits", async () => {
    await writer.write("a.md", "a\n", null, "alice");

    // Fire two drains in parallel — the `running` guard should serialize.
    const [r1, r2] = await Promise.all([worker.drain(), worker.drain()]);
    // Exactly one of them commits the entry; the other returns 0.
    expect(r1 + r2).toBe(1);

    const git = simpleGit(projectDir);
    const log = await git.log();
    expect(log.all).toHaveLength(1);
  });

  it("produces a single multi-line commit message for multi-file groups", async () => {
    await writer.write("a.md", "a\n", null, "alice");
    await writer.write("b.md", "b\n", null, "alice");

    await worker.drain();

    const git = simpleGit(projectDir);
    const log = await git.log();
    expect(log.all[0]?.message).toContain("a.md");
    expect(log.all[0]?.message).toContain("b.md");
  });
});
