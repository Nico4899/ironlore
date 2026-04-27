import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAgentMemory } from "./memory-hydration.js";

/**
 * `loadAgentMemory` — the executor-side half of the Phase-11
 * cognitive-offloading mechanism. Every kb.append_memory write
 * surfaces in the next run's prompt because of this helper.
 *
 * Pinning behaviours:
 *   1. No memory dir → null (agent runs without a memory block).
 *   2. home.md (the journal) is excluded.
 *   3. Files concatenate alphabetically with `## <topic>` headings.
 *   4. Per-file cap (16KB) truncates with a marker.
 *   5. Total cap (32KB) drops trailing files with a marker.
 *   6. The own-file `# <slug> — <topic>` header is stripped to
 *      avoid double-heading the hydrated block.
 */

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "memory-hydration-"));
});
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

function writeMemory(slug: string, fileName: string, body: string): void {
  const dir = join(dataRoot, ".agents", slug, "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), body, "utf-8");
}

describe("loadAgentMemory", () => {
  it("returns null when the agent has no memory directory", () => {
    expect(loadAgentMemory(dataRoot, "ghost")).toBeNull();
  });

  it("returns null when the memory dir is empty", () => {
    mkdirSync(join(dataRoot, ".agents", "general", "memory"), { recursive: true });
    expect(loadAgentMemory(dataRoot, "general")).toBeNull();
  });

  it("excludes home.md (the agent.journal log)", () => {
    // home.md gets large + isn't useful to dump into the prompt;
    // the agent reads its own journal via kb.read_page when needed.
    writeMemory("general", "home.md", "# general — Memory\n\n## Journal\n\nlots of journal text\n");
    expect(loadAgentMemory(dataRoot, "general")).toBeNull();
  });

  it("concatenates topic files alphabetically with ## <topic> headings", () => {
    writeMemory("general", "preferences.md", "# general — preferences\n\n## Memory\n\n- prefers ISO dates\n");
    writeMemory("general", "decisions.md", "# general — decisions\n\n## Memory\n\n- chose Rust over Go\n");
    writeMemory("general", "facts.md", "# general — facts\n\n## Memory\n\n- the user is left-handed\n");

    const out = loadAgentMemory(dataRoot, "general");
    expect(out).not.toBeNull();
    expect(out).toContain("# Agent memory");
    // Alphabetical: decisions, facts, preferences.
    const decisionsIdx = out?.indexOf("## decisions") ?? -1;
    const factsIdx = out?.indexOf("## facts") ?? -1;
    const preferencesIdx = out?.indexOf("## preferences") ?? -1;
    expect(decisionsIdx).toBeGreaterThan(0);
    expect(factsIdx).toBeGreaterThan(decisionsIdx);
    expect(preferencesIdx).toBeGreaterThan(factsIdx);
  });

  it("strips the per-file `# <slug> — <topic>` header so the hydrated block doesn't double-heading", () => {
    writeMemory(
      "general",
      "facts.md",
      "# general — facts\n\n## Memory\n\n- one fact\n",
    );
    const out = loadAgentMemory(dataRoot, "general");
    // Heading hierarchy: outer `# Agent memory`, inner `## facts`.
    // The file's own `# general — facts` is stripped; if it leaked
    // through we'd see two `# ...` lines with conflicting hierarchy.
    expect(out).toContain("# Agent memory");
    expect(out).toContain("## facts");
    expect(out).not.toContain("# general — facts");
    // Original `## Memory` heading inside the file is preserved —
    // the hydrated block reads like the agent is browsing its own
    // filesystem.
    expect(out).toContain("## Memory");
  });

  it("truncates a single oversized file at 16KB with a marker", () => {
    const huge = `# general — verbose\n\n## Memory\n\n- ${"X".repeat(20_000)}`;
    writeMemory("general", "verbose.md", huge);
    const out = loadAgentMemory(dataRoot, "general");
    expect(out).not.toBeNull();
    expect(out).toContain("[…truncated for context budget]");
    // The hydrated section bytes for `verbose` should be bounded
    // by the per-file cap + section overhead.
    expect(Buffer.byteLength(out ?? "", "utf-8")).toBeLessThan(20_000);
  });

  it("drops trailing files when total exceeds 32KB and stamps a marker", () => {
    // Eight files at ~5KB each = ~40KB total, past the 32KB total
    // cap. Trailing alphabetical files (g, h) should drop.
    for (const ch of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      const body = `# general — ${ch}\n\n## Memory\n\n${"x".repeat(5000)}\n`;
      writeMemory("general", `${ch}.md`, body);
    }
    const out = loadAgentMemory(dataRoot, "general");
    expect(out).not.toBeNull();
    expect(out).toContain("## a");
    expect(out).toContain("## b");
    // Some trailing files dropped — exact cutoff depends on cap
    // arithmetic but `## h` should not appear.
    expect(out).not.toContain("## h");
    expect(out).toContain("[…older memory topics omitted for context budget]");
  });

  it("skips files whose stripped body is empty", () => {
    // A file containing only the header line shouldn't produce
    // a `## <topic>` section in the output.
    writeMemory("general", "stub.md", "# general — stub\n");
    expect(loadAgentMemory(dataRoot, "general")).toBeNull();
  });
});
