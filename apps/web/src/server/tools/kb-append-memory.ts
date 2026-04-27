import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolCallContext, ToolImplementation } from "./types.js";

/**
 * `kb.append_memory` — Phase-11 cognitive-offloading tool.
 *
 * Appends a fact, preference, or observation to a named memory
 * file under `.agents/<slug>/memory/<topic>.md`. The file is plain
 * markdown the user can read, edit, audit, or delete (Principle 5b
 * — agents carry no in-process memory between runs; memory lives
 * on the filesystem).
 *
 * Distinct from `agent.journal`:
 *   - `agent.journal` writes a *narrated run summary* to `home.md`,
 *     under a `## Journal` section. One entry per run. Finalizes
 *     autonomous runs.
 *   - `kb.append_memory` writes a *single fact* to a topic-named
 *     file (e.g. `preferences.md`, `decisions.md`, `facts.md`).
 *     Many entries per run. Doesn't finalize anything.
 *
 * Hydration: every file under `.agents/<slug>/memory/` (except
 * `home.md`, which is the journal log) is loaded into the
 * executor's system prompt at run start. Anything appended via
 * this tool surfaces in the next run's context automatically.
 * See [executor.ts §loadAgentMemory](../agents/executor.ts).
 *
 * Append-only: the tool never reads the file back to the model
 * and never overwrites existing entries. Edits to memory require
 * the user to open the markdown file directly — that's the
 * "filesystem is the contract" property.
 */

/** Ceiling per memory file. ~500 entries at typical bullet length;
 *  prevents one runaway agent from filling the disk. */
const MAX_FILE_BYTES = 64 * 1024;

/** Cap per appended entry. Keeps single facts terse. */
const MAX_FACT_LENGTH = 1000;

/** Topic must be a flat slug — no path traversal, no nested dirs.
 *  The pattern matches the same shape onboarding uses for slugs. */
const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function createKbAppendMemory(): ToolImplementation {
  return {
    definition: {
      name: "kb.append_memory",
      description:
        "Append a single fact, user preference, or observation to your agent " +
        "memory at `.agents/<your-slug>/memory/<topic>.md`. " +
        "Use lowercase-hyphen topic names like `preferences`, `decisions`, " +
        "`facts`, `user-context`. Each call appends one bullet under a " +
        "`## Memory` heading with an ISO timestamp. " +
        "These files are auto-hydrated into your context on every future " +
        "run — anything you write here surfaces in your next conversation. " +
        "Use this for things you'd want to remember next week; use " +
        "`agent.journal` for narrated run summaries.",
      inputSchema: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description:
              "Flat lowercase-hyphen slug, max 40 chars. Examples: `preferences`, `decisions`, `user-context`. Must match `^[a-z0-9][a-z0-9-]{0,40}$`. No paths.",
          },
          fact: {
            type: "string",
            description:
              "The single fact / preference / observation to append. One sentence. Max 1000 chars.",
          },
        },
        required: ["topic", "fact"],
      },
    },
    async execute(args: unknown, ctx: ToolCallContext): Promise<string> {
      const { topic, fact } = (args as { topic?: unknown; fact?: unknown }) ?? {};
      if (typeof topic !== "string" || !TOPIC_RE.test(topic)) {
        return JSON.stringify({
          error:
            "topic must be a lowercase-hyphen slug (e.g. 'preferences', 'user-context'); 1-41 chars; no paths",
        });
      }
      if (typeof fact !== "string" || fact.trim().length === 0) {
        return JSON.stringify({ error: "fact required (non-empty string)" });
      }
      // Truncate rather than reject — the agent's payload is upstream-
      // provided and a wall-of-text shouldn't crash the run.
      const trimmed = fact.trim().slice(0, MAX_FACT_LENGTH);

      const memoryPath = join(ctx.dataRoot, ".agents", ctx.agentSlug, "memory", `${topic}.md`);
      mkdirSync(dirname(memoryPath), { recursive: true });

      const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
      const newEntry = `- \`${timestamp}\` — ${trimmed}\n`;

      let content: string;
      if (existsSync(memoryPath)) {
        content = readFileSync(memoryPath, "utf-8");
      } else {
        content = `# ${ctx.agentSlug} — ${topic}\n\n## Memory\n\n`;
      }
      content += newEntry;

      // Disk-safety cap. Drop oldest entries until under the limit
      // — keeps recent context fresh, evicts stale.
      if (Buffer.byteLength(content, "utf-8") > MAX_FILE_BYTES) {
        const headerEnd = content.indexOf("## Memory");
        const headerBlock = headerEnd >= 0 ? content.slice(0, headerEnd + "## Memory\n\n".length) : "";
        const body = content.slice(headerBlock.length);
        const lines = body.split("\n");
        // Drop oldest entries (top of body) until under cap. Each
        // bullet is one line; preserve trailing newline.
        let dropped = 0;
        while (Buffer.byteLength(headerBlock + lines.join("\n"), "utf-8") > MAX_FILE_BYTES) {
          if (lines.length <= 1) break;
          lines.shift();
          dropped++;
        }
        content = headerBlock + lines.join("\n");
        if (dropped > 0) {
          // Stamp the eviction so a later reader sees the gap.
          content = headerBlock + `<!-- evicted ${dropped} oldest entries -->\n` + lines.join("\n");
        }
      }

      writeFileSync(memoryPath, content, "utf-8");

      // Lightweight event so the audit trail records every memory
      // append (auditability is the principle 5b property).
      ctx.emitEvent("memory.append", { topic, length: trimmed.length });

      return JSON.stringify({ ok: true, path: memoryPath, topic, bytes: trimmed.length });
    },
  };
}
