import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lintProvenance } from "./lint-provenance.js";

/**
 * `lint --check provenance` tests. Builds a synthetic data tree with
 * `*.blocks.json` sidecars carrying various agent / derived_from
 * shapes, then asserts the gap detector flags exactly the rows where
 * `agent` is set AND `derived_from` is missing or empty (per the spec
 * at docs/02-storage-and-sync.md table line 84).
 */

interface Fixture {
  cwd: string;
  dataRoot: string;
}

function makeFixture(): Fixture {
  const cwd = join(tmpdir(), `lint-provenance-test-${randomBytes(4).toString("hex")}`);
  const dataRoot = join(cwd, "projects", "main", "data");
  mkdirSync(dataRoot, { recursive: true });
  return { cwd, dataRoot };
}

function writeSidecar(
  dataRoot: string,
  pagePath: string,
  blocks: Array<{
    id: string;
    type?: string;
    agent?: string;
    derived_from?: string[];
    compiled_at?: string;
  }>,
): void {
  const sidecarPath = join(dataRoot, pagePath.replace(/\.md$/, ".blocks.json"));
  const dir = sidecarPath.slice(0, sidecarPath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(sidecarPath, JSON.stringify({ version: 1, blocks }, null, 2), "utf-8");
}

describe("lintProvenance", () => {
  let fx: Fixture | null = null;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    if (fx) {
      try {
        rmSync(fx.cwd, { recursive: true, force: true });
      } catch {
        /* */
      }
      fx = null;
    }
    logSpy.mockRestore();
  });

  it("reports clean when every agent-authored block cites at least one source", () => {
    fx = makeFixture();
    writeSidecar(fx.dataRoot, "wiki/note.md", [
      { id: "blk_HUMAN", type: "paragraph" }, // human-written — ignored
      {
        id: "blk_AGENT_OK",
        type: "paragraph",
        agent: "wiki-gardener",
        derived_from: ["01HABC#blk_X"],
        compiled_at: "2026-04-11T10:00:00Z",
      },
    ]);

    lintProvenance({ project: "main", cwd: fx.cwd });

    const calls = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(calls).toContain("Provenance clean");
  });

  it("flags blocks where agent is set but derived_from is missing", () => {
    fx = makeFixture();
    writeSidecar(fx.dataRoot, "wiki/synthesis.md", [
      {
        id: "blk_AGENT_GAP",
        type: "paragraph",
        agent: "wiki-gardener",
        // no derived_from
        compiled_at: "2026-04-12T11:00:00Z",
      },
    ]);

    lintProvenance({ project: "main", cwd: fx.cwd });

    const calls = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(calls).toContain("1 provenance gap");
    expect(calls).toContain("wiki/synthesis.md");
    expect(calls).toContain("blk_AGENT_GAP");
    expect(calls).toContain("agent=wiki-gardener");
  });

  it("flags blocks where derived_from is an empty array (the explicit no-sources signal)", () => {
    fx = makeFixture();
    writeSidecar(fx.dataRoot, "wiki/empty-cites.md", [
      {
        id: "blk_EMPTY",
        agent: "evolver",
        derived_from: [],
      },
    ]);

    lintProvenance({ project: "main", cwd: fx.cwd });

    const calls = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(calls).toContain("1 provenance gap");
    expect(calls).toContain("blk_EMPTY");
  });

  it("ignores blocks without an `agent` field (human-written)", () => {
    fx = makeFixture();
    writeSidecar(fx.dataRoot, "wiki/handwritten.md", [
      { id: "blk_H1", type: "heading" },
      { id: "blk_H2", type: "paragraph", derived_from: [] },
    ]);

    lintProvenance({ project: "main", cwd: fx.cwd });

    const calls = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(calls).toContain("Provenance clean");
  });

  it("skips .agents/ and .ironlore/ subtrees (dotfile prefix)", () => {
    fx = makeFixture();
    writeSidecar(fx.dataRoot, ".agents/internal.md", [
      { id: "blk_INTERNAL", agent: "wiki-gardener" },
    ]);
    writeSidecar(fx.dataRoot, "wiki/real.md", [{ id: "blk_REAL_GAP", agent: "wiki-gardener" }]);

    lintProvenance({ project: "main", cwd: fx.cwd });

    const calls = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(calls).toContain("1 provenance gap");
    expect(calls).toContain("wiki/real.md");
    expect(calls).not.toContain(".agents/internal.md");
    expect(calls).not.toContain("blk_INTERNAL");
  });

  it("tolerates malformed sidecars without crashing the lint", () => {
    fx = makeFixture();
    const dir = join(fx.dataRoot, "wiki");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.blocks.json"), "{ this is not json", "utf-8");
    writeSidecar(fx.dataRoot, "wiki/clean.md", [{ id: "blk_OK" }]);

    const cwd = fx.cwd;
    expect(() => lintProvenance({ project: "main", cwd })).not.toThrow();
  });

  it("falls back gracefully when the data root does not exist", () => {
    fx = makeFixture();
    rmSync(fx.dataRoot, { recursive: true });

    lintProvenance({ project: "main", cwd: fx.cwd });

    const calls = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(calls).toContain("No data root");
  });
});
