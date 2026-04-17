import { parseBlocks } from "@ironlore/core";
import type { StorageWriter } from "../storage-writer.js";
import type { ToolCallContext, ToolImplementation } from "./types.js";

/**
 * kb.read_block — read a single block's markdown without pulling the
 * whole page.
 *
 * This is the cheap recovery path for agents that cached a block ID
 * earlier in a run and now want to cite it (or rewrite it) without
 * re-paying the full `kb.read_page` cost. The returned `etag` still
 * refers to the page-level ETag — any follow-up mutation must pass it
 * to `kb.replace_block` / `kb.insert_after` / `kb.delete_block` for
 * optimistic concurrency.
 *
 * See docs/04-ai-and-agents.md §The edit protocol.
 */
export function createKbReadBlock(writer: StorageWriter): ToolImplementation {
  return {
    definition: {
      name: "kb.read_block",
      description:
        "Read a single block's markdown by its block ID. Returns the block text, its type, " +
        "and the page-level ETag needed for any follow-up mutation.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Page path relative to data/" },
          blockId: { type: "string", description: "Block ID to fetch (e.g., blk_01HY0A...)" },
        },
        required: ["path", "blockId"],
      },
    },
    async execute(args: unknown, _ctx: ToolCallContext): Promise<string> {
      const { path, blockId } = args as { path: string; blockId: string };

      try {
        const { content, etag } = writer.read(path);
        const blocks = parseBlocks(content);
        const block = blocks.find((b) => b.id === blockId);

        if (!block) {
          return JSON.stringify({
            error: `Block ${blockId} not found in ${path}. Re-read with kb.read_page to get current block IDs.`,
            availableBlocks: blocks.map((b) => b.id),
          });
        }

        return JSON.stringify({
          blockId: block.id,
          type: block.type,
          text: block.text,
          etag,
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return JSON.stringify({ error: "Page not found", path });
        }
        throw err;
      }
    },
  };
}
