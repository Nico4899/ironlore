import { Hono } from "hono";
import type { EmbeddingWorker } from "./embedding-worker.js";
import type { EmbeddingProvider } from "./providers/embedding-types.js";
import type { SearchIndex } from "./search-index.js";

/**
 * Phase-11 embedding-backfill API — one per project. Mounted only
 * when an embedding provider is registered; routes return 503
 * otherwise so the Settings UI can render a "connect a provider"
 * affordance instead of hiding the section silently.
 *
 * Endpoints:
 *   GET  /status    — { total, embedded, missing, model, dims, mismatched, running }
 *   POST /backfill  — manual tick; returns { processed, remaining, model }.
 *                     Call repeatedly until `remaining === 0` to drain
 *                     the backlog synchronously from the UI or CLI.
 *
 * The worker's own interval (default 30 s) continues running in the
 * background; the kick endpoint just accelerates a drain the user is
 * actively watching.
 */
export interface EmbeddingsApiOptions {
  searchIndex: SearchIndex;
  /** Nullable so the caller can mount the same router regardless of
   *  provider configuration; absent → every route returns 503. */
  provider: EmbeddingProvider | null;
  /** Nullable for the same reason as `provider`. */
  worker: EmbeddingWorker | null;
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
    });
  });

  api.post("/backfill", async (c) => {
    if (!opts.worker) {
      return c.json({ ok: false, error: "No embedding provider configured" }, 503);
    }
    const result = await opts.worker.tick();
    return c.json({ ok: true, ...result });
  });

  return api;
}
