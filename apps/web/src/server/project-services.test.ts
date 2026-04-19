import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectServices } from "./project-services.js";

/**
 * ProjectServices — multi-project isolation (docs/08-projects-and-isolation.md
 * §Per-project state).
 *
 * The bundle owns one StorageWriter, SearchIndex, LinksRegistry, git
 * worker, and file watcher per project. The critical invariant is
 * that a write to project A never surfaces in project B's data root,
 * search index, or git log — the lethal-trifecta guarantee starts
 * here.
 */

function makeInstall(): { installRoot: string; cleanup: () => void } {
  const rawRoot = join(tmpdir(), `svc-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(rawRoot, "projects"), { recursive: true });
  // macOS tmp is a symlink — resolveSafe normalises via realpath, so
  //  tests that compare computed dataRoot against expected paths
  //  must do the same.
  const installRoot = realpathSync(rawRoot);
  const cleanup = () => {
    try {
      rmSync(installRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
  return { installRoot, cleanup };
}

function seedProjectDir(installRoot: string, projectId: string): string {
  const dir = join(installRoot, "projects", projectId);
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, ".ironlore"), { recursive: true });
  mkdirSync(join(dir, ".ironlore", "locks"), { recursive: true });
  mkdirSync(join(dir, ".ironlore", "wal"), { recursive: true });
  return dir;
}

describe("ProjectServices.forProject", () => {
  let install: ReturnType<typeof makeInstall>;

  beforeEach(() => {
    install = makeInstall();
    seedProjectDir(install.installRoot, "alpha");
    seedProjectDir(install.installRoot, "beta");
  });

  afterEach(() => install.cleanup());

  it("resolves the expected data root for a project id", () => {
    const services = ProjectServices.forProject(install.installRoot, "alpha");
    try {
      expect(services.projectDir).toBe(join(install.installRoot, "projects", "alpha"));
      expect(services.getDataRoot()).toBe(
        join(install.installRoot, "projects", "alpha", "data"),
      );
    } finally {
      services.stop();
    }
  });

  it("writes to one project are invisible to another project's writer", async () => {
    const alpha = ProjectServices.forProject(install.installRoot, "alpha");
    const beta = ProjectServices.forProject(install.installRoot, "beta");

    try {
      // Project alpha writes `a.md`.
      await alpha.writer.write("a.md", "# Alpha\n", null);

      // Beta's reader throws ENOENT — `a.md` doesn't exist under its root.
      expect(() => beta.writer.read("a.md")).toThrow();

      // And the file on disk lives under alpha's data root only.
      expect(existsSync(join(alpha.getDataRoot(), "a.md"))).toBe(true);
      expect(existsSync(join(beta.getDataRoot(), "a.md"))).toBe(false);
      expect(readFileSync(join(alpha.getDataRoot(), "a.md"), "utf-8")).toContain("Alpha");
    } finally {
      await alpha.stop();
      await beta.stop();
    }
  });

  it("each project has its own FTS5 index", async () => {
    const alpha = ProjectServices.forProject(install.installRoot, "alpha");
    const beta = ProjectServices.forProject(install.installRoot, "beta");

    try {
      await alpha.writer.write("note.md", "# Unique alpha content phrase xyz123\n", null);
      await alpha.searchIndex.reindexAll(alpha.getDataRoot());

      const alphaHits = alpha.searchIndex.search("xyz123", 5);
      expect(alphaHits.length).toBeGreaterThan(0);

      // Beta's index never saw the page.
      const betaHits = beta.searchIndex.search("xyz123", 5);
      expect(betaHits).toHaveLength(0);
    } finally {
      await alpha.stop();
      await beta.stop();
    }
  });

  it("stop() is idempotent and closes DB handles", async () => {
    const services = ProjectServices.forProject(install.installRoot, "alpha");
    await services.stop();
    await expect(services.stop()).resolves.not.toThrow();
  });

  it("start() refuses to double-start the same bundle", async () => {
    const services = ProjectServices.forProject(install.installRoot, "alpha");
    try {
      // biome-ignore lint/suspicious/noExplicitAny: noop stand-in for WS broadcaster
      await services.start((() => {}) as any);
      // biome-ignore lint/suspicious/noExplicitAny: noop stand-in for WS broadcaster
      await expect(services.start((() => {}) as any)).rejects.toThrow(/already started/);
    } finally {
      await services.stop();
    }
  });
});
