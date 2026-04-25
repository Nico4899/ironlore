import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SearchIndex } from "../search-index.js";
import { createKbLintContradictions } from "./kb-lint-contradictions.js";
import type { ToolCallContext } from "./types.js";

/**
 * `kb.lint_contradictions` + `SearchIndex.findContradictions`
 * together. Same fixture pattern as `kb-lint-orphans.test.ts`:
 * real SQLite on disk + real `indexPage()` writes so the
 * backlinks rel column is populated the same way a live server
 * would populate it.
 */

function makeTmpProject(): string {
  const dir = join(tmpdir(), `lint-contradictions-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, ".ironlore"), { recursive: true });
  return dir;
}

const NO_CTX: ToolCallContext = {
  projectId: "main",
  agentSlug: "wiki-gardener",
  jobId: "test",
  emitEvent: () => undefined,
  dataRoot: "",
};

describe("SearchIndex.findContradictions + kb.lint_contradictions", () => {
  const indexes: SearchIndex[] = [];

  function createIndex(): SearchIndex {
    const projectDir = makeTmpProject();
    const index = new SearchIndex(projectDir);
    indexes.push(index);
    return index;
  }

  afterEach(() => {
    while (indexes.length > 0) indexes.pop()?.close();
  });

  it("returns count: 0 when no typed `contradicts` links exist", async () => {
    const index = createIndex();
    index.indexPage("a.md", "# A\n\n[[b]] is a peer page.\n", "user");
    index.indexPage("b.md", "# B\n\nplain content\n", "user");

    const tool = createKbLintContradictions(index);
    const result = JSON.parse(await tool.execute({}, NO_CTX)) as {
      count: number;
      contradictions: unknown[];
    };
    expect(result.count).toBe(0);
    expect(result.contradictions).toEqual([]);
  });

  it("flags `[[other | contradicts]]` links", async () => {
    const index = createIndex();
    index.indexPage(
      "claim-a.md",
      "# Claim A\n\nThe sky is blue. [[claim-b | contradicts]]\n",
      "user",
    );
    index.indexPage("claim-b.md", "# Claim B\n\nThe sky is green.\n", "user");

    const tool = createKbLintContradictions(index);
    const result = JSON.parse(await tool.execute({}, NO_CTX)) as {
      count: number;
      contradictions: Array<{ sourcePath: string; targetPath: string; rel: string }>;
    };
    expect(result.count).toBe(1);
    expect(result.contradictions[0]).toMatchObject({
      sourcePath: "claim-a.md",
      targetPath: "claim-b",
      rel: "contradicts",
    });
  });

  it("accepts `disagrees` and `refutes` as rel aliases", async () => {
    const index = createIndex();
    index.indexPage("a.md", "# A\n\n[[b | disagrees]]\n", "user");
    index.indexPage("c.md", "# C\n\n[[d | refutes]]\n", "user");
    index.indexPage("b.md", "# B\n\nbody\n", "user");
    index.indexPage("d.md", "# D\n\nbody\n", "user");

    const tool = createKbLintContradictions(index);
    const result = JSON.parse(await tool.execute({}, NO_CTX)) as {
      count: number;
      contradictions: Array<{ rel: string }>;
    };
    expect(result.count).toBe(2);
    const rels = new Set(result.contradictions.map((c) => c.rel));
    expect(rels.has("disagrees")).toBe(true);
    expect(rels.has("refutes")).toBe(true);
  });

  it("ignores untyped wiki-links + unrelated rel labels", async () => {
    const index = createIndex();
    index.indexPage("a.md", "# A\n\n[[b]] is just a peer.\n", "user");
    index.indexPage("c.md", "# C\n\n[[d | extends]] adds context.\n", "user");
    index.indexPage("b.md", "# B\n\nbody\n", "user");
    index.indexPage("d.md", "# D\n\nbody\n", "user");

    const tool = createKbLintContradictions(index);
    const result = JSON.parse(await tool.execute({}, NO_CTX)) as { count: number };
    expect(result.count).toBe(0);
  });
});
