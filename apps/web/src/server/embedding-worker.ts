import { fetchForProject } from "./fetch-for-project.js";
import type { EmbeddingProvider } from "./providers/embedding-types.js";
import { ProviderRegistry } from "./providers/registry.js";
import type { SearchIndex } from "./search-index.js";

/**
 * Embedding backfill / auto-embed worker.
 *
 * Runs one tick per interval: read `getChunksMissingEmbeddings(N)`,
 * batch-embed via the configured provider, store the results. Delivers
 * two things with one loop:
 *
 *   - **Bulk backfill** — after a user enables hybrid retrieval for
 *     the first time, the vault's `pages_chunks_fts` rows have no
 *     corresponding `chunk_vectors`. The worker drains that backlog
 *     one batch at a time (default 50 chunks per tick) until every
 *     chunk is embedded.
 *   - **Auto-embed on write** — new chunks produced by `indexPage`
 *     arrive in `pages_chunks_fts` without embeddings. The worker's
 *     next tick picks them up automatically; no caller has to
 *     remember to re-embed.
 *
 * Embed failures (transport, 401, rate-limit) are logged and retried
 * on the next tick rather than crashing the worker. The `chunk_vectors`
 * table stays consistent: a chunk is either fully embedded or absent
 * from the table — never half-written.
 *
 * Runs in-process on a `setInterval` (default 30 s), same pattern as
 * the Phase-11 `HeartbeatScheduler`. One worker per project so each
 * has its own backlog.
 *
 * See docs/04-ai-and-agents.md §Phase 11 additions (gated on
 * kb.semantic_search).
 */
export interface EmbeddingWorkerOptions {
  /** Poll cadence. Default 30 000 ms — fast enough that a freshly
   *  saved page becomes semantically searchable within a minute
   *  without burning budget on empty ticks. */
  intervalMs?: number;
  /** Max chunks embedded per tick. Keeps per-call latency + cost
   *  predictable. Default 50 — ~1 s of OpenAI round-trip at current
   *  pricing/latency for 1536-dim embeddings. */
  batchSize?: number;
}

export interface EmbeddingTickResult {
  processed: number;
  remaining: number;
  model: string;
}

export class EmbeddingWorker {
  private readonly searchIndex: SearchIndex;
  private readonly provider: EmbeddingProvider;
  private readonly projectDir: string;
  private readonly projectId: string;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  /** Test / dev hook for observing successful batches. */
  onBatch?: (processed: number, remaining: number) => void;
  /** Test / dev hook for observing failures without crashing the loop. */
  onError?: (err: Error) => void;

  constructor(
    searchIndex: SearchIndex,
    provider: EmbeddingProvider,
    projectId: string,
    projectDir: string,
    opts?: EmbeddingWorkerOptions,
  ) {
    this.searchIndex = searchIndex;
    this.provider = provider;
    this.projectId = projectId;
    this.projectDir = projectDir;
    this.intervalMs = opts?.intervalMs ?? 30_000;
    this.batchSize = opts?.batchSize ?? 50;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        // The interval wrapper must never throw. `tick` already
        // swallows per-batch errors; this catch is only here to
        // handle pathological cases (SQL lock, disk full, etc.)
        // so the loop keeps running.
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      });
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass: fetch up to `batchSize` chunks missing embeddings,
   * embed them, store the results. Exposed for tests and for the
   * `POST /embeddings/backfill` endpoint that lets the UI "run to
   * completion" without waiting for the interval.
   *
   * Returns the progress numbers so callers can poll until
   * `remaining === 0`. An in-flight tick is a no-op — concurrent
   * ticks can't double-embed because the `getChunksMissingEmbeddings`
   * query is eager and the store is upsert-safe, but we skip anyway
   * to keep network cost predictable.
   */
  async tick(batchSize: number = this.batchSize): Promise<EmbeddingTickResult> {
    if (this.inFlight) {
      return {
        processed: 0,
        remaining: this.searchIndex.countChunksMissingEmbeddings(),
        model: this.provider.model,
      };
    }
    this.inFlight = true;
    try {
      const missing = this.searchIndex.getChunksMissingEmbeddings(batchSize);
      if (missing.length === 0) {
        return { processed: 0, remaining: 0, model: this.provider.model };
      }

      const ctx = ProviderRegistry.buildContext(this.projectId, (url, init) =>
        fetchForProject(this.projectDir, url, init),
      );
      let embeddings: number[][];
      try {
        embeddings = await this.provider.embed(
          missing.map((m) => m.content),
          ctx,
        );
      } catch (err) {
        // Surface to the callback so tests can assert on retry
        // semantics; swallow in production so the next tick tries
        // again. Leaves `chunk_vectors` untouched — a half-batch
        // write would be worse than none.
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
        return {
          processed: 0,
          remaining: this.searchIndex.countChunksMissingEmbeddings(),
          model: this.provider.model,
        };
      }

      let processed = 0;
      for (let i = 0; i < missing.length; i++) {
        const chunk = missing[i];
        const embedding = embeddings[i];
        if (!chunk || !embedding) continue;
        this.searchIndex.storeChunkEmbedding(
          chunk.path,
          chunk.chunkIdx,
          embedding,
          this.provider.model,
        );
        processed++;
      }

      const remaining = this.searchIndex.countChunksMissingEmbeddings();
      this.onBatch?.(processed, remaining);
      return { processed, remaining, model: this.provider.model };
    } finally {
      this.inFlight = false;
    }
  }
}
