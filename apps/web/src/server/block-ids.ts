import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ulid } from "@ironlore/core";

const BLOCK_ID_RE = /<!-- #blk_([A-Z0-9]{26}) -->/;

/**
 * A top-level markdown block and its optional stable ID.
 */
export interface Block {
  id: string;
  type: "heading" | "paragraph" | "list" | "code" | "table" | "blockquote" | "hr" | "html";
  startOffset: number;
  endOffset: number;
  text: string;
}

/**
 * The .blocks.json sidecar format — caches block-id to byte-range mapping.
 * Completely rebuildable from the markdown source; not a source of truth.
 */
export interface BlocksIndex {
  version: 1;
  blocks: Array<{
    id: string;
    type: string;
    start: number;
    end: number;
  }>;
}

/**
 * Parse markdown into top-level blocks and detect existing block IDs.
 *
 * Block detection is line-based (not a full AST parse) — sufficient for
 * identifying top-level structural blocks. Each top-level block gets a
 * stable ULID if it doesn't already have one.
 */
export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.split("\n");
  const blocks: Block[] = [];

  let offset = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const lineStart = offset;

    // Skip blank lines
    if (line.trim() === "") {
      offset += line.length + 1;
      i++;
      continue;
    }

    // Heading
    if (/^#{1,6}\s/.test(line)) {
      const existingId = extractBlockId(line);
      blocks.push({
        id: existingId ?? `blk_${ulid()}`,
        type: "heading",
        startOffset: lineStart,
        endOffset: lineStart + line.length,
        text: line,
      });
      offset += line.length + 1;
      i++;
      continue;
    }

    // Code fence
    if (/^(`{3,}|~{3,})/.test(line)) {
      const fence = line.match(/^(`{3,}|~{3,})/)?.[0] ?? "```";
      let blockText = line;
      offset += line.length + 1;
      i++;

      while (i < lines.length) {
        const fenceLine = lines[i] ?? "";
        blockText += "\n" + fenceLine;
        offset += fenceLine.length + 1;
        i++;
        if (fenceLine.startsWith(fence) && fenceLine.trim() === fence) break;
      }

      const existingId = extractBlockId(blockText);
      blocks.push({
        id: existingId ?? `blk_${ulid()}`,
        type: "code",
        startOffset: lineStart,
        endOffset: offset - 1,
        text: blockText,
      });
      continue;
    }

    // Horizontal rule
    if (/^(---|\*\*\*|___)(\s*)$/.test(line)) {
      const existingId = extractBlockId(line);
      blocks.push({
        id: existingId ?? `blk_${ulid()}`,
        type: "hr",
        startOffset: lineStart,
        endOffset: lineStart + line.length,
        text: line,
      });
      offset += line.length + 1;
      i++;
      continue;
    }

    // Table (starts with |)
    if (line.startsWith("|")) {
      let blockText = line;
      offset += line.length + 1;
      i++;
      while (i < lines.length && (lines[i] ?? "").startsWith("|")) {
        const tableLine = lines[i] ?? "";
        blockText += "\n" + tableLine;
        offset += tableLine.length + 1;
        i++;
      }
      const existingId = extractBlockId(blockText);
      blocks.push({
        id: existingId ?? `blk_${ulid()}`,
        type: "table",
        startOffset: lineStart,
        endOffset: offset - 1,
        text: blockText,
      });
      continue;
    }

    // Blockquote
    if (line.startsWith(">")) {
      let blockText = line;
      offset += line.length + 1;
      i++;
      while (i < lines.length && (lines[i] ?? "").startsWith(">")) {
        const quoteLine = lines[i] ?? "";
        blockText += "\n" + quoteLine;
        offset += quoteLine.length + 1;
        i++;
      }
      const existingId = extractBlockId(blockText);
      blocks.push({
        id: existingId ?? `blk_${ulid()}`,
        type: "blockquote",
        startOffset: lineStart,
        endOffset: offset - 1,
        text: blockText,
      });
      continue;
    }

    // List (unordered or ordered)
    if (/^(\s*[-*+]|\s*\d+\.)\s/.test(line)) {
      let blockText = line;
      offset += line.length + 1;
      i++;
      while (i < lines.length) {
        const listLine = lines[i] ?? "";
        if (listLine.trim() === "") break;
        if (/^(\s*[-*+]|\s*\d+\.)\s/.test(listLine) || /^\s{2,}/.test(listLine)) {
          blockText += "\n" + listLine;
          offset += listLine.length + 1;
          i++;
        } else {
          break;
        }
      }
      const existingId = extractBlockId(blockText);
      blocks.push({
        id: existingId ?? `blk_${ulid()}`,
        type: "list",
        startOffset: lineStart,
        endOffset: offset - 1,
        text: blockText,
      });
      continue;
    }

    // HTML block
    if (/^<[a-zA-Z]/.test(line) && !BLOCK_ID_RE.test(line)) {
      let blockText = line;
      offset += line.length + 1;
      i++;
      while (i < lines.length && (lines[i] ?? "").trim() !== "") {
        const htmlLine = lines[i] ?? "";
        blockText += "\n" + htmlLine;
        offset += htmlLine.length + 1;
        i++;
      }
      const existingId = extractBlockId(blockText);
      blocks.push({
        id: existingId ?? `blk_${ulid()}`,
        type: "html",
        startOffset: lineStart,
        endOffset: offset - 1,
        text: blockText,
      });
      continue;
    }

    // Default: paragraph (any other non-blank consecutive lines)
    {
      let blockText = line;
      offset += line.length + 1;
      i++;
      while (i < lines.length && (lines[i] ?? "").trim() !== "") {
        const nextLine = lines[i] ?? "";
        // Break if next line starts a new block type
        if (
          /^#{1,6}\s/.test(nextLine) ||
          /^(`{3,}|~{3,})/.test(nextLine) ||
          /^(---|\*\*\*|___)(\s*)$/.test(nextLine) ||
          nextLine.startsWith("|") ||
          nextLine.startsWith(">") ||
          /^(\s*[-*+]|\s*\d+\.)\s/.test(nextLine) ||
          /^<[a-zA-Z]/.test(nextLine)
        ) {
          break;
        }
        blockText += "\n" + nextLine;
        offset += nextLine.length + 1;
        i++;
      }
      const existingId = extractBlockId(blockText);
      blocks.push({
        id: existingId ?? `blk_${ulid()}`,
        type: "paragraph",
        startOffset: lineStart,
        endOffset: offset - 1,
        text: blockText,
      });
    }
  }

  return blocks;
}

/**
 * Extract an existing block ID from a line or block of text.
 */
function extractBlockId(text: string): string | null {
  const match = BLOCK_ID_RE.exec(text);
  return match ? `blk_${match[1]}` : null;
}

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

    // Check if this line starts a known block
    const block = blocks[blockIdx];
    if (block && lineOffsetMatches(lines, lineIdx, block.startOffset)) {
      // Find where this block ends in lines
      const blockEndLine = findLineAtOffset(lines, block.endOffset);

      // Copy all lines of this block
      for (let j = lineIdx; j <= blockEndLine; j++) {
        result.push(lines[j] ?? "");
      }

      // If last line of block doesn't have a block ID, inject it
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
