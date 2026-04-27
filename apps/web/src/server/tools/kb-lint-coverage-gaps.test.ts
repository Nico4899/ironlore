import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SearchIndex } from "../search-index.js";
import { createKbLintCoverageGaps } from "./kb-lint-coverage-gaps.js";
import type { ToolCallContext } from "./types.js";

/**
 * `kb.lint_coverage_gaps` + `SearchIndex.findCoverageGaps`.
 * Real SQLite + indexPage() — same code path the live server hits.
 *
 * Pinning the threshold semantics + the resolution logic so a future
 * refactor that lets a target slip past with 2 mentions, or that
 * misses a basename-stem match, fails the test.
 */

function makeTmpProject(): string {
  const dir = join(tmpdir(), `lint-coverage-test-${randomBytes(4).toString("hex")}`);
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
  fetch: globalThis.fetch,
};

describe("SearchIndex.findCoverageGaps + kb.lint_coverage_gaps", () => {
  const indexes: SearchIndex[] = [];

  function createIndex(): SearchIndex {
    const projectDir = makeTmpProject();
    const index = new SearchIndex(projectDir);
    indexes.push(index);
    return index;
  }

  afterEach(() => {
    for (const idx of indexes) idx.close();
    indexes.length = 0;
  });

  it("returns empty when no unresolved targets are cited", () => {
    const index = createIndex();
    index.indexPage("hub.md", "# Hub\n\n[[foo]] [[bar]]", "user");
    index.indexPage("foo.md", "# Foo", "user");
    index.indexPage("bar.md", "# Bar", "user");

    expect(index.findCoverageGaps()).toEqual([]);
  });

  it("does NOT flag an unresolved target with fewer than 3 mentions (default threshold)", () => {
    // Two distinct citing pages → below the default threshold.
    // A typo or one-off shouldn't drag the whole vault into a
    // false-positive coverage report.
    const index = createIndex();
    index.indexPage("a.md", "# A\n\nSee [[Concept]].", "user");
    index.indexPage("b.md", "# B\n\nAlso [[Concept]].", "user");

    expect(index.findCoverageGaps()).toEqual([]);
  });

  it("flags an unresolved target cited by ≥3 distinct pages", () => {
    // Three distinct citing pages, no page named `Concept` — the
    // textbook coverage gap. The Wiki Gardener will surface it in
    // the lint report so the user can decide to write the page.
    const index = createIndex();
    index.indexPage("a.md", "# A\n\nSee [[Concept]].", "user");
    index.indexPage("b.md", "# B\n\nAlso [[Concept]].", "user");
    index.indexPage("c.md", "# C\n\nMore [[Concept]].", "user");

    const gaps = index.findCoverageGaps();
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.target).toBe("Concept");
    expect(gaps[0]?.citationCount).toBe(3);
    expect(gaps[0]?.mentionedBy.sort()).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("counts distinct citing PAGES, not raw [[...]] occurrences", () => {
    // Two pages cite [[Concept]] but one of them does so three
    // times — that's still only 2 distinct citing pages, below
    // the default threshold. Pins this behaviour explicitly so a
    // future refactor that double-counts repeated wiki-links per
    // page fails the test.
    const index = createIndex();
    index.indexPage(
      "a.md",
      "# A\n\nSee [[Concept]] and [[Concept]] again. Yet [[Concept]] more.",
      "user",
    );
    index.indexPage("b.md", "# B\n\nAlso [[Concept]].", "user");

    expect(index.findCoverageGaps()).toEqual([]);
  });

  it("does NOT flag a target that resolves to an existing page via the basename-stem rule", () => {
    // The page lives at `notes/foo.md` but every citation is the
    // bare basename `[[foo]]`. `linkTargetCandidates` resolves
    // both spellings, so this is NOT a gap.
    const index = createIndex();
    index.indexPage("notes/foo.md", "# Foo", "user");
    index.indexPage("a.md", "# A\n\n[[foo]]", "user");
    index.indexPage("b.md", "# B\n\n[[foo]]", "user");
    index.indexPage("c.md", "# C\n\n[[foo]]", "user");

    expect(index.findCoverageGaps()).toEqual([]);
  });

  it("ignores citations from excluded prefixes (so the lint report doesn't push targets over the threshold)", () => {
    // Two real pages cite [[Ghost]]; a maintenance report cites it
    // too. The maintenance report citation MUST NOT count toward
    // the threshold — otherwise every coverage-gap finding would
    // self-perpetuate by being mentioned in the next report.
    const index = createIndex();
    index.indexPage("a.md", "# A\n\n[[Ghost]]", "user");
    index.indexPage("b.md", "# B\n\n[[Ghost]]", "user");
    index.indexPage("_maintenance/lint-2026-04-26.md", "# Report\n\n[[Ghost]]", "wiki-gardener");

    expect(index.findCoverageGaps()).toEqual([]);
  });

  it("honors a caller-supplied minMentions override", () => {
    // Power user wants to surface even single-mention concepts.
    const index = createIndex();
    index.indexPage("a.md", "# A\n\n[[OneShot]]", "user");

    const gaps = index.findCoverageGaps(1);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.target).toBe("OneShot");
  });

  it("sorts results by citationCount desc, then alphabetically", () => {
    const index = createIndex();
    index.indexPage("a.md", "# A\n\n[[Beta]] [[Alpha]]", "user");
    index.indexPage("b.md", "# B\n\n[[Beta]] [[Alpha]]", "user");
    index.indexPage("c.md", "# C\n\n[[Beta]] [[Alpha]] [[Gamma]]", "user");
    index.indexPage("d.md", "# D\n\n[[Alpha]]", "user");
    // Alpha: 4, Beta: 3, Gamma: 1.

    const gaps = index.findCoverageGaps();
    expect(gaps.map((g) => g.target)).toEqual(["Alpha", "Beta"]);
    expect(gaps[0]?.citationCount).toBe(4);
    expect(gaps[1]?.citationCount).toBe(3);
  });

  it("kb.lint_coverage_gaps tool returns a JSON envelope with count + gaps", async () => {
    const index = createIndex();
    index.indexPage("a.md", "# A\n\n[[X]]", "user");
    index.indexPage("b.md", "# B\n\n[[X]]", "user");
    index.indexPage("c.md", "# C\n\n[[X]]", "user");

    const tool = createKbLintCoverageGaps(index);
    const out = JSON.parse(await tool.execute({}, NO_CTX)) as {
      count: number;
      gaps: Array<{ target: string; citationCount: number }>;
    };
    expect(out.count).toBe(1);
    expect(out.gaps[0]?.target).toBe("X");
    expect(out.gaps[0]?.citationCount).toBe(3);
  });

  it("kb.lint_coverage_gaps respects caller-supplied minMentions", async () => {
    const index = createIndex();
    index.indexPage("a.md", "# A\n\n[[Y]]", "user");

    const tool = createKbLintCoverageGaps(index);
    const out = JSON.parse(await tool.execute({ minMentions: 1 }, NO_CTX)) as {
      count: number;
      gaps: Array<{ target: string }>;
    };
    expect(out.count).toBe(1);
  });
});
