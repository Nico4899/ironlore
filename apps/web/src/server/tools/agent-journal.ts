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

export function createAgentJournal(dataRoot: string): ToolImplementation {
  return {
    definition: {
      name: "agent.journal",
      description:
        "Append a narrated summary of what you did in this run. This is the human-readable " +
        "log entry for this execution. For autonomous runs, this call finalizes the run.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The journal entry — prose summary of this run" },
        },
        required: ["text"],
      },
    },
    async execute(args: unknown, ctx: ToolCallContext): Promise<string> {
      const { text } = args as { text: string };

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
          const beforeJournal = content.slice(0, content.indexOf(journalHeader) + journalHeader.length);
          const kept = content.slice(keepFrom.index);
          content = beforeJournal + kept;
        }
      }

      writeFileSync(homePath, content, "utf-8");

      // Signal the run finalization via the event stream. The executor
      // reads this event to know the autonomous run is done.
      ctx.emitEvent("agent.journal", { text, timestamp });

      return JSON.stringify({ ok: true, path: homePath });
    },
  };
}
