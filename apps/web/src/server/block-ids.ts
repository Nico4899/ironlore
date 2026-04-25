import { readFileSync, writeFileSync } from "node:fs";
import { type Block, type BlocksIndex, parseBlocks } from "@ironlore/core";

export type { Block, BlocksIndex } from "@ironlore/core";
export { parseBlocks } from "@ironlore/core";

const BLOCK_ID_RE = /<!-- #blk_([A-Z0-9]{26}) -->/;

/**
 * Inject block IDs into markdown. Only adds IDs to blocks that don't
 * already have one. Existing IDs are preserved.
 *
 * Returns the annotated markdown and the block index.
 */
export function assignBlockIds(markdown: string): {
  markdown: string;
  blocks: Block[];
} {
  const blocks = parseBlocks(markdown);
  const lines = markdown.split("\n");
  const result: string[] = [];

  let lineIdx = 0;
  let blockIdx = 0;

  while (lineIdx < lines.length) {
    const line = lines[lineIdx] ?? "";

    const block = blocks[blockIdx];
    if (block && lineOffsetMatches(lines, lineIdx, block.startOffset)) {
      const blockEndLine = findLineAtOffset(lines, block.endOffset);

      for (let j = lineIdx; j <= blockEndLine; j++) {
        result.push(lines[j] ?? "");
      }

      const lastLineIdx = result.length - 1;
      const lastLine = result[lastLineIdx] ?? "";
      if (!BLOCK_ID_RE.test(lastLine)) {
        result[lastLineIdx] = `${lastLine} <!-- #${block.id} -->`;
      }

      lineIdx = blockEndLine + 1;
      blockIdx++;
    } else {
      result.push(line);
      lineIdx++;
    }
  }

  return { markdown: result.join("\n"), blocks };
}

function lineOffsetMatches(lines: string[], lineIdx: number, targetOffset: number): boolean {
  let offset = 0;
  for (let i = 0; i < lineIdx; i++) {
    offset += (lines[i] ?? "").length + 1;
  }
  return offset === targetOffset;
}

function findLineAtOffset(lines: string[], targetOffset: number): number {
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineEnd = offset + (lines[i] ?? "").length;
    if (lineEnd >= targetOffset) return i;
    offset += (lines[i] ?? "").length + 1;
  }
  return lines.length - 1;
}

/**
 * Per-block provenance metadata threaded through `kb.replace_block` /
 * `kb.insert_after` / `kb.create_page` from `ToolCallContext`. Keys are
 * block IDs (with the `blk_` prefix); values are the fields that get
 * stamped into `BlocksIndex.blocks[].(derived_from|agent|compiled_at)`.
 *
 * Callers only populate entries for the **new** block IDs they
 * authored; the writer merges these over any pre-existing sidecar so
 * untouched blocks keep their prior provenance across edits.
 */
export type BlockProvenance = {
  derived_from?: string[];
  agent?: string;
  compiled_at?: string;
};

/**
 * Write the .blocks.json sidecar for a page.
 *
 * The sidecar is placed alongside the markdown file. For directory pages
 * (e.g., getting-started/index.md), it goes in the same directory.
 *
 * Provenance merge: when `provenanceByBlockId` is supplied, the writer
 * reads any existing sidecar at this path, copies its provenance fields
 * forward by block ID, then layers the new provenance on top. A block
 * whose ID survived the edit keeps its prior `derived_from` / `agent` /
 * `compiled_at` unless the caller explicitly re-stamps it. A new block
 * picks up exactly the provenance the caller supplied.
 */
export function writeBlocksSidecar(
  pagePath: string,
  blocks: Block[],
  provenanceByBlockId?: ReadonlyMap<string, BlockProvenance>,
): void {
  const sidecarPath = pagePath.replace(/\.md$/, ".blocks.json");
  const existing = readBlocksSidecar(pagePath);
  const carryForward = new Map<string, BlockProvenance>();
  if (existing) {
    for (const b of existing.blocks) {
      if (b.derived_from || b.agent || b.compiled_at) {
        carryForward.set(b.id, {
          ...(b.derived_from !== undefined ? { derived_from: b.derived_from } : {}),
          ...(b.agent !== undefined ? { agent: b.agent } : {}),
          ...(b.compiled_at !== undefined ? { compiled_at: b.compiled_at } : {}),
        });
      }
    }
  }

  const index: BlocksIndex = {
    version: 1,
    blocks: blocks.map((b) => {
      const merged: BlockProvenance = {
        ...(carryForward.get(b.id) ?? {}),
        ...(provenanceByBlockId?.get(b.id) ?? {}),
      };
      return {
        id: b.id,
        type: b.type,
        start: b.startOffset,
        end: b.endOffset,
        ...(merged.derived_from !== undefined ? { derived_from: merged.derived_from } : {}),
        ...(merged.agent !== undefined ? { agent: merged.agent } : {}),
        ...(merged.compiled_at !== undefined ? { compiled_at: merged.compiled_at } : {}),
      };
    }),
  };
  writeFileSync(sidecarPath, JSON.stringify(index, null, 2), "utf-8");
}

/**
 * Read a .blocks.json sidecar if it exists.
 */
export function readBlocksSidecar(pagePath: string): BlocksIndex | null {
  const sidecarPath = pagePath.replace(/\.md$/, ".blocks.json");
  try {
    const raw = readFileSync(sidecarPath, "utf-8");
    return JSON.parse(raw) as BlocksIndex;
  } catch {
    return null;
  }
}
