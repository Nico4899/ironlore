import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "../providers/embedding-types.js";
import type { ChatEvent, ChatOptions, ProjectContext, Provider } from "../providers/types.js";
import { SearchIndex } from "../search-index.js";
import { expandQuery, searchWithExpansion } from "./query-expansion.js";

/**
 * Phase-11 hybrid expansion — `vec` + `hyde` rewrites embedded and
 * fused into the BM25 ranking via RRF. Uses stubbed LLM + embedding
 * providers so the test suite stays offline.
 */

function makeTmpProject(): string {
  const dir = join(tmpdir(), `query-expansion-hybrid-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(dir, ".ironlore"), { recursive: true });
  return dir;
}

const ctx: ProjectContext = { projectId: "main", fetch: globalThis.fetch };

/**
 * Stub chat provider that serves queued text responses in order.
 * The first `provider.chat()` call returns `responses[0]`, the second
 * `responses[1]`, etc. Out-of-queue calls yield an error — tests that
 * don't care can always-on this.
 */
class QueuedChatStub implements Provider {
  readonly name = "anthropic" as const;
  readonly supportsTools = true;
  readonly supportsPromptCache = true;
  calls = 0;

  constructor(private readonly responses: string[]) {}

  async *chat(_opts: ChatOptions, _ctx: ProjectContext): AsyncIterable<ChatEvent> {
    const text = this.responses[this.calls++];
    if (text === undefined) {
      yield { type: "error", message: "unexpected chat call" };
      return;
    }
    yield { type: "text", text };
    yield { type: "done", stopReason: "end_turn" };
  }
}

class StubEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai" as const;
  readonly model = "stub-4d";
  readonly dimensions = 4;
  private map: Map<string, number[]>;
  embedCalls = 0;
  shouldThrow = false;

  constructor(map: Record<string, number[]>) {
    this.map = new Map(Object.entries(map));
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    this.embedCalls++;
    if (this.shouldThrow) throw new Error("embed failed");
    return texts.map((t) => this.map.get(t) ?? [0, 0, 0, 0]);
  }
}

describe("expandQuery — vec + hyde (Phase 11 hybrid)", () => {
  let projectDir: string;
  let index: SearchIndex;

  beforeEach(() => {
    projectDir = makeTmpProject();
    index = new SearchIndex(projectDir);
    // Two pages with no strong BM25 signal so the strong-signal skip
    // doesn't short-circuit the LLM path.
    index.indexPage("alpha.md", "# Alpha\n\ntopic.", "test");
    index.indexPage("beta.md", "# Beta\n\ntopic.", "test");
  });

  afterEach(() => {
    index.close();
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("populates vecRewrite + hydeAnswer from the LLM JSON response", async () => {
    const provider = new QueuedChatStub([
      "topic keyword rewrite", // lex call
      '{"vec": "semantic topic", "hyde": "The topic is a thing that exists."}',
    ]);
    const embedding = new StubEmbeddingProvider({});
    const out = await expandQuery("topic", index, provider, ctx, "test-model", embedding);
    expect(out.lexRewrite).toBe("topic keyword rewrite");
    expect(out.vecRewrite).toBe("semantic topic");
    expect(out.hydeAnswer).toBe("The topic is a thing that exists.");
    expect(provider.calls).toBe(2); // lex + hybrid
    // expandQuery itself doesn't embed — that happens in
    // searchWithExpansion. Zero embed calls here.
    expect(embedding.embedCalls).toBe(0);
  });

  it("skips the hybrid LLM call when no embedding provider is supplied", async () => {
    const provider = new QueuedChatStub(["topic rewrite"]);
    const out = await expandQuery("topic", index, provider, ctx, "test-model");
    expect(out.vecRewrite).toBeNull();
    expect(out.hydeAnswer).toBeNull();
    // Only the lex call — skipping vec/hyde saves an LLM round-trip.
    expect(provider.calls).toBe(1);
  });

  it("gracefully nulls vec/hyde when the JSON response is malformed", async () => {
    const provider = new QueuedChatStub(["topic rewrite", "not json at all"]);
    const embedding = new StubEmbeddingProvider({});
    const out = await expandQuery("topic", index, provider, ctx, "test-model", embedding);
    expect(out.lexRewrite).toBe("topic rewrite");
    expect(out.vecRewrite).toBeNull();
    expect(out.hydeAnswer).toBeNull();
  });

  it("tolerates a ```json code fence around the JSON payload", async () => {
    const provider = new QueuedChatStub([
      "topic rewrite",
      '```json\n{"vec": "v", "hyde": "h"}\n```',
    ]);
    const embedding = new StubEmbeddingProvider({});
    const out = await expandQuery("topic", index, provider, ctx, "test-model", embedding);
    expect(out.vecRewrite).toBe("v");
    expect(out.hydeAnswer).toBe("h");
  });

  it("leaves vec/hyde null when only one of the two JSON fields is present", async () => {
    const provider = new QueuedChatStub(["topic rewrite", '{"vec": "v only"}']);
    const embedding = new StubEmbeddingProvider({});
    const out = await expandQuery("topic", index, provider, ctx, "test-model", embedding);
    expect(out.vecRewrite).toBe("v only");
    expect(out.hydeAnswer).toBeNull();
  });
});

