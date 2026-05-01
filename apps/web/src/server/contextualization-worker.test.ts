import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextualizationWorker } from "./contextualization-worker.js";
import { createEmbeddingsApi } from "./embeddings-api.js";
import type { ChatEvent, ChatOptions, ProjectContext, Provider } from "./providers/types.js";
import { SearchIndex } from "./search-index.js";

/**
 * ContextualizationWorker tests. Mirrors the embedding-worker test
 * shape: stub provider with a call counter, real SQLite SearchIndex,
 * temp project directory.
 */

function makeTmpProject(): string {
  const dir = join(tmpdir(), `ctx-worker-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(dir, ".ironlore"), { recursive: true });
  return dir;
}

class StubChatProvider implements Provider {
  readonly name = "anthropic" as const;
  readonly supportsTools = false;
  readonly supportsPromptCache = true;
  readonly supportsBatch = false;

  calls = 0;
  shouldThrow = false;
  responseText: string | ((opts: ChatOptions) => string) = "stub-context";

  async *chat(opts: ChatOptions, _ctx: ProjectContext): AsyncIterable<ChatEvent> {
    this.calls++;
    if (this.shouldThrow) throw new Error("simulated provider failure");
    const text =
      typeof this.responseText === "function" ? this.responseText(opts) : this.responseText;
    yield { type: "text", text };
    yield { type: "done", stopReason: "end_turn" };
  }
}

describe("ContextualizationWorker.tick", () => {
  let projectDir: string;
  let index: SearchIndex;
  let provider: StubChatProvider;
  let worker: ContextualizationWorker;

  beforeEach(() => {
    projectDir = makeTmpProject();
    index = new SearchIndex(projectDir);
    provider = new StubChatProvider();
    worker = new ContextualizationWorker(index, provider, "main", projectDir, {
      batchSize: 10,
      model: "stub-model",
    });
  });

  afterEach(() => {
    worker.stop();
    index.close();
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("no-ops when there's nothing to contextualise", async () => {
    const out = await worker.tick();
    expect(out).toEqual({ processed: 0, remaining: 0, model: "stub-model" });
    expect(provider.calls).toBe(0);
  });

  it("contextualises and stores chunks, leaving the chunk_contexts table populated", async () => {
    index.indexPage("a.md", "# A\n\nalpha beta", "test");
    index.indexPage("b.md", "# B\n\ngamma delta", "test");
    expect(index.countChunksMissingContexts()).toBe(2);

    const out = await worker.tick();
    expect(out.processed).toBe(2);
    expect(out.remaining).toBe(0);
    expect(provider.calls).toBe(2); // sequential, one call per chunk
    expect(index.countChunksWithContexts()).toBe(2);
    expect(index.countChunksMissingContexts()).toBe(0);
  });

  it("respects batchSize per tick — two ticks drain a 3-chunk backlog with batchSize=2", async () => {
    index.indexPage("a.md", "# A\n\na", "test");
    index.indexPage("b.md", "# B\n\nb", "test");
    index.indexPage("c.md", "# C\n\nc", "test");

    const smallWorker = new ContextualizationWorker(index, provider, "main", projectDir, {
      batchSize: 2,
      model: "stub-model",
    });

    const first = await smallWorker.tick();
    expect(first.processed).toBe(2);
    expect(first.remaining).toBe(1);

    const second = await smallWorker.tick();
    expect(second.processed).toBe(1);
    expect(second.remaining).toBe(0);
    expect(provider.calls).toBe(3);
  });

  it("skips persisting when generateChunkContext returns empty (provider failure)", async () => {
    index.indexPage("a.md", "# A\n\na", "test");
    index.indexPage("b.md", "# B\n\nb", "test");
    provider.shouldThrow = true;

    const out = await worker.tick();

    // Helper swallows errors → returns empty → worker doesn't persist
    //  but counts processed=0; remaining stays at 2 so the next tick
    //  retries.
    expect(out.processed).toBe(0);
    expect(out.remaining).toBe(2);
    expect(index.countChunksWithContexts()).toBe(0);
  });

  it("does not run two ticks concurrently — second call returns inFlight no-op", async () => {
    index.indexPage("a.md", "# A\n\na", "test");

    // Slow the provider so we can race two ticks.
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    provider.responseText = "later";
    const origChat = provider.chat.bind(provider);
    provider.chat = async function* (opts, ctx) {
      provider.calls++;
      await gate;
      yield { type: "text", text: "later" };
      yield { type: "done", stopReason: "end_turn" };
      void origChat;
      void opts;
      void ctx;
    } as typeof provider.chat;

    const first = worker.tick();
    const second = await worker.tick(); // second resolves immediately as no-op
    expect(second.processed).toBe(0);

    releaseFirst();
    const firstResult = await first;
    expect(firstResult.processed).toBe(1);
  });

  it("indexPage cascades — re-indexing a page drops its contexts so the worker re-fills", async () => {
    index.indexPage("a.md", "# A\n\nalpha", "test");
    await worker.tick();
    expect(index.countChunksWithContexts()).toBe(1);

    // Re-index with different content.
    index.indexPage("a.md", "# A\n\nbeta", "test");
    expect(index.countChunksWithContexts()).toBe(0);
    expect(index.countChunksMissingContexts()).toBe(1);

    await worker.tick();
    expect(index.countChunksWithContexts()).toBe(1);
  });

  it("removePage cascades — deleting a page wipes its context rows", async () => {
    index.indexPage("a.md", "# A\n\nalpha", "test");
    await worker.tick();
    expect(index.countChunksWithContexts()).toBe(1);

    index.removePage("a.md");
    expect(index.countChunksWithContexts()).toBe(0);
  });
});

describe("embeddings-api status — contextualization block", () => {
  let projectDir: string;
  let index: SearchIndex;
  let provider: StubChatProvider;
  let worker: ContextualizationWorker;

  beforeEach(() => {
    projectDir = makeTmpProject();
    index = new SearchIndex(projectDir);
    provider = new StubChatProvider();
    worker = new ContextualizationWorker(index, provider, "main", projectDir, {
      batchSize: 10,
      model: "stub-model",
    });
  });

  afterEach(() => {
    worker.stop();
    index.close();
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("status omits the contextualization block when no chat provider is wired", async () => {
    const stubEmbed = {
      name: "openai" as const,
      model: "embed-stub",
      dimensions: 4,
      embed: async () => [],
    };
    const api = createEmbeddingsApi({
      searchIndex: index,
      provider: stubEmbed,
      worker: null,
      // No chatProvider, no contextualizationWorker.
    });
    const res = await api.fetch(new Request("http://x/status"));
    const body = (await res.json()) as { contextualization: unknown };
    expect(body.contextualization).toBeNull();
  });

  it("status reports backlog counts when a chat provider is wired", async () => {
    index.indexPage("a.md", "# A\n\na", "test");
    index.indexPage("b.md", "# B\n\nb", "test");

    const stubEmbed = {
      name: "openai" as const,
      model: "embed-stub",
      dimensions: 4,
      embed: async () => [],
    };
    const api = createEmbeddingsApi({
      searchIndex: index,
      provider: stubEmbed,
      worker: null,
      chatProvider: provider,
      contextualizationWorker: worker,
    });

    const res = await api.fetch(new Request("http://x/status"));
    const body = (await res.json()) as {
      contextualization: { total: number; contextualized: number; missing: number; running: boolean };
    };
    expect(body.contextualization.total).toBe(2);
    expect(body.contextualization.missing).toBe(2);
    expect(body.contextualization.contextualized).toBe(0);
    expect(body.contextualization.running).toBe(true);
  });
});
