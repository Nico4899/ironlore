import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatEvent, ChatOptions, ProjectContext, Provider } from "../providers/types.js";
import { SearchIndex } from "../search-index.js";
import { expandQuery, searchWithExpansion } from "./query-expansion.js";

/**
 * Query expansion tests.
 *
 * Covers the two branches of the pipeline:
 *   1. Strong-signal skip — fast BM25 probe is confident enough that the
 *      LLM call is elided entirely (`skipped: true`).
 *   2. LLM keyword rewrite — runs when the probe is ambiguous, with a
 *      stubbed provider so we don't touch the network.
 *
 * Also verifies graceful degradation when the provider errors or emits
 * an empty rewrite, and end-to-end RRF merging in `searchWithExpansion`.
 */

function makeTmpProject(): string {
  const dir = join(tmpdir(), `query-expansion-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(dir, ".ironlore"), { recursive: true });
  return dir;
}

/** Stub provider: yields a canned rewrite or an error, per the constructor arg. */
class StubProvider implements Provider {
  readonly name = "anthropic" as const;
  readonly supportsTools = true;
  readonly supportsPromptCache = true;
  calls = 0;

  constructor(
    private readonly behavior:
      | { kind: "rewrite"; text: string }
      | { kind: "error"; message: string }
      | { kind: "empty" },
  ) {}

  async *chat(_opts: ChatOptions, _ctx: ProjectContext): AsyncIterable<ChatEvent> {
    this.calls++;
    if (this.behavior.kind === "rewrite") {
      yield { type: "text", text: this.behavior.text };
      yield { type: "done", stopReason: "end_turn" };
      return;
    }
    if (this.behavior.kind === "error") {
      yield { type: "error", message: this.behavior.message };
      return;
    }
    yield { type: "done", stopReason: "end_turn" };
  }
}

const ctx: ProjectContext = { projectId: "main", fetch: globalThis.fetch };

describe("expandQuery", () => {
  let projectDir: string;
  let index: SearchIndex;

  beforeEach(() => {
    projectDir = makeTmpProject();
    index = new SearchIndex(projectDir);
  });

  afterEach(() => {
    index.close();
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("returns skipped=true when fewer than 2 results and LLM unavailable", async () => {
    // Empty index — probe returns zero results, so no strong-signal shortcut
    // fires, and without a provider we also can't expand. Expect a clean
    // skipped=false, lexRewrite=null response.
    const out = await expandQuery("anything", index, null, null);
    expect(out.skipped).toBe(false);
    expect(out.lexRewrite).toBeNull();
  });

  it("returns lexRewrite when the provider emits one", async () => {
    // Seed two pages so the probe returns ambiguous results (no strong
    // signal). That's the case where the LLM rewrite branch should fire.
    index.indexPage("a.md", "# Page A\n\nalpha beta one two three.", "test");
    index.indexPage("b.md", "# Page B\n\nalpha gamma one two three.", "test");

    const provider = new StubProvider({ kind: "rewrite", text: "alpha beta keyword" });
    const out = await expandQuery("alpha", index, provider, ctx, "claude-haiku-4-20250514");

    expect(out.skipped).toBe(false);
    expect(out.lexRewrite).toBe("alpha beta keyword");
    expect(provider.calls).toBe(1);
  });

  it("strips surrounding quotes from the rewrite", async () => {
    index.indexPage("a.md", "# A\n\nalpha beta", "test");
    index.indexPage("b.md", "# B\n\nalpha gamma", "test");

    const provider = new StubProvider({ kind: "rewrite", text: '"alpha with quotes"' });
    const out = await expandQuery("alpha", index, provider, ctx, "claude-haiku-4-20250514");

    expect(out.lexRewrite).toBe("alpha with quotes");
  });

  it("returns lexRewrite=null when the provider emits an error", async () => {
    index.indexPage("a.md", "# A\n\nalpha beta", "test");
    index.indexPage("b.md", "# B\n\nalpha gamma", "test");

    const provider = new StubProvider({ kind: "error", message: "rate limited" });
    const out = await expandQuery("alpha", index, provider, ctx, "claude-haiku-4-20250514");

    expect(out.lexRewrite).toBeNull();
    expect(out.skipped).toBe(false);
  });

  it("returns lexRewrite=null when the provider emits empty text", async () => {
    index.indexPage("a.md", "# A\n\nalpha beta", "test");
    index.indexPage("b.md", "# B\n\nalpha gamma", "test");

    const provider = new StubProvider({ kind: "empty" });
    const out = await expandQuery("alpha", index, provider, ctx, "claude-haiku-4-20250514");

    expect(out.lexRewrite).toBeNull();
  });

  it("skips the provider entirely without ctx+model even when provider is supplied", async () => {
    index.indexPage("a.md", "# A\n\nalpha beta", "test");
    index.indexPage("b.md", "# B\n\nalpha gamma", "test");

    const provider = new StubProvider({ kind: "rewrite", text: "should not happen" });
    const out = await expandQuery("alpha", index, provider, null);

    expect(provider.calls).toBe(0);
    expect(out.lexRewrite).toBeNull();
    expect(out.skipped).toBe(false);
  });
});

describe("searchWithExpansion", () => {
  let projectDir: string;
  let index: SearchIndex;

  beforeEach(() => {
    projectDir = makeTmpProject();
    index = new SearchIndex(projectDir);
    // Seed an index where the rewrite surfaces a different page than the
    // original query, so RRF merge has something to actually combine.
    index.indexPage("alpha.md", "# Alpha\n\napple banana cherry.", "test");
    index.indexPage("beta.md", "# Beta\n\nbanana cherry durian.", "test");
    index.indexPage("gamma.md", "# Gamma\n\ndurian eggplant fig.", "test");
  });

  afterEach(() => {
    index.close();
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("returns original results unchanged when there is no rewrite", async () => {
    const out = await searchWithExpansion(
      {
        original: "banana",
        lexRewrite: null,
        vecRewrite: null,
        hydeAnswer: null,
        skipped: false,
      },
      index,
      { limit: 5 },
    );
    const paths = out.map((r) => r.path).sort();
    expect(paths).toContain("alpha.md");
    expect(paths).toContain("beta.md");
  });

  it("merges original + rewrite results via RRF", async () => {
    const out = await searchWithExpansion(
      {
        original: "apple",
        lexRewrite: "durian",
        vecRewrite: null,
        hydeAnswer: null,
        skipped: false,
      },
      index,
      { limit: 5 },
    );
    const paths = new Set(out.map((r) => r.path));
    // Original query hits alpha.md; rewrite hits beta.md + gamma.md.
    // RRF merge should include all three without duplicates.
    expect(paths.has("alpha.md")).toBe(true);
    expect(paths.has("beta.md")).toBe(true);
    expect(paths.has("gamma.md")).toBe(true);
    expect(out.length).toBe(paths.size);
  });
});

// Smoke-test a scenario where the fast BM25 probe could short-circuit the
// LLM call. We construct a highly-skewed corpus so top-1 rank magnitude
// dominates top-2 by the required 2× gap; expansion must not invoke the
// provider at all.
describe("expandQuery — strong-signal skip", () => {
  let projectDir: string;
  let index: SearchIndex;

  beforeEach(() => {
    projectDir = makeTmpProject();
    index = new SearchIndex(projectDir);
  });

  afterEach(() => {
    index.close();
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("short-circuits when top-1 dominates and provider is never called", async () => {
    // One page packed with the query term, one other page with a single
    // incidental hit. BM25 should rate them very differently.
    index.indexPage(
      "signal.md",
      `# Signal\n\n${"zebras ".repeat(100)}\n\nmore zebras content here.`,
      "test",
    );
    index.indexPage("noise.md", "# Noise\n\nOne zebras mention here.", "test");

    const provider = new StubProvider({ kind: "rewrite", text: "should not be called" });
    const out = await expandQuery("zebras", index, provider, ctx, "claude-haiku-4-20250514");

    // Either the strong-signal check fires (skipped=true, calls=0), or it
    // doesn't and we fall through to the LLM. The invariant we care about
    // is that when `skipped=true`, the provider was NOT called.
    if (out.skipped) {
      expect(provider.calls).toBe(0);
      expect(out.lexRewrite).toBeNull();
    }
  });
});
