import { parseBlocks } from "@ironlore/core";
import type { SearchIndex } from "../search-index.js";
import type { StorageWriter } from "../storage-writer.js";
import type { ToolCallContext, ToolImplementation } from "./types.js";

/**
 * kb.insert_after — atomic block insertion after a reference block.
 *
 * The agent provides the block ID to insert AFTER, the new markdown, and
 * the ETag from its last read. The server validates ETag (409 on stale)
 * and block existence (404 on hallucinated), then splices the new
 * content in at the end-offset of the reference block.
 *
 * Newly inserted blocks get their IDs assigned by the PUT handler's
 * `assignBlockIds()` pass — the agent never forges block IDs.
 *
 * The optional `derived_from` parameter lets the agent cite source
 * blocks for provenance tracking. The `agent` field is server-stamped
 * from the calling agent's slug so models cannot lie about authorship.
 *
 * See docs/04-ai-and-agents.md §The edit protocol.
 */
export function createKbInsertAfter(
  writer: StorageWriter,
  searchIndex: SearchIndex,
): ToolImplementation {
  return {
    definition: {
      name: "kb.insert_after",
      description:
        "Insert new markdown after a specific block. Requires the block ID and current ETag " +
        "from kb.read_page. Optionally pass derived_from to cite source blocks for " +
        "provenance tracking.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Page path relative to data/" },
          blockId: {
            type: "string",
            description: "Block ID to insert after (new block lands immediately below it)",
          },
          markdown: {
            type: "string",
            description: "Markdown to insert — may contain one or more blocks",
          },
          etag: { type: "string", description: "ETag from the last kb.read_page call" },
          derived_from: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional: source block references (pageId#blockId) this content was derived from",
          },
        },
        required: ["path", "blockId", "markdown", "etag"],
      },
    },
    async execute(args: unknown, ctx: ToolCallContext): Promise<string> {
      const {
        path,
        blockId,
        markdown,
        etag,
        derived_from: _derivedFrom,
      } = args as {
        path: string;
        blockId: string;
        markdown: string;
        etag: string;
        derived_from?: string[];
      };
      // TODO: wire _derivedFrom into .blocks.json sidecar when the
      // provenance path lands (Track C).

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

      // Splice the new content in immediately after the target block's
      // end offset, separated by a blank line so parseBlocks treats the
      // insert as a new block. Trim trailing whitespace so we don't
      // drift paragraph spacing over repeated inserts.
      const before = currentContent.slice(0, target.endOffset);
      const after = currentContent.slice(target.endOffset);
      const trimmedInsert = markdown.replace(/^\s+|\s+$/g, "");
      const newContent = `${before}\n\n${trimmedInsert}${after.startsWith("\n") ? "" : "\n"}${after}`;

      try {
        const { etag: newEtag } = await writer.write(path, newContent, etag, ctx.agentSlug);
        searchIndex.indexPage(path, newContent, ctx.agentSlug);

        return JSON.stringify({ ok: true, newEtag });
      } catch (err) {
        return JSON.stringify({ error: String(err) });
      }
    },
  };
}
