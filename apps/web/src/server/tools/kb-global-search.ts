import type { SearchIndex } from "../search-index.js";
import type { ToolCallContext, ToolImplementation } from "./types.js";

/**
 * `kb.global_search` — Phase-11 Airlock cross-project search.
 *
 * Fans out a BM25 query across every registered `SearchIndex`
 * other than the caller's, returns merged hits tagged with
 * `projectId`, and **downgrades the run's egress to offline** the
 * moment any result row leaves a foreign project. Subsequent
 * `fetchForProject` calls in the same run throw
 * `EgressDowngradedError`.
 *
 * Per docs/05-jobs-and-security.md §Threat-model boundaries:
 * cross-project agent search is the one capability the 1.0 trust
 * model deliberately omits. Airlock unlocks it but pays for it
 * with dynamic egress lockdown — a malicious page in project B,
 * once read into the agent's context, cannot exfiltrate via any
 * future tool / provider call.
 *
 * The downgrade is one-way per run. Caller-project hits do *not*
 * trigger a downgrade (the agent could already see those via
 * `kb.search`); only foreign-project rows do.
 *
 * Gated on `IRONLORE_AIRLOCK=true` at the install level. The
 * dispatcher only registers this tool when the env is set, so a
 * single-user install never sees it on the agent's palette.
 */

interface GlobalSearchResult {
  path: string;
  title: string;
  snippet: string;
  rank: number;
  /** Source project of the hit. Always present, including for
   *  the caller's own project (so the model can tell own / foreign
   *  apart in the output). */
  projectId: string;
}

export interface KbGlobalSearchOptions {
  /** Snapshot of every registered project's `SearchIndex`,
   *  keyed by `projectId`. Should be a closure over the live
   *  registry so projects added at runtime are visible. */
  getAllProjectIndexes: () => Map<string, SearchIndex>;
}

export function createKbGlobalSearch(opts: KbGlobalSearchOptions): ToolImplementation {
  return {
    definition: {
      name: "kb.global_search",
      description:
        "Search every project on this install. Returns hits tagged with `projectId`. " +
        "READ-ONLY + ONE-WAY: the moment any cross-project hit is returned, the run's " +
        "egress drops to offline for the rest of the conversation — no further " +
        "outbound network calls will be permitted (provider calls + connector tools " +
        "throw `EgressDowngradedError`). Use `kb.search` for the calling project " +
        "alone; this tool is for retrospective queries that genuinely need to span projects.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "BM25 search query." },
          limit: {
            type: "number",
            description: "Max results across all projects (default 20).",
          },
          /**
           * Optional opt-out: when true, the caller acknowledges
           * the lockdown is about to fire and is OK with it. The
           * tool still runs without this flag, but emits a
           * stronger warning event so a hesitant agent can decide
           * to abort instead.
           */
          acknowledge_lockdown: {
            type: "boolean",
            description:
              "Set true when you understand the run will lose network access after this call.",
          },
        },
        required: ["query"],
      },
    },
    async execute(args: unknown, ctx: ToolCallContext): Promise<string> {
      const input =
        (args as {
          query?: string;
          limit?: number;
          acknowledge_lockdown?: boolean;
        }) ?? {};
      const query = typeof input.query === "string" ? input.query : "";
      const limit = typeof input.limit === "number" && input.limit > 0 ? input.limit : 20;
      if (!query.trim()) {
        return JSON.stringify({ count: 0, results: [], note: "Empty query." });
      }

      const all = opts.getAllProjectIndexes();
      const K = 60; // RRF — same constant the per-project + scope=all paths use
      const merged = new Map<string, { score: number; result: GlobalSearchResult }>();
      let foreignHits = 0;

      for (const [pid, idx] of all) {
        let projectResults: ReturnType<SearchIndex["search"]>;
        try {
          projectResults = idx.search(query, limit * 2);
        } catch {
          // Defensive — a project whose FTS5 is corrupt should
          // not poison the whole fan-out. Mirrors the
          // search-api `?scope=all` behaviour.
          continue;
        }
        for (let i = 0; i < projectResults.length; i++) {
          const r = projectResults[i];
          if (!r) continue;
          if (pid !== ctx.projectId) foreignHits++;
          const key = `${pid}:${r.path}`;
          const rrfScore = 1 / (K + i + 1);
          merged.set(key, {
            score: rrfScore,
            result: { ...r, projectId: pid },
          });
        }
      }

      const results = [...merged.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((e) => e.result);

      const crossedHits = results.some((r) => r.projectId !== ctx.projectId);

      // Downgrade fires on cross-project hits **in the returned
      // slice**, not the candidate pool. A query that finds 100
      // foreign rows but only top-K caller-project rows survive
      // RRF doesn't downgrade — the model never saw the foreign
      // content. This is the documented "event horizon": once a
      // foreign block enters the transcript, fetch is dead.
      if (crossedHits && ctx.downgradeEgress) {
        ctx.downgradeEgress(
          input.acknowledge_lockdown
            ? "kb.global_search returned cross-project hits (acknowledged)"
            : "kb.global_search returned cross-project hits",
        );
      }

      return JSON.stringify({
        count: results.length,
        results,
        crossedProjects: crossedHits,
        // Surface the foreign-row count even when none survived
        // RRF — useful for the agent to decide whether to refine
        // the query before triggering the lockdown.
        foreignCandidates: foreignHits,
      });
    },
  };
}
