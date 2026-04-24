import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmbeddingWorker } from "./embedding-worker.js";
import { createEmbeddingsApi } from "./embeddings-api.js";
import type { EmbeddingProvider } from "./providers/embedding-types.js";
import { SearchIndex } from "./search-index.js";

/**
 * EmbeddingWorker + embeddings-api tests. Uses a stub provider with
 * a call counter and a deterministic text → vector map so assertions
 * about batching and ordering stay readable.
 */

function makeTmpProject(): string {
  const dir = join(tmpdir(), `embed-worker-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(dir, ".ironlore"), { recursive: true });
  return dir;
}

class StubEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai" as const;
  readonly model = "stub-4d";
  readonly dimensions = 4;
  calls = 0;
  totalEmbedded = 0;
  shouldThrow = false;

  async embed(texts: readonly string[]): Promise<number[][]> {
    this.calls++;
    if (this.shouldThrow) throw new Error("simulated transport failure");
    this.totalEmbedded += texts.length;
    // Hash each text to a deterministic 4-dim vector — actual values
    // don't matter; we're testing the store/read round-trip.
    return texts.map((t) => {
      const h = Array.from(t.slice(0, 4).padEnd(4, "x")).map((c) => c.charCodeAt(0) / 255);
      return [h[0] ?? 0, h[1] ?? 0, h[2] ?? 0, h[3] ?? 0];
    });
  }
}

describe("EmbeddingWorker.tick", () => {
  let projectDir: string;
  let index: SearchIndex;
  let provider: StubEmbeddingProvider;
  let worker: EmbeddingWorker;

  beforeEach(() => {
    projectDir = makeTmpProject();
    index = new SearchIndex(projectDir);
    provider = new StubEmbeddingProvider();
    worker = new EmbeddingWorker(index, provider, "main", projectDir, { batchSize: 50 });
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

  it("no-ops when there's nothing to embed", async () => {
    const out = await worker.tick();
    expect(out).toEqual({ processed: 0, remaining: 0, model: "stub-4d" });
    expect(provider.calls).toBe(0);
  });

  it("embeds and stores chunks in one batch", async () => {
    index.indexPage("a.md", "# A\n\nalpha beta", "test");
    index.indexPage("b.md", "# B\n\ngamma delta", "test");
    expect(index.countChunksMissingEmbeddings()).toBe(2);

    const out = await worker.tick();
    expect(out.processed).toBe(2);
    expect(out.remaining).toBe(0);
    expect(provider.calls).toBe(1); // one batched call
    expect(provider.totalEmbedded).toBe(2);
    expect(index.countChunksMissingEmbeddings()).toBe(0);
  });

  it("respects batchSize per tick — two ticks drain a 3-chunk backlog with batchSize=2", async () => {
    index.indexPage("a.md", "# A\n\na", "test");
    index.indexPage("b.md", "# B\n\nb", "test");
    index.indexPage("c.md", "# C\n\nc", "test");

    const smallWorker = new EmbeddingWorker(index, provider, "main", projectDir, {
      batchSize: 2,
    });
    const first = await smallWorker.tick();
    expect(first.processed).toBe(2);
    expect(first.remaining).toBe(1);

    const second = await smallWorker.tick();
    expect(second.processed).toBe(1);
    expect(second.remaining).toBe(0);
    expect(provider.calls).toBe(2); // one per tick
  });

  it("does not write partial results when embed throws", async () => {
    index.indexPage("a.md", "# A\n\na", "test");
    index.indexPage("b.md", "# B\n\nb", "test");
    provider.shouldThrow = true;

    const errors: Error[] = [];
    worker.onError = (err) => errors.push(err);
    const out = await worker.tick();

    expect(out.processed).toBe(0);
    expect(out.remaining).toBe(2); // nothing got stored
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/simulated/);
    // A follow-up tick with the provider recovered should succeed.
    provider.shouldThrow = false;
    const retry = await worker.tick();
    expect(retry.processed).toBe(2);
    expect(retry.remaining).toBe(0);
  });

  it("auto-embeds a chunk written between ticks", async () => {
    index.indexPage("a.md", "# A\n\na", "test");
    await worker.tick();
    expect(index.countChunksMissingEmbeddings()).toBe(0);

    // User adds a new page — worker's next tick picks it up.
    index.indexPage("b.md", "# B\n\nb", "test");
    expect(index.countChunksMissingEmbeddings()).toBe(1);
    await worker.tick();
    expect(index.countChunksMissingEmbeddings()).toBe(0);
  });

  it("emits onBatch after a successful batch", async () => {
    index.indexPage("a.md", "# A\n\na", "test");
    const batches: Array<{ processed: number; remaining: number }> = [];
    worker.onBatch = (processed, remaining) => batches.push({ processed, remaining });
    await worker.tick();
    expect(batches).toEqual([{ processed: 1, remaining: 0 }]);
  });
});

describe("embeddings-api", () => {
  let projectDir: string;
  let index: SearchIndex;
  let provider: StubEmbeddingProvider;
  let worker: EmbeddingWorker;

  beforeEach(() => {
    projectDir = makeTmpProject();
    index = new SearchIndex(projectDir);
    provider = new StubEmbeddingProvider();
    worker = new EmbeddingWorker(index, provider, "main", projectDir);
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

  it("GET /status reports total, embedded, missing, model, dims", async () => {
    index.indexPage("a.md", "# A\n\na", "test");
    index.indexPage("b.md", "# B\n\nb", "test");
    index.storeChunkEmbedding("a.md", 0, [1, 0, 0, 0], "stub-4d");

    const api = createEmbeddingsApi({ searchIndex: index, provider, worker });
    const res = await api.request("/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      embedded: number;
      missing: number;
      model: string;
      dims: number;
      running: boolean;
    };
    expect(body).toMatchObject({
      total: 2,
      embedded: 1,
      missing: 1,
      model: "stub-4d",
      dims: 4,
      running: true,
    });
  });

  it("GET /status reports mismatched count when the model was swapped", async () => {
    index.indexPage("a.md", "# A\n\na", "test");
    // Old embedding produced under a previous model.
    index.storeChunkEmbedding("a.md", 0, [1, 0, 0, 0], "text-embedding-ada-002");
    const api = createEmbeddingsApi({ searchIndex: index, provider, worker });
    const body = (await (await api.request("/status")).json()) as { mismatched: number };
    expect(body.mismatched).toBe(1);
  });

  it("GET /status returns 503 when no provider is configured", async () => {
    const api = createEmbeddingsApi({ searchIndex: index, provider: null, worker: null });
    const res = await api.request("/status");
    expect(res.status).toBe(503);
  });

  it("POST /backfill performs one tick and returns the progress numbers", async () => {
    index.indexPage("a.md", "# A\n\na", "test");
    index.indexPage("b.md", "# B\n\nb", "test");
    const api = createEmbeddingsApi({ searchIndex: index, provider, worker });

    const res = await api.request("/backfill", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      processed: number;
      remaining: number;
      model: string;
    };
    expect(body).toEqual({ ok: true, processed: 2, remaining: 0, model: "stub-4d" });
    expect(index.countChunksMissingEmbeddings()).toBe(0);
  });

  it("POST /backfill returns 503 when no worker is configured", async () => {
    const api = createEmbeddingsApi({ searchIndex: index, provider: null, worker: null });
    const res = await api.request("/backfill", { method: "POST" });
    expect(res.status).toBe(503);
  });

  it("GET /status running=false when worker is null but provider exists (deprecated state)", async () => {
    // Edge case: if someone constructs the API with provider but no
    // worker, status still succeeds so the UI can render something
    // actionable.
    const api = createEmbeddingsApi({ searchIndex: index, provider, worker: null });
    const body = (await (await api.request("/status")).json()) as { running: boolean };
    expect(body.running).toBe(false);
  });
});
