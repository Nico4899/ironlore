import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKbAppendMemory } from "./kb-append-memory.js";
import type { ToolCallContext } from "./types.js";

/**
 * `kb.append_memory` — Phase-11 cognitive-offloading tool.
 *
 * Pinning behaviours:
 *   1. New file is created with the standard header + first entry.
 *   2. Existing file is appended (not overwritten).
 *   3. Topic name validation rejects path-traversal attempts +
 *      enforces the lowercase-hyphen-slug shape (defense-in-depth
 *      on top of the kb-tool dispatcher's own input validation).
 *   4. Per-entry truncation at 1000 chars + per-file FIFO
 *      eviction at 64KB so a runaway agent can't fill the disk
 *      or blow the context budget on hydration.
 *   5. memory.append event fires on every successful write —
 *      auditability is the Principle 5b property.
 */

let dataRoot: string;
const events: Array<{ kind: string; data: unknown }> = [];

const ctx = (): ToolCallContext => ({
  projectId: "main",
  agentSlug: "general",
  jobId: "test-job",
  emitEvent: (kind, data) => events.push({ kind, data }),
  dataRoot,
  fetch: globalThis.fetch,
});

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "append-memory-"));
  events.length = 0;
});
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

describe("kb.append_memory", () => {
  it("creates a new memory file with the standard header + first entry", async () => {
    const tool = createKbAppendMemory();
    const out = JSON.parse(
      await tool.execute({ topic: "preferences", fact: "user prefers ISO dates" }, ctx()),
    ) as { ok?: boolean; path?: string; error?: string };
    expect(out.ok).toBe(true);

    const memoryPath = join(dataRoot, ".agents", "general", "memory", "preferences.md");
    const content = readFileSync(memoryPath, "utf-8");
    expect(content).toContain("# general — preferences");
    expect(content).toContain("## Memory");
    expect(content).toMatch(/`\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}` — user prefers ISO dates/);
  });

  it("appends to an existing file rather than overwriting", async () => {
    const tool = createKbAppendMemory();
    await tool.execute({ topic: "facts", fact: "first fact" }, ctx());
    await tool.execute({ topic: "facts", fact: "second fact" }, ctx());
    await tool.execute({ topic: "facts", fact: "third fact" }, ctx());

    const memoryPath = join(dataRoot, ".agents", "general", "memory", "facts.md");
    const content = readFileSync(memoryPath, "utf-8");
    expect(content).toContain("first fact");
    expect(content).toContain("second fact");
    expect(content).toContain("third fact");
    // Header should appear exactly once — appends don't duplicate it.
    expect(content.match(/## Memory/g)?.length).toBe(1);
  });

  it("rejects topic names that try path traversal", async () => {
    const tool = createKbAppendMemory();
    const traversals = ["../escape", "memory/../../etc", "/abs/path", "with/slash"];
    for (const topic of traversals) {
      const out = JSON.parse(await tool.execute({ topic, fact: "x" }, ctx())) as {
        error?: string;
      };
      expect(out.error).toMatch(/lowercase-hyphen slug/);
    }
  });

  it("rejects topic names with uppercase or special chars", async () => {
    const tool = createKbAppendMemory();
    const bad = ["Preferences", "user.context", "user_context", "topic with space", ""];
    for (const topic of bad) {
      const out = JSON.parse(await tool.execute({ topic, fact: "x" }, ctx())) as {
        error?: string;
      };
      expect(out.error).toMatch(/lowercase-hyphen slug/);
    }
  });

  it("rejects an empty fact", async () => {
    const tool = createKbAppendMemory();
    const out = JSON.parse(await tool.execute({ topic: "facts", fact: "  " }, ctx())) as {
      error?: string;
    };
    expect(out.error).toMatch(/non-empty/);
  });

  it("truncates a single fact at 1000 chars rather than rejecting", async () => {
    // The agent's input is upstream-provided; a wall-of-text
    // shouldn't crash the run. Truncate quietly + keep going.
    const tool = createKbAppendMemory();
    const longFact = "X".repeat(2000);
    await tool.execute({ topic: "verbose", fact: longFact }, ctx());

    const content = readFileSync(
      join(dataRoot, ".agents", "general", "memory", "verbose.md"),
      "utf-8",
    );
    // The bullet body is the truncated 1000 chars (not 2000).
    const match = /— (X+)/.exec(content);
    expect(match?.[1]?.length).toBe(1000);
  });

  it("evicts oldest entries when the file would exceed 64KB", async () => {
    // Pre-populate close to the cap so a single append triggers
    // FIFO eviction. Each bullet is ~30 chars header + content;
    // ~63KB of bullets is enough to push past the cap with one
    // more append.
    const memoryDir = join(dataRoot, ".agents", "general", "memory");
    mkdirSync(memoryDir, { recursive: true });
    const memoryPath = join(memoryDir, "facts.md");
    const header = `# general — facts\n\n## Memory\n\n`;
    const filler = Array.from(
      { length: 2000 },
      (_, i) => `- \`2026-04-01 00:00:00\` — bullet ${i} ${"x".repeat(20)}\n`,
    ).join("");
    writeFileSync(memoryPath, header + filler, "utf-8");

    const tool = createKbAppendMemory();
    await tool.execute({ topic: "facts", fact: "newest fact" }, ctx());

    const content = readFileSync(memoryPath, "utf-8");
    // Final size honors the cap.
    expect(Buffer.byteLength(content, "utf-8")).toBeLessThanOrEqual(64 * 1024);
    // Newest fact survived; oldest got evicted.
    expect(content).toContain("newest fact");
    expect(content).not.toContain("bullet 0 ");
    // Eviction comment was stamped so a reader sees the gap.
    expect(content).toContain("evicted");
  });

  it("emits a memory.append event for the audit trail", async () => {
    const tool = createKbAppendMemory();
    await tool.execute({ topic: "preferences", fact: "wear blue on tuesdays" }, ctx());
    const event = events.find((e) => e.kind === "memory.append");
    expect(event).toBeDefined();
    expect((event?.data as { topic: string }).topic).toBe("preferences");
  });
});
