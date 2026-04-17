import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatOptions, ProjectContext, Provider } from "../providers/types.js";
import type { SearchResult } from "../search-index.js";
import { rerankResults } from "./rerank.js";

/**
 * LLM rerank tests.
 *
 * Stubs the provider to emit a JSON scores array, then asserts the
 * position-aware blend reorders results as expected. Also verifies
 * degradation paths: missing provider / ctx / model → no-op; provider
 * error → no-op; malformed JSON → no-op.
 */

class StubProvider implements Provider {
  readonly name = "anthropic" as const;
  readonly supportsTools = true;
  readonly supportsPromptCache = true;
  calls = 0;
  lastPrompt: string | null = null;

  constructor(
    private readonly behavior:
      | { kind: "scores"; text: string }
      | { kind: "error"; message: string },
  ) {}

  async *chat(opts: ChatOptions, _ctx: ProjectContext): AsyncIterable<ChatEvent> {
    this.calls++;
    const last = opts.messages.at(-1);
    this.lastPrompt =
      last && (last.role === "user" || last.role === "assistant") ? last.content : null;

    if (this.behavior.kind === "error") {
      yield { type: "error", message: this.behavior.message };
      return;
    }
    yield { type: "text", text: this.behavior.text };
    yield { type: "done", stopReason: "end_turn" };
  }
}

const ctx: ProjectContext = { projectId: "main", fetch: globalThis.fetch };

function makeResult(path: string, title: string, snippet: string, rank: number): SearchResult {
  return { path, title, snippet, rank };
}

describe("rerankResults — degradation paths", () => {
  const baseline: SearchResult[] = [
    makeResult("a.md", "A", "text about alpha", -1),
    makeResult("b.md", "B", "text about beta", -2),
    makeResult("c.md", "C", "text about gamma", -3),
    makeResult("d.md", "D", "text about delta", -4),
    makeResult("e.md", "E", "text about epsilon", -5),
  ];

  it("returns input unchanged when provider is null", async () => {
    const out = await rerankResults("query", baseline, null, ctx, "claude-haiku-4-20250514");
    expect(out).toEqual(baseline);
  });

  it("returns input unchanged when ctx is null", async () => {
    const provider = new StubProvider({ kind: "scores", text: "[1,2,3,4,5]" });
    const out = await rerankResults("query", baseline, provider, null, "claude-haiku-4-20250514");
    expect(out).toEqual(baseline);
    expect(provider.calls).toBe(0);
  });

  it("returns input unchanged when model is missing", async () => {
    const provider = new StubProvider({ kind: "scores", text: "[1,2,3,4,5]" });
    const out = await rerankResults("query", baseline, provider, ctx);
    expect(out).toEqual(baseline);
    expect(provider.calls).toBe(0);
  });

  it("returns input unchanged when result list has <= 1 entry", async () => {
    const provider = new StubProvider({ kind: "scores", text: "[10]" });
    const solo = [baseline[0] as SearchResult];
    const out = await rerankResults("query", solo, provider, ctx, "claude-haiku-4-20250514");
    expect(out).toEqual(solo);
    expect(provider.calls).toBe(0);
  });

  it("returns input unchanged when provider errors out", async () => {
    const provider = new StubProvider({ kind: "error", message: "429" });
    const out = await rerankResults("query", baseline, provider, ctx, "claude-haiku-4-20250514");
    expect(out).toEqual(baseline);
  });

  it("returns input unchanged when LLM emits non-JSON response", async () => {
    const provider = new StubProvider({ kind: "scores", text: "Sure, here are the scores." });
    const out = await rerankResults("query", baseline, provider, ctx, "claude-haiku-4-20250514");
    expect(out).toEqual(baseline);
  });
});

describe("rerankResults — blended ordering", () => {
  const baseline: SearchResult[] = [
    makeResult("a.md", "A", "alpha content", -1),
    makeResult("b.md", "B", "beta content", -2),
    makeResult("c.md", "C", "gamma content", -3),
    makeResult("d.md", "D", "delta content", -4),
    makeResult("e.md", "E", "epsilon content", -5),
  ];

  it("promotes a high-score candidate within the top tier", async () => {
    // The default blend weights dominate via retrieval in tier1, so a
    // bottom-of-pile candidate can't leapfrog the head. But LLM scores
    // CAN reorder WITHIN tier1 (positions 1-3): the linear retrieval
    // decay is modest there (1.0 vs 0.8 vs 0.6), and a score delta of
    // +9 at weight 0.25 is enough to flip them.
    const provider = new StubProvider({ kind: "scores", text: "[1, 10, 1, 1, 1]" });
    const out = await rerankResults("query", baseline, provider, ctx, "claude-haiku-4-20250514");

    expect(out.length).toBe(baseline.length);
    const top = out[0];
    expect(top?.path).toBe("b.md");
  });

  it("preserves tier-1 dominance when LLM scores are uniform", async () => {
    // When all rerank scores are equal, retrieval_score's linear decay
    // (position 1 = 1.0, position 5 = 0.0) should keep the original top-1
    // at the top.
    const provider = new StubProvider({ kind: "scores", text: "[5, 5, 5, 5, 5]" });
    const out = await rerankResults("query", baseline, provider, ctx, "claude-haiku-4-20250514");
    expect(out[0]?.path).toBe("a.md");
  });

  it("parses JSON arrays embedded in surrounding prose", async () => {
    // The prompt asks for ONLY the array, but some models prefix with
    // prose. The regex in rerank.ts extracts `\[[\d\s,.-]+\]` — verify
    // that still works.
    const provider = new StubProvider({
      kind: "scores",
      text: "Here are the scores: [9, 8, 7, 6, 5] — ordered by relevance.",
    });
    const out = await rerankResults("query", baseline, provider, ctx, "claude-haiku-4-20250514");
    expect(out[0]?.path).toBe("a.md"); // score 9 + rank 1
  });

  it("caps at 15 candidates per MAX_CANDIDATES guard", async () => {
    const many: SearchResult[] = [];
    for (let i = 0; i < 25; i++) {
      many.push(makeResult(`p${i}.md`, `P${i}`, `snippet ${i}`, -i));
    }
    // Scores for all 15 — rerank should only consider the first 15.
    const scores = Array.from({ length: 15 }, () => 5).join(",");
    const provider = new StubProvider({ kind: "scores", text: `[${scores}]` });
    const out = await rerankResults("query", many, provider, ctx, "claude-haiku-4-20250514");

    // Output length is capped to the candidate window. The 10 tail
    // entries were never re-scored, so they shouldn't appear in the
    // reordered list.
    expect(out.length).toBe(15);
    const paths = new Set(out.map((r) => r.path));
    expect(paths.has("p15.md")).toBe(false);
    expect(paths.has("p24.md")).toBe(false);
  });
});
