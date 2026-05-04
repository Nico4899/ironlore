import { randomBytes } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCrossProjectCopyApi, stampProvenance } from "./cross-project-copy.js";
import { ProjectServices } from "./project-services.js";

/**
 * Cross-project copy endpoint (docs/08-projects-and-isolation.md
 * §Cross-project copy workflow).
 *
 * The critical behaviours:
 *  · source is read through the source project's writer only;
 *  · target page gets a `copied_from` frontmatter stamp;
 *  · collision resolves to `-copy` / `-copy-2` / … unless the caller
 *    opts into overwrite;
 *  · copies between the same project are rejected (400);
 *  · unknown source/target project is 404.
 */

function makeInstall(): { installRoot: string; cleanup: () => void } {
  const raw = join(tmpdir(), `xcopy-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(raw, "projects"), { recursive: true });
  const installRoot = realpathSync(raw);
  return {
    installRoot,
    cleanup: () => {
      try {
        rmSync(installRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

function seed(installRoot: string, projectId: string): ProjectServices {
  const dir = join(installRoot, "projects", projectId);
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, ".ironlore", "locks"), { recursive: true });
  mkdirSync(join(dir, ".ironlore", "wal"), { recursive: true });
  return ProjectServices.forProject(installRoot, projectId);
}

describe("stampProvenance", () => {
  it("prepends frontmatter if none exists", () => {
    const out = stampProvenance("# Hello\n", {
      srcProject: "alpha",
      srcPath: "notes/a.md",
      sourceSha: "abcd1234",
    });
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("copied_from: alpha/notes/a.md@abcd1234");
    expect(out).toContain("# Hello");
  });

  it("appends into existing frontmatter without duplicating a prior stamp", () => {
    const input = "---\ntitle: A\ncopied_from: old/bar.md@deadbeef\n---\n\n# Body\n";
    const out = stampProvenance(input, {
      srcProject: "alpha",
      srcPath: "bar.md",
      sourceSha: "feedface",
    });
    const stampMatches = out.match(/copied_from:/g) ?? [];
    expect(stampMatches).toHaveLength(1);
    expect(out).toContain("copied_from: alpha/bar.md@feedface");
    expect(out).toContain("title: A");
  });

  it("omits @sha when source sha is unavailable", () => {
    const out = stampProvenance("body", {
      srcProject: "alpha",
      srcPath: "a.md",
      sourceSha: null,
    });
    expect(out).toContain("copied_from: alpha/a.md");
    expect(out).not.toMatch(/copied_from:[^@]*@/);
  });
});

describe("createCrossProjectCopyApi", () => {
  let install: ReturnType<typeof makeInstall>;
  let alpha: ProjectServices;
  let beta: ProjectServices;
  let app: Hono;

  beforeEach(() => {
    install = makeInstall();
    alpha = seed(install.installRoot, "alpha");
    beta = seed(install.installRoot, "beta");
    app = new Hono();
    app.route(
      "/api/projects",
      createCrossProjectCopyApi({
        resolveProject: (id) => (id === "alpha" ? alpha : id === "beta" ? beta : null),
      }),
    );
  });

  afterEach(async () => {
    await alpha.stop();
    await beta.stop();
    install.cleanup();
  });

  async function post(srcId: string, srcPath: string, body: unknown): Promise<Response> {
    return app.request(`/api/projects/${srcId}/pages/${srcPath}/copy-to`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("copies a page and stamps copied_from frontmatter", async () => {
    await alpha.writer.write("note.md", "# Hello\n\nbody\n", null);

    const res = await post("alpha", "note.md", { targetProjectId: "beta" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      targetProjectId: string;
      targetPath: string;
      etag: string;
      renamed: boolean;
    };
    expect(body.targetProjectId).toBe("beta");
    expect(body.targetPath).toBe("note.md");
    expect(body.renamed).toBe(false);

    const copied = beta.writer.read("note.md");
    expect(copied.content).toContain("copied_from: alpha/note.md");
    expect(copied.content).toContain("# Hello");
  });

  it("renames on collision (default onConflict=rename)", async () => {
    await alpha.writer.write("dup.md", "# A\n", null);
    await beta.writer.write("dup.md", "# Existing\n", null);

    const res = await post("alpha", "dup.md", { targetProjectId: "beta" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { targetPath: string; renamed: boolean };
    expect(body.renamed).toBe(true);
    expect(body.targetPath).toBe("dup-copy.md");
    // The original page is untouched.
    expect(beta.writer.read("dup.md").content).toContain("Existing");
  });

  it("overwrites when onConflict=overwrite", async () => {
    await alpha.writer.write("dup.md", "# A (alpha)\n", null);
    await beta.writer.write("dup.md", "# B (beta old)\n", null);

    const res = await post("alpha", "dup.md", {
      targetProjectId: "beta",
      onConflict: "overwrite",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { targetPath: string; renamed: boolean };
    expect(body.renamed).toBe(false);
    expect(body.targetPath).toBe("dup.md");
    expect(beta.writer.read("dup.md").content).toContain("A (alpha)");
  });

  it("rejects same-project copies with 400", async () => {
    await alpha.writer.write("x.md", "# x\n", null);
    const res = await post("alpha", "x.md", { targetProjectId: "alpha" });
    expect(res.status).toBe(400);
  });

  it("404 on unknown target project", async () => {
    await alpha.writer.write("x.md", "# x\n", null);
    const res = await post("alpha", "x.md", { targetProjectId: "gamma" });
    expect(res.status).toBe(404);
  });

  it("404 on missing source page", async () => {
    const res = await post("alpha", "nope.md", { targetProjectId: "beta" });
    expect(res.status).toBe(404);
  });

  it("400 on non-markdown source", async () => {
    const res = await post("alpha", "image.png", { targetProjectId: "beta" });
    expect(res.status).toBe(400);
  });
});
