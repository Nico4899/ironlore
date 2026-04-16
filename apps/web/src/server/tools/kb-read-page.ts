import { parseBlocks } from "@ironlore/core";
import type { StorageWriter } from "../storage-writer.js";
import type { ToolCallContext, ToolImplementation } from "./types.js";

/**
 * kb.read_page — read a page's content, ETag, and block list.
 *
 * The agent uses this to fetch the current state of a page before
 * editing. The returned ETag must be passed back on any subsequent
 * `kb.replace_block` or `kb.delete_block` call for optimistic
 * concurrency.
 */
export function createKbReadPage(writer: StorageWriter): ToolImplementation {
  return {
    definition: {
      name: "kb.read_page",
      description:
        "Read a page. Returns the full markdown content, the current ETag (needed for edits), " +
        "and the list of block IDs with their types.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Page path relative to data/" },
        },
        required: ["path"],
      },
    },
    async execute(args: unknown, _ctx: ToolCallContext): Promise<string> {
      const { path } = args as { path: string };
      try {
        const { content, etag } = writer.read(path);
        const blocks = parseBlocks(content).map((b) => ({
          id: b.id,
          type: b.type,
          preview: b.text.slice(0, 120),
        }));
        return JSON.stringify({ content, etag, blocks });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return JSON.stringify({ error: "Page not found", path });
        }
        throw err;
      }
    },
  };
}
