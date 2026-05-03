import { Hono } from "hono";
import type { ContextualizationWorker } from "./contextualization-worker.js";
import type { EmbeddingWorker } from "./embedding-worker.js";
import type { EmbeddingProvider } from "./providers/embedding-types.js";
import type { Provider } from "./providers/types.js";
import type { SearchIndex } from "./search-index.js";

/**
 * Phase-11 embedding-backfill API — one per project. Mounted only
 * when an embedding provider is registered; routes return 503
 * otherwise so the Settings UI can render a "connect a provider"
 * affordance instead of hiding the section silently.
 *
 * Endpoints:
 *   GET  /status                 — embedding + contextualization stats
 *   POST /backfill               — manual embedding tick
 *   POST /contextualize/backfill — manual contextualization tick
 *
 * The two workers run independently on their own 30 s timers; the
 * kick endpoints just accelerate a drain the user is actively
 * watching. Contextual-retrieval block of the status response is
 * present whenever a chat provider is configured, embedding block
 * whenever an embedding provider is configured — they're orthogonal.
 */
export interface EmbeddingsApiOptions {
  searchIndex: SearchIndex;
  /** Nullable so the caller can mount the same router regardless of
   *  provider configuration; absent → every route returns 503. */
  provider: EmbeddingProvider | null;
  /** Nullable for the same reason as `provider`. */
  worker: EmbeddingWorker | null;
  /** Chat provider used by Contextual Retrieval. Nullable so the
   *  same router shape covers AI-off / embedding-only / full-CR
   *  configurations without adding a separate router. */
  chatProvider?: Provider | null;
  /** Contextualization tick worker — null when no chat provider. */
  contextualizationWorker?: ContextualizationWorker | null;
}

export function createEmbeddingsApi(opts: EmbeddingsApiOptions): Hono {
  const api = new Hono();

  api.get("/status", (c) => {
    if (!opts.provider) {
      return c.json({ ok: false, error: "No embedding provider configured" }, 503);
    }
    const total = opts.searchIndex.countChunksTotal();
    const missing = opts.searchIndex.countChunksMissingEmbeddings();
    const mismatched = opts.searchIndex.countChunksWithMismatchedModel(opts.provider.model);

    // Contextual-retrieval block — present only when a chat provider
    //  is wired up. Surfaces a "N chunks waiting context" counter on
    //  Settings → Storage so users can watch the backlog drain.
    const contextualization = opts.chatProvider
      ? {
          total,
          contextualized: opts.searchIndex.countChunksWithContexts(),
          missing: opts.searchIndex.countChunksMissingContexts(),
          running: opts.contextualizationWorker != null,
        }
      : null;

    return c.json({
      ok: true,
      total,
      embedded: total - missing,
      missing,
      /** Non-zero when the user swapped models without clearing the
       *  vector table — old rows stay queryable only if their dims
       *  match the new model, so the UI surfaces this as "stale
       *  embeddings, reindex recommended". */
      mismatched,
      model: opts.provider.model,
      dims: opts.provider.dimensions,
      running: opts.worker !== null,
      contextualization,
    });
  });

  api.post("/backfill", async (c) => {
    if (!opts.worker) {
      return c.json({ ok: false, error: "No embedding provider configured" }, 503);
    }
    const result = await opts.worker.tick();
    return c.json({ ok: true, ...result });
  });

  api.post("/contextualize/backfill", async (c) => {
    if (!opts.contextualizationWorker) {
      return c.json({ ok: false, error: "No chat provider configured" }, 503);
    }
    const result = await opts.contextualizationWorker.tick();
    return c.json({ ok: true, ...result });
  });

  return api;
}
