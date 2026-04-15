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
 * Write the .blocks.json sidecar for a page.
 *
 * The sidecar is placed alongside the markdown file. For directory pages
 * (e.g., getting-started/index.md), it goes in the same directory.
 */
export function writeBlocksSidecar(pagePath: string, blocks: Block[]): void {
  const sidecarPath = pagePath.replace(/\.md$/, ".blocks.json");
  const index: BlocksIndex = {
    version: 1,
    blocks: blocks.map((b) => ({
      id: b.id,
      type: b.type,
      start: b.startOffset,
      end: b.endOffset,
    })),
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
