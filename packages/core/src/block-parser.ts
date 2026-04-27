import { ulid } from "./ulid.js";

const BLOCK_ID_RE = /<!-- #blk_([A-Z0-9]{26}) -->/;

export type BlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "code"
  | "table"
  | "blockquote"
  | "hr"
  | "html";

/**
 * A top-level markdown block and its optional stable ID.
 */
export interface Block {
  id: string;
  type: BlockKind;
  startOffset: number;
  endOffset: number;
  text: string;
}

/**
 * The .blocks.json sidecar format — caches block-id to byte-range
 * mapping plus per-block provenance metadata that the markdown content
 * itself can't express.
 *
 * The (id, type, start, end) tuple is **rebuildable** from the markdown
 * source — a fresh `parseBlocks()` reproduces it exactly. The provenance
 * fields (`derived_from`, `agent`, `compiled_at`) are **authoritative**:
 * they're set by the tool layer at write-time and would be lost on a
 * naive .md → sidecar rebuild. Anyone reconstructing this sidecar from
 * markdown alone must merge the existing provenance forward by block ID.
 *
 * See docs/01-content-model.md §Block IDs for the provenance model and
 * docs/04-ai-and-agents.md §Wiki-gardener for the consumer.
 */
export interface BlocksIndex {
  version: 1;
  blocks: Array<{
    id: string;
    type: string;
    start: number;
    end: number;
    /**
     * Block-refs (`pageId#blockId`) the block was synthesized from.
     * Stamped by `kb.replace_block` / `kb.insert_after` when the model
     * cites sources for an agent-authored block. Absent on
     * human-written blocks; empty array means the agent explicitly
     * declared no sources.
     */
    derived_from?: string[];
    /**
     * Calling persona's slug, stamped from `ToolCallContext.agentSlug`
     * at sidecar-write time. Absent for human-written blocks (the
     * editor's HTTP write path doesn't supply it). Read by the
     * provenance-gap lint check to identify agent-authored blocks
     * with empty `derived_from`.
     */
    agent?: string;
    /**
     * ISO-8601 timestamp at the moment the tool wrote this block.
     * Different from the page's `updated_at` (which covers the
     * whole file) — `compiled_at` is per-block and survives later
     * edits to other blocks on the same page.
     */
    compiled_at?: string;
  }>;
}

/**
 * Parse markdown into top-level blocks and detect existing block IDs.
 *
 * Block detection is line-based (not a full AST parse) — sufficient for
 * identifying top-level structural blocks. Each top-level block gets a
 * stable ULID if it doesn't already have one. See
 * [docs/01-content-model.md](../../../docs/01-content-model.md) §Algorithm
 * for the full specification.
 */
export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.split("\n");
  const blocks: Block[] = [];

  let offset = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const lineStart = offset;

    if (line.trim() === "") {
      offset += line.length + 1;
      i++;
      continue;
    }

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

    if (/^(`{3,}|~{3,})/.test(line)) {
      const fence = line.match(/^(`{3,}|~{3,})/)?.[0] ?? "```";
      let blockText = line;
      offset += line.length + 1;
      i++;

      while (i < lines.length) {
        const fenceLine = lines[i] ?? "";
        blockText += `\n${fenceLine}`;
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

    if (line.startsWith("|")) {
      let blockText = line;
      offset += line.length + 1;
      i++;
      while (i < lines.length && (lines[i] ?? "").startsWith("|")) {
        const tableLine = lines[i] ?? "";
        blockText += `\n${tableLine}`;
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

    if (line.startsWith(">")) {
      let blockText = line;
      offset += line.length + 1;
      i++;
      while (i < lines.length && (lines[i] ?? "").startsWith(">")) {
        const quoteLine = lines[i] ?? "";
        blockText += `\n${quoteLine}`;
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

    if (/^(\s*[-*+]|\s*\d+\.)\s/.test(line)) {
      let blockText = line;
      offset += line.length + 1;
      i++;
      while (i < lines.length) {
        const listLine = lines[i] ?? "";
        if (listLine.trim() === "") break;
        if (/^(\s*[-*+]|\s*\d+\.)\s/.test(listLine) || /^\s{2,}/.test(listLine)) {
          blockText += `\n${listLine}`;
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

    if (/^<[a-zA-Z]/.test(line) && !BLOCK_ID_RE.test(line)) {
      let blockText = line;
      offset += line.length + 1;
      i++;
      while (i < lines.length && (lines[i] ?? "").trim() !== "") {
        const htmlLine = lines[i] ?? "";
        blockText += `\n${htmlLine}`;
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

    {
      let blockText = line;
      offset += line.length + 1;
      i++;
      while (i < lines.length && (lines[i] ?? "").trim() !== "") {
        const nextLine = lines[i] ?? "";
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
        blockText += `\n${nextLine}`;
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
export function extractBlockId(text: string): string | null {
  const match = BLOCK_ID_RE.exec(text);
  return match ? `blk_${match[1]}` : null;
}
