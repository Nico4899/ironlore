import { parseBlocks } from "@ironlore/core";
import { assignBlockIds } from "../block-ids.js";
import type { SearchIndex } from "../search-index.js";
import type { StorageWriter } from "../storage-writer.js";
import type { ToolCallContext, ToolImplementation } from "./types.js";

function renderDeleteDiff(blockId: string, oldText: string): string {
  const lines = oldText.split("\n").map((l) => `- ${l}`);
  return [`@@ delete block ${blockId} @@`, ...lines].join("\n");
}

/**
 * kb.delete_block — atomic block deletion with ETag concurrency.
 *
 * The agent provides the block ID and the ETag from its last read. The
 * server validates ETag (409 on stale) and block existence (404 on
 * hallucinated), then removes the block text range — plus one trailing
 * separator newline when present so the surrounding paragraphs don't
 * collide visually.
 *
 * Agents that want to preserve structural context should prefer
 * `kb.replace_block` with a placeholder over outright deletion; this
 * tool exists for cases where the block is genuinely redundant.
 *
 * See docs/04-ai-and-agents.md §The edit protocol.
 */
export function createKbDeleteBlock(
  writer: StorageWriter,
  searchIndex: SearchIndex,
): ToolImplementation {
  return {
    definition: {
      name: "kb.delete_block",
      description:
        "Delete a specific block from a page. Requires the block ID and current ETag " +
        "from kb.read_page.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Page path relative to data/" },
          blockId: { type: "string", description: "Block ID to delete (e.g., blk_01HY0A...)" },
          etag: { type: "string", description: "ETag from the last kb.read_page call" },
        },
        required: ["path", "blockId", "etag"],
      },
    },
    async computeDiff(args, _ctx) {
      const { path, blockId } = args as { path: string; blockId: string };
      let current: string;
      try {
        current = writer.read(path).content;
      } catch {
        return null;
      }
      const blocks = parseBlocks(current);
      const target = blocks.find((b) => b.id === blockId);
      if (!target) return null;
      return {
        pageId: path,
        diff: renderDeleteDiff(blockId, target.text),
      };
    },
    async execute(args: unknown, ctx: ToolCallContext): Promise<string> {
      const { path, blockId, etag } = args as {
        path: string;
        blockId: string;
        etag: string;
      };

      let currentContent: string;
      try {
        const read = writer.read(path);
        currentContent = read.content;

        if (read.etag !== etag) {
          return JSON.stringify({
            error:
              "ETag mismatch — page was modified since your last read. Re-read with kb.read_page.",
            currentEtag: read.etag,
          });
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return JSON.stringify({ error: "Page not found", path });
        }
        throw err;
      }

      const blocks = parseBlocks(currentContent);
      const target = blocks.find((b) => b.id === blockId);
      if (!target) {
        return JSON.stringify({
          error: `Block ${blockId} not found in ${path}. Re-read with kb.read_page to get current block IDs.`,
          availableBlocks: blocks.map((b) => b.id),
        });
      }

      // Strip the block text plus any immediately following blank-line
      // separator so we don't leave a double-blank seam where a block
      // used to live. `parseBlocks` reports `endOffset` at the block's
      // trailing newline(s), so eat up to two more newlines after it.
      let sliceEnd = target.endOffset;
      while (sliceEnd < currentContent.length && currentContent[sliceEnd] === "\n") {
        sliceEnd++;
        if (sliceEnd - target.endOffset >= 2) break;
      }

      const before = currentContent.slice(0, target.startOffset);
      const after = currentContent.slice(sliceEnd);
      const newContent = before + after;

      // Stamp block IDs on any surviving blocks whose ID anchors were
      // adjacent to the deleted block and may now need re-assignment.
      // `assignBlockIds` preserves existing IDs and only annotates new ones.
      const { markdown: annotated } = assignBlockIds(newContent);

      try {
        const { etag: newEtag } = await writer.write(path, annotated, etag, ctx.agentSlug);
        searchIndex.indexPage(path, annotated, ctx.agentSlug);

        return JSON.stringify({ ok: true, newEtag });
      } catch (err) {
        return JSON.stringify({ error: String(err) });
      }
    },
  };
}