describe("searchWithExpansion — hybrid four-channel RRF", () => {
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

  it("runs vector probes against the BM25 candidate set", async () => {
    index.indexPage("candidate.md", "# Candidate\n\ntopic content", "test");
    index.indexPage("far.md", "# Far\n\ntopic content", "test");
    // `candidate.md` gets a vector that matches the `vec` probe exactly;
    // `far.md` gets an orthogonal vector.
    index.storeChunkEmbedding("candidate.md", 0, [1, 0, 0, 0], "stub-4d");
    index.storeChunkEmbedding("far.md", 0, [0, 1, 0, 0], "stub-4d");

    const embedding = new StubEmbeddingProvider({
      "semantic topic paraphrase": [1, 0, 0, 0],
      "hypothetical answer about topic": [1, 0, 0, 0],
    });

    const out = await searchWithExpansion(
      {
        original: "topic",
        lexRewrite: null,
        vecRewrite: "semantic topic paraphrase",
        hydeAnswer: "hypothetical answer about topic",
        skipped: false,
      },
      index,
      { limit: 5, embeddingProvider: embedding, ctx },
    );

    // `candidate.md` wins the vector channels and also matches BM25,
    // so it ranks first over `far.md` which loses the vector race.
    expect(out[0]?.path).toBe("candidate.md");
    // One embed call, both texts batched in the same array.
    expect(embedding.embedCalls).toBe(1);
  });

  it("falls back to BM25-only when the embed call fails", async () => {
    index.indexPage("a.md", "# A\n\ntopic", "test");
    index.storeChunkEmbedding("a.md", 0, [1, 0, 0, 0], "stub-4d");
    const embedding = new StubEmbeddingProvider({});
    embedding.shouldThrow = true;

    const out = await searchWithExpansion(
      {
        original: "topic",
        lexRewrite: null,
        vecRewrite: "paraphrase",
        hydeAnswer: null,
        skipped: false,
      },
      index,
      { limit: 5, embeddingProvider: embedding, ctx },
    );
    // Result still surfaces via BM25 — vector failure didn't poison.
    expect(out.map((r) => r.path)).toContain("a.md");
  });

  it("skips the vector path entirely when no rewrites are present", async () => {
    index.indexPage("a.md", "# A\n\ntopic", "test");
    const embedding = new StubEmbeddingProvider({});
    await searchWithExpansion(
      {
        original: "topic",
        lexRewrite: null,
        vecRewrite: null,
        hydeAnswer: null,
        skipped: false,
      },
      index,
      { limit: 5, embeddingProvider: embedding, ctx },
    );
    // No rewrites → zero embed calls. Cost-safety for the common case.
    expect(embedding.embedCalls).toBe(0);
  });

  it("skips the vector path entirely when no embedding provider is supplied", async () => {
    index.indexPage("a.md", "# A\n\ntopic", "test");
    index.storeChunkEmbedding("a.md", 0, [1, 0, 0, 0], "stub-4d");

    const out = await searchWithExpansion(
      {
        original: "topic",
        lexRewrite: null,
        vecRewrite: "paraphrase",
        hydeAnswer: "hypothetical",
        skipped: false,
      },
      index,
      { limit: 5 },
    );
    // Behaves identically to the pre-Phase-11 two-channel merge.
    expect(out.map((r) => r.path)).toEqual(["a.md"]);
  });

  it("fuses all four channels via RRF — a page hit by all four ranks above one hit by only BM25", async () => {
    index.indexPage("all.md", "# All\n\ntopic matches everywhere", "test");
    index.indexPage("bm25only.md", "# BM25Only\n\ntopic matches only here", "test");
    // Only `all.md` has an embedding that aligns with vec/hyde probes.
    index.storeChunkEmbedding("all.md", 0, [1, 0, 0, 0], "stub-4d");
    index.storeChunkEmbedding("bm25only.md", 0, [0, 1, 0, 0], "stub-4d");

    const embedding = new StubEmbeddingProvider({
      "semantic paraphrase": [1, 0, 0, 0],
      "hypothetical answer": [1, 0, 0, 0],
    });

    const out = await searchWithExpansion(
      {
        original: "topic",
        lexRewrite: "topic keyword",
        vecRewrite: "semantic paraphrase",
        hydeAnswer: "hypothetical answer",
        skipped: false,
      },
      index,
      { limit: 5, embeddingProvider: embedding, ctx },
    );
    expect(out[0]?.path).toBe("all.md");
    expect(out.map((r) => r.path)).toContain("bm25only.md");
  });
});
