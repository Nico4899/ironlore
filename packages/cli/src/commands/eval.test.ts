import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Relative path — the web app isn't a published package, and the CLI
// package.json doesn't wire it as a workspace dep. For tests only,
// reaching into the sibling app's source is acceptable.
// biome-ignore lint/style/useImportType: runtime value
import { SearchIndex } from "../../../../apps/web/src/server/search-index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evalCommand } from "./eval.js";

/**
 * `ironlore eval` tests.
 *
 * Builds a real index in a tempdir, shells the command through it,
 * and asserts:
 *   - Overall score crosses 50 on a seeded KB (exit criterion)
 *   - `--json` output parses and carries the right shape
 *   - `--perf-only` / `--quality-only` scoping filters the report
 *   - No-index path errors gracefully
 */

function makeTmpCwd(): string {
  const cwd = join(tmpdir(), `eval-cli-${randomBytes(4).toString("hex")}`);
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

function makeProject(cwd: string, projectId: string): string {
  const projectDir = join(cwd, "projects", projectId);
  mkdirSync(join(projectDir, "data"), { recursive: true });
  mkdirSync(join(projectDir, ".ironlore"), { recursive: true });
  return projectDir;
}

function seedIndex(projectDir: string, pageCount: number): void {
  const index = new SearchIndex(projectDir);
  try {
    for (let i = 0; i < pageCount; i++) {
      // Each page has a block-ID comment so block-ID coverage is 100%.
      // Pages cross-link to build a connected graph (no orphans).
      const prev = i > 0 ? `See [[page-${i - 1}]].` : "";
      const next = i < pageCount - 1 ? `See [[page-${i + 1}]].` : "";
      const content = [
        `# Page ${i}`,
        "",
        `${prev} Some content about topic ${i}. ${next}`,
        "",
        `<!-- #blk_01HABCABCABCABCABCABCABC${i.toString(36).padStart(2, "0").toUpperCase().slice(-2)} -->`,
      ].join("\n");
      index.indexPage(`page-${i}.md`, content, "test");
    }
  } finally {
    index.close();
  }
}

describe("ironlore eval", () => {
  let cwd: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cwd = makeTmpCwd();
    // Intercept process.exit so it doesn't kill the test runner.
    // Throw a sentinel so tests can assert the exit code.
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("exits with an error when no index exists", async () => {
    makeProject(cwd, "main");
    await expect(evalCommand({
      project: "main",
      json: false,
      perfOnly: false,
      qualityOnly: false,
      cwd,
    })).rejects.toThrow("__exit_1__");
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("No index found"));
  });

  it("produces a quality score > 50 on a well-connected seed KB", async () => {
    // Exit criterion: `ironlore eval` produces a score > 50 on the seed KB.
    const projectDir = makeProject(cwd, "main");
    seedIndex(projectDir, 20);

    let output = "";
    logSpy.mockImplementation((...args: unknown[]) => {
      output += `${args.join(" ")}\n`;
    });

    await evalCommand({
      project: "main",
      json: true,
      perfOnly: false,
      qualityOnly: false,
      cwd,
    });

    const report = JSON.parse(output) as {
      quality: { overall_score: number };
      dataset: { pages: number; ftsEntries: number };
    };
    expect(report.quality.overall_score).toBeGreaterThan(50);
    expect(report.dataset.pages).toBeGreaterThan(0);
    expect(report.dataset.ftsEntries).toBeGreaterThan(0);
  });

  it("--perf-only skips quality checks", async () => {
    const projectDir = makeProject(cwd, "main");
    seedIndex(projectDir, 5);

    let output = "";
    logSpy.mockImplementation((...args: unknown[]) => {
      output += `${args.join(" ")}\n`;
    });

    await evalCommand({
      project: "main",
      json: true,
      perfOnly: true,
      qualityOnly: false,
      cwd,
    });

    const report = JSON.parse(output) as Record<string, unknown>;
    expect(report.performance).toBeDefined();
    expect(report.quality).toBeUndefined();
  });

  it("--quality-only skips performance checks", async () => {
    const projectDir = makeProject(cwd, "main");
    seedIndex(projectDir, 5);

    let output = "";
    logSpy.mockImplementation((...args: unknown[]) => {
      output += `${args.join(" ")}\n`;
    });

    await evalCommand({
      project: "main",
      json: true,
      perfOnly: false,
      qualityOnly: true,
      cwd,
    });

    const report = JSON.parse(output) as Record<string, unknown>;
    expect(report.performance).toBeUndefined();
    expect(report.quality).toBeDefined();
  });

  it("exits with code 1 when overall score is below 50", async () => {
    // Score = wiki_integrity*30 + (1-orphan)*25 + block_id_cov*25 + chunk*20.
    // Forcing sub-50: a page with a broken backlink (drops wiki integrity),
    // no block IDs (drops block-ID coverage), orphan (drops orphan score).
    const projectDir = makeProject(cwd, "main");
    const index = new SearchIndex(projectDir);
    try {
      // Isolated page with broken backlink → wiki_integrity ≈ 0,
      // orphan_rate = 1, block_id_coverage = 0 (no .md on disk).
      // Even if chunk_coverage hits 1.0, score = 0 + 0 + 0 + 20 = 20.
      index.indexPage("broken.md", "Links to [[NonExistentTarget]].", "test");
    } finally {
      index.close();
    }

    await expect(
      evalCommand({
        project: "main",
        json: true,
        perfOnly: false,
        qualityOnly: false,
        cwd,
      }),
    ).rejects.toThrow("__exit_1__");
  });

  it("emits a human-readable report without --json", async () => {
    const projectDir = makeProject(cwd, "main");
    seedIndex(projectDir, 5);

    let output = "";
    logSpy.mockImplementation((...args: unknown[]) => {
      output += `${args.join(" ")}\n`;
    });

    await evalCommand({
      project: "main",
      json: false,
      perfOnly: false,
      qualityOnly: false,
      cwd,
    });

    expect(output).toContain("ironlore eval");
    expect(output).toContain("OVERALL SCORE");
    expect(output).toContain("Wiki-link integrity");
    expect(output).toContain("FTS search p50");
  });
});
