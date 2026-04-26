import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolCallContext, ToolImplementation } from "./types.js";

/**
 * agent.journal — append a narrated run summary to the agent's home
 * page. For autonomous jobs, emitting `agent.journal` is the signal
 * that finalizes the run.
 *
 * The home page lives at `data/.agents/<slug>/memory/home.md`. Each
 * journal entry is appended under a `## Journal` section with a
 * timestamp. The page is capped at ~20 entries per section via FIFO
 * eviction (the evicted content stays in `decisions.jsonl` sidecar).
 *
 * See docs/04-ai-and-agents.md §Agent memory.
 */

const MAX_JOURNAL_ENTRIES = 20;

/**
 * Optional structured payload an agent can attach to its journal
 * call to surface a lint report through the `lint:findings`
 * WebSocket event. Only the wiki-gardener's `lint.md` skill
 * populates this today; generic runs leave the field absent and
 * no event fires (so we don't false-banner every agent.run).
 *
 * Shape mirrors `LintFindingsEvent` in
 * `packages/core/src/ws-events.ts` minus the seq/agent/runId
 * fields which the executor stamps.
 */
export interface JournalLintReport {
  reportPath: string;
  counts: {
    orphans: number;
    stale: number;
    contradictions: number;
    coverageGaps: number;
    provenanceGaps: number;
  };
}

export function createAgentJournal(dataRoot: string): ToolImplementation {
  return {
    definition: {
      name: "agent.journal",
      description:
        "Append a narrated summary of what you did in this run. This is the human-readable " +
        "log entry for this execution. For autonomous runs, this call finalizes the run.\n\n" +
        "Lint workflow only: pass `lintReport: { reportPath, counts }` to surface a " +
        "dismissible banner in the user's UI. Generic runs leave this absent.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The journal entry — prose summary of this run" },
          lintReport: {
            type: "object",
            description:
              "Optional. Wiki-gardener-style lint runs supply this to fire a `lint:findings` UI banner. Omit otherwise.",
            properties: {
              reportPath: {
                type: "string",
                description: "Path of the report page, relative to data/ (e.g. _maintenance/lint-2026-04-26.md).",
              },
              counts: {
                type: "object",
                description: "Per-check counts. Each field defaults to 0.",
                properties: {
                  orphans: { type: "number" },
                  stale: { type: "number" },
                  contradictions: { type: "number" },
                  coverageGaps: { type: "number" },
                  provenanceGaps: { type: "number" },
                },
              },
            },
            required: ["reportPath", "counts"],
          },
        },
        required: ["text"],
      },
    },
    async execute(args: unknown, ctx: ToolCallContext): Promise<string> {
      const { text, lintReport } = args as { text: string; lintReport?: JournalLintReport };

      const homePath = join(dataRoot, ".agents", ctx.agentSlug, "memory", "home.md");
      const homeDir = dirname(homePath);
      mkdirSync(homeDir, { recursive: true });

      const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
      const entry = `\n### ${timestamp}\n\n${text}\n`;

      let content: string;
      if (existsSync(homePath)) {
        content = readFileSync(homePath, "utf-8");
      } else {
        content = `# ${ctx.agentSlug} — Memory\n\n## Journal\n`;
      }

      // Append the new entry under ## Journal.
      const journalHeader = "## Journal";
      const headerIdx = content.indexOf(journalHeader);
      if (headerIdx === -1) {
        content += `\n${journalHeader}\n${entry}`;
      } else {
        const insertAt = headerIdx + journalHeader.length;
        content = content.slice(0, insertAt) + entry + content.slice(insertAt);
      }

      // FIFO eviction: keep only the last N entries.
      const entryPattern = /\n### \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\n/g;
      const matches = [...content.matchAll(entryPattern)];
      if (matches.length > MAX_JOURNAL_ENTRIES) {
        const keepFrom = matches[matches.length - MAX_JOURNAL_ENTRIES];
        if (keepFrom?.index !== undefined) {
          const beforeJournal = content.slice(
            0,
            content.indexOf(journalHeader) + journalHeader.length,
          );
          const kept = content.slice(keepFrom.index);
          content = beforeJournal + kept;
        }
      }

      writeFileSync(homePath, content, "utf-8");

      // Signal the run finalization via the event stream. The executor
      // reads this event to know the autonomous run is done. When
      // `lintReport` is present, the executor will also emit a
      // `lint:findings` WS event so the UI surfaces the report.
      const eventPayload: { text: string; timestamp: string; lintReport?: JournalLintReport } = {
        text,
        timestamp,
      };
      if (lintReport && typeof lintReport.reportPath === "string" && lintReport.counts) {
        // Defensive: coerce missing count fields to 0 so the WS
        // event payload always satisfies LintFindingsEvent's
        // shape regardless of which checks the agent ran.
        eventPayload.lintReport = {
          reportPath: lintReport.reportPath,
          counts: {
            orphans: numberOr0(lintReport.counts.orphans),
            stale: numberOr0(lintReport.counts.stale),
            contradictions: numberOr0(lintReport.counts.contradictions),
            coverageGaps: numberOr0(lintReport.counts.coverageGaps),
            provenanceGaps: numberOr0(lintReport.counts.provenanceGaps),
          },
        };
      }
      ctx.emitEvent("agent.journal", eventPayload);

      return JSON.stringify({ ok: true, path: homePath });
    },
  };
}

function numberOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}
