import { generateChunkContext } from "./agents/contextual-retrieval.js";
import { fetchForProject } from "./fetch-for-project.js";
import type { Provider } from "./providers/types.js";
import { ProviderRegistry } from "./providers/registry.js";
import type { SearchIndex } from "./search-index.js";

/**
 * Background worker that drains the contextual-retrieval backlog —
 * chunks present in `pages_chunks_fts` whose row in `chunk_contexts`
 * has not been generated yet.
 *
 * Mirrors `EmbeddingWorker`'s lifecycle: start/stop on the per-project
 * services bundle, single in-flight tick at a time, errors logged to
 * a hook rather than thrown. One worker per project, since each
 * project has its own SearchIndex + provider context.
 *
 * Why a worker rather than inline at indexPage time:
 *   - A page-write that touches 50 chunks would block the writer for
 *     50 sequential Haiku round-trips. Cron-driven indexing has to
 *     stay fast.
 *   - When a user enables a provider mid-run, the existing chunks
 *     have no context. The worker backfills them automatically,
 *     no user action needed.
 *
 * Tick cadence: 30 s, batch size: 10 chunks. Sized so a fresh-vault
 * backfill of ~25k chunks completes in ~21 hours of background drain
 * (same overnight envelope as the embedding worker on a 1500-page
 * vault) without saturating the user's Haiku quota during interactive
 * work. Both knobs are constructor-overrideable for tests.
 *
 * See docs/04-ai-and-agents.md §Retrieval pipeline → Phase-4 stages.
 */
export interface ContextualizationWorkerOptions {
  /** Poll cadence. Default 30 000 ms. */
  intervalMs?: number;
  /** Max chunks contextualised per tick. Smaller than the embedding
   *  worker's 50 because each row costs an LLM round-trip rather than
   *  a single batched embedding call. */
  batchSize?: number;
  /** Override the model used by `generateChunkContext`. Tests use a
   *  cheaper-named stub; production picks the helper's default Haiku. */
  model?: string;
}

export interface ContextualizationTickResult {
  processed: number;
  remaining: number;
  model: string;
}

export class ContextualizationWorker {
  private readonly searchIndex: SearchIndex;
  private readonly provider: Provider;
  private readonly projectDir: string;
  private readonly projectId: string;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly model: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  /** Test / dev hook for observing successful batches. */
  onBatch?: (processed: number, remaining: number) => void;
  /** Test / dev hook for observing failures without crashing the loop. */
  onError?: (err: Error) => void;

  constructor(
    searchIndex: SearchIndex,
    provider: Provider,
    projectId: string,
    projectDir: string,
    opts?: ContextualizationWorkerOptions,
  ) {
    this.searchIndex = searchIndex;
    this.provider = provider;
    this.projectId = projectId;
    this.projectDir = projectDir;
    this.intervalMs = opts?.intervalMs ?? 30_000;
    this.batchSize = opts?.batchSize ?? 10;
    this.model = opts?.model ?? "claude-haiku-4-5-20251001";
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
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
   * One pass: pull up to `batchSize` chunks missing contexts, generate
   * them sequentially (so the prompt-cache key stays warm for chunks
   * sharing a source page), persist results. Sequential rather than
   * parallel because Haiku rate limits would shred a high-fanout
   * approach faster than the latency win from parallelism.
   *
   * Returns progress numbers so callers can poll until `remaining === 0`.
   */
  async tick(batchSize: number = this.batchSize): Promise<ContextualizationTickResult> {
    if (this.inFlight) {
      return {
        processed: 0,
        remaining: this.searchIndex.countChunksMissingContexts(),
        model: this.model,
      };
    }
    this.inFlight = true;
    try {
      const missing = this.searchIndex.getChunksMissingContexts(batchSize);
      if (missing.length === 0) {
        return { processed: 0, remaining: 0, model: this.model };
      }

      const ctx = ProviderRegistry.buildContext(this.projectId, (url, init) =>
        fetchForProject(this.projectDir, url, init),
      );

      // Cache the source-page lookup across chunks of the same page so
      //  a 50-chunk page doesn't pay 50 disk reads. The map is per-tick
      //  scope only; SearchIndex.getPageContent already hits an in-memory
      //  SQLite row, but we still avoid the redundant prepared-statement
      //  call for clarity.
      const sourceCache = new Map<string, string>();
      let processed = 0;
      for (const chunk of missing) {
        let sourcePage = sourceCache.get(chunk.path);
        if (sourcePage === undefined) {
          sourcePage = this.searchIndex.getPageContent(chunk.path) ?? "";
          sourceCache.set(chunk.path, sourcePage);
        }

        let context = "";
        try {
          context = await generateChunkContext(this.provider, ctx, {
            sourcePage,
            chunkText: chunk.content,
            model: this.model,
          });
        } catch (err) {
          // generateChunkContext is documented as never-throws, but
          //  belt-and-braces — surface to onError without letting one
          //  bad chunk halt the rest of the batch.
          this.onError?.(err instanceof Error ? err : new Error(String(err)));
          context = "";
        }

        // Empty context → leave the chunk uncontextualised for the
        //  next tick. We don't persist a NULL marker because the
        //  IS NULL backlog query is the canonical "missing" signal.
        if (context.length > 0) {
          this.searchIndex.storeChunkContext(chunk.path, chunk.chunkIdx, context, this.model);
          processed++;
        }
      }

      const remaining = this.searchIndex.countChunksMissingContexts();
      this.onBatch?.(processed, remaining);
      return { processed, remaining, model: this.model };
    } finally {
      this.inFlight = false;
    }
  }
}
