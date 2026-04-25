import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlocksIndex } from "@ironlore/core";
import { afterEach, describe, expect, it } from "vitest";
import { createKbLintProvenanceGaps } from "./kb-lint-provenance-gaps.js";
import type { ToolCallContext } from "./types.js";

/**
 * `kb.lint_provenance_gaps` — walks the on-disk `.blocks.json`
 * sidecars under `dataRoot` and reports every agent-authored
 * block missing a `derived_from` citation.
 */

function makeTmpDataRoot(): string {
  const dir = join(tmpdir(), `lint-prov-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const NO_CTX: ToolCallContext = {
  projectId: "main",
  agentSlug: "wiki-gardener",
  jobId: "test",
  emitEvent: () => undefined,
  dataRoot: "",
  fetch: globalThis.fetch,
};

function writeSidecar(dataRoot: string, mdPath: string, index: BlocksIndex): void {
  const full = join(dataRoot, mdPath.replace(/\.md$/, ".blocks.json"));
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, JSON.stringify(index, null, 2));
}

const dataRoots: string[] = [];
function makeRoot(): string {
  const r = makeTmpDataRoot();
  dataRoots.push(r);
  return r;
}

describe("kb.lint_provenance_gaps", () => {
  afterEach(() => {
    while (dataRoots.length > 0) dataRoots.pop();
  });

  it("returns count: 0 on an empty data root", async () => {
    const root = makeRoot();
    const tool = createKbLintProvenanceGaps(root);
    const result = JSON.parse(await tool.execute({}, NO_CTX)) as { count: number };
    expect(result.count).toBe(0);
  });

  it("flags an agent-authored block with no derived_from", async () => {
    const root = makeRoot();
    writeSidecar(root, "a.md", {
      version: 1,
      blocks: [
        {
          id: "blk_01HY0A1234567890ABCDEFGHIJ",
          type: "paragraph",
          start: 0,
          end: 20,
          agent: "wiki-gardener",
          compiled_at: "2026-04-25T12:00:00Z",
        },
      ],
    });

    const tool = createKbLintProvenanceGaps(root);
    const result = JSON.parse(await tool.execute({}, NO_CTX)) as {
      count: number;
      gaps: Array<{ pagePath: string; blockId: string; agent: string }>;
    };
    expect(result.count).toBe(1);
    expect(result.gaps[0]).toMatchObject({
      pagePath: "a.md",
      blockId: "blk_01HY0A1234567890ABCDEFGHIJ",
      agent: "wiki-gardener",
    });
  });

  it("ignores blocks with derived_from set", async () => {
    const root = makeRoot();
    writeSidecar(root, "a.md", {
      version: 1,
      blocks: [
        {
          id: "blk_01HY0A1234567890ABCDEFGHIJ",
          type: "paragraph",
          start: 0,
          end: 20,
          agent: "wiki-gardener",
          derived_from: ["sources/foo.md#blk_01HSOURCE0000000000000000"],
          compiled_at: "2026-04-25T12:00:00Z",
        },
      ],
    });
    const tool = createKbLintProvenanceGaps(root);
    const result = JSON.parse(await tool.execute({}, NO_CTX)) as { count: number };
    expect(result.count).toBe(0);
  });

  it("ignores blocks where `agent` is unset (= human-authored)", async () => {
    const root = makeRoot();
    writeSidecar(root, "a.md", {
      version: 1,
      blocks: [
        {
          id: "blk_01HY0A1234567890ABCDEFGHIJ",
          type: "paragraph",
          start: 0,
          end: 20,
        },
      ],
    });
    const tool = createKbLintProvenanceGaps(root);
    const result = JSON.parse(await tool.execute({}, NO_CTX)) as { count: number };
    expect(result.count).toBe(0);
  });

  it("walks subdirectories + reports forward-slash paths", async () => {
    const root = makeRoot();
    writeSidecar(root, "wiki/topic.md", {
      version: 1,
      blocks: [
        {
          id: "blk_01HY0BX234567890ABCDEFGHIJ",
          type: "paragraph",
          start: 0,
          end: 10,
          agent: "wiki-gardener",
        },
      ],
    });
    writeSidecar(root, "deep/nested/page.md", {
      version: 1,
      blocks: [
        {
          id: "blk_01HY0CY234567890ABCDEFGHIJ",
          type: "paragraph",
          start: 0,
          end: 10,
          agent: "wiki-gardener",
          derived_from: [],
        },
      ],
    });

    const tool = createKbLintProvenanceGaps(root);
    const result = JSON.parse(await tool.execute({}, NO_CTX)) as {
      count: number;
      gaps: Array<{ pagePath: string }>;
    };
    expect(result.count).toBe(2);
    const paths = result.gaps.map((g) => g.pagePath).sort();
    expect(paths).toEqual(["deep/nested/page.md", "wiki/topic.md"]);
  });

  it("respects `excludeAgents` to skip specific authors", async () => {
    const root = makeRoot();
    writeSidecar(root, "a.md", {
      version: 1,
      blocks: [
        {
          id: "blk_01HY0DZ234567890ABCDEFGHIJ",
          type: "paragraph",
          start: 0,
          end: 10,
          agent: "wiki-gardener",
        },
        {
          id: "blk_01HY0EW234567890ABCDEFGHIJ",
          type: "paragraph",
          start: 10,
          end: 20,
          agent: "spec-reviewer",
        },
      ],
    });
    const tool = createKbLintProvenanceGaps(root);
    const result = JSON.parse(await tool.execute({ excludeAgents: ["spec-reviewer"] }, NO_CTX)) as {
      count: number;
      gaps: Array<{ agent: string }>;
    };
    expect(result.count).toBe(1);
    expect(result.gaps[0]?.agent).toBe("wiki-gardener");
  });

  it("skips dotfile directories (.ironlore, .agents, .git)", async () => {
    const root = makeRoot();
    // A sidecar that lives under a hidden directory must be
    // ignored — it isn't part of the user-facing knowledge base.
    writeSidecar(root, ".agents/internal-page.md", {
      version: 1,
      blocks: [
        {
          id: "blk_01HY0F0234567890ABCDEFGHIJ",
          type: "paragraph",
          start: 0,
          end: 10,
          agent: "wiki-gardener",
        },
      ],
    });
    writeSidecar(root, "regular-page.md", {
      version: 1,
      blocks: [
        {
          id: "blk_01HY0G0234567890ABCDEFGHIJ",
          type: "paragraph",
          start: 0,
          end: 10,
          agent: "wiki-gardener",
        },
      ],
    });
    const tool = createKbLintProvenanceGaps(root);
    const result = JSON.parse(await tool.execute({}, NO_CTX)) as {
      count: number;
      gaps: Array<{ pagePath: string }>;
    };
    expect(result.count).toBe(1);
    expect(result.gaps[0]?.pagePath).toBe("regular-page.md");
  });
});
