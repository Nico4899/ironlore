import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { BlocksIndex } from "@ironlore/core";
import { readBlocksSidecar } from "../block-ids.js";
import type { ToolCallContext, ToolImplementation } from "./types.js";

/**
 * kb.lint_provenance_gaps — find agent-authored blocks that
 * shipped without source citations.
 *
 * Backs the §4 "Provenance gaps" section in the Wiki Gardener's
 * `lint.md` workflow skill. The D.2 work (writable-kinds-gate +
 * provenance sidecar) made `.blocks.json` carry per-block
 * `agent`, `derived_from`, and `compiled_at` fields — so a real,
 * rule-based detector exists now. The previous stub note in
 * `seed.ts` is no longer accurate; the lint skill copy is updated
 * alongside this tool.
 *
 * A block is a "gap" iff:
 *   1. `agent` is set (= the block was authored by an agent run,
 *      not by a human edit through `pages-api.ts`), AND
 *   2. `derived_from` is missing or empty (= the agent didn't
 *      cite any source blocks).
 *
 * Returns one row per gap, grouped under the page that holds it.
 * Read-only.
 */

// Exported so the CLI's `lint --check provenance` surface can call
// the same scan without depending on the tool dispatcher.
export interface ProvenanceGap {
  pagePath: string;
  blockId: string;
  agent: string;
  compiledAt: string | null;
}

export function walkSidecars(dataRoot: string): string[] {
  // Recursive walk that picks up every `*.blocks.json` under
  // `dataRoot`, skipping the `.ironlore/` derived-state directory
  // and any agent-internal subtree (`.agents/`) — those exist for
  // the gardener itself and aren't "knowledge" pages.
  const out: string[] = [];
  const stack: string[] = [dataRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue; // .ironlore, .agents, .git
      const full = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(full);
      } else if (entry.endsWith(".blocks.json")) {
        out.push(full);
      }
    }
  }
  return out;
}

export function gapsForSidecar(
  pagePath: string,
  index: BlocksIndex,
  excludeAgents: Set<string>,
): ProvenanceGap[] {
  const gaps: ProvenanceGap[] = [];
  for (const block of index.blocks) {
    if (!block.agent) continue;
    if (excludeAgents.has(block.agent)) continue;
    const cited = block.derived_from && block.derived_from.length > 0;
    if (cited) continue;
    gaps.push({
      pagePath,
      blockId: block.id,
      agent: block.agent,
      compiledAt: block.compiled_at ?? null,
    });
  }
  return gaps;
}

export function createKbLintProvenanceGaps(dataRoot: string): ToolImplementation {
  return {
    definition: {
      name: "kb.lint_provenance_gaps",
      description:
        "Find agent-authored blocks that shipped without `derived_from` source citations. " +
        "Reads the `.blocks.json` sidecars produced by the writable-kinds-gate path " +
        "(`kb.replace_block`, `kb.insert_after`, `kb.create_page`). " +
        "Returns `{ count, gaps: Array<{ pagePath, blockId, agent, compiledAt }> }`. " +
        "Read-only. Call this before composing the 'Provenance gaps' section of a lint report.",
      inputSchema: {
        type: "object",
        properties: {
          excludeAgents: {
            type: "array",
            items: { type: "string" },
            description:
              "Agent slugs to skip (e.g. `['user']` to ignore human edits). " +
              "Defaults to none — the rule already ignores blocks where `agent` is unset.",
          },
        },
      },
    },
    async execute(args: unknown, _ctx: ToolCallContext): Promise<string> {
      const input = (args as { excludeAgents?: unknown }) ?? {};
      const exclude = new Set(
        Array.isArray(input.excludeAgents)
          ? (input.excludeAgents.filter((s): s is string => typeof s === "string") as string[])
          : [],
      );

      const sidecarPaths = walkSidecars(dataRoot);
      const gaps: ProvenanceGap[] = [];
      for (const sidecarPath of sidecarPaths) {
        // The sidecar path mirrors `<page>.blocks.json` next to
        // the page. Recover the page path by stripping `.blocks.json`
        // and converting back to forward slashes for portable output.
        const mdPath = sidecarPath.replace(/\.blocks\.json$/, ".md");
        const relPath = relative(dataRoot, mdPath).split(sep).join("/");
        // `readBlocksSidecar` takes the page path, not the sidecar path.
        const index = readBlocksSidecar(mdPath);
        if (!index) continue;
        gaps.push(...gapsForSidecar(relPath, index, exclude));
      }

      gaps.sort((a, b) => a.pagePath.localeCompare(b.pagePath));
      return JSON.stringify({ count: gaps.length, gaps });
    },
  };
}
