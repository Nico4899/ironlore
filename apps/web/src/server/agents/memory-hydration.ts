import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Memory hydration — Phase-11 cognitive-offloading mechanism.
 *
 * Reads every markdown file under `<dataRoot>/.agents/<slug>/memory/`
 * (except `home.md`, the journal log) and concatenates them into a
 * single block prepended to the agent's system prompt at run
 * start. This is the mechanism that makes Principle 5b's "agents
 * carry no in-process memory between runs" *actually* work — the
 * filesystem is the memory; the executor hydrates it on every
 * run.
 *
 * Caps:
 *   - Per-file: `MAX_FILE_BYTES` (default 16 KB). A single runaway
 *     file can't dominate the context window.
 *   - Total: `MAX_TOTAL_BYTES` (default 32 KB). When summed file
 *     sizes exceed this, the helper truncates the trailing tail
 *     (oldest files alphabetically) with a `[…]` marker so the
 *     executor's prompt budget stays predictable.
 *
 * `home.md` is excluded by design — it's the journal log written
 * by `agent.journal`, can grow very large, and the agent already
 * knows to consult its own journal via `kb.read_page` when
 * needed. Topic files (`preferences.md`, `decisions.md`, etc.)
 * are the canonical "things you'd want to remember next run"
 * surface.
 */

const MAX_FILE_BYTES = 16 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024;
const TRUNCATION_MARKER = "\n\n[…truncated for context budget]";

/**
 * Load every memory file for an agent, concatenated into a single
 * block ready to prepend to the system prompt. Returns null when
 * the agent has no memory dir or every file is empty — callers
 * should treat null as "no memory block to add."
 *
 * Block shape:
 *
 *     # Agent memory
 *
 *     ## preferences
 *     <body of preferences.md>
 *
 *     ## decisions
 *     <body of decisions.md>
 *
 *     ...
 *
 * The two-level heading structure matches the agent.journal
 * memory-page convention so a hydrated prompt reads like the
 * agent is browsing its own filesystem.
 */
export function loadAgentMemory(dataRoot: string, agentSlug: string): string | null {
  const memoryDir = join(dataRoot, ".agents", agentSlug, "memory");
  if (!existsSync(memoryDir)) return null;

  let entries: string[];
  try {
    entries = readdirSync(memoryDir);
  } catch {
    return null;
  }

  // Sort alphabetically so the same memory files always hydrate
  // in the same order — keeps prompt-cache hashes stable across
  // runs that didn't touch memory.
  const topicFiles = entries
    .filter((name) => name.endsWith(".md") && name !== "home.md")
    .sort();
  if (topicFiles.length === 0) return null;

  const sections: string[] = [];
  let runningTotal = 0;
  let truncated = false;

  for (const fileName of topicFiles) {
    const topic = fileName.replace(/\.md$/, "");
    let body: string;
    try {
      body = readFileSync(join(memoryDir, fileName), "utf-8");
    } catch {
      continue;
    }
    // Strip the file's own `# <slug> — <topic>` header — the
    // hydrated block has its own heading hierarchy, and double-
    // headers confuse the model.
    const stripped = body.replace(/^# [^\n]*\n+/, "").trim();
    if (stripped.length === 0) continue;

    // Per-file cap.
    const trimmed =
      Buffer.byteLength(stripped, "utf-8") > MAX_FILE_BYTES
        ? stripped.slice(0, MAX_FILE_BYTES) + TRUNCATION_MARKER
        : stripped;

    const section = `## ${topic}\n\n${trimmed}\n`;
    const sectionBytes = Buffer.byteLength(section, "utf-8");

    if (runningTotal + sectionBytes > MAX_TOTAL_BYTES) {
      truncated = true;
      break;
    }
    sections.push(section);
    runningTotal += sectionBytes;
  }

  if (sections.length === 0) return null;

  const trailer = truncated ? `\n[…older memory topics omitted for context budget]\n` : "";
  return `# Agent memory\n\n${sections.join("\n")}${trailer}`;
}
