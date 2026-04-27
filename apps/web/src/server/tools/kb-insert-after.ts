import { join } from "node:path";
import { parseBlocks } from "@ironlore/core";
import { assignBlockIds, type BlockProvenance, writeBlocksSidecar } from "../block-ids.js";
import type { SearchIndex } from "../search-index.js";
import type { StorageWriter } from "../storage-writer.js";
import { extractPageKind } from "./page-kind.js";
import type { ToolCallContext, ToolImplementation } from "./types.js";
import { assertWritableKind, WritableKindsViolation } from "./writable-kinds-gate.js";

function renderInsertDiff(anchorBlockId: string, newText: string): string {
  const lines = newText.split("\n").map((l) => `+ ${l}`);
  return [`@@ insert after ${anchorBlockId} @@`, ...lines].join("\n");
}

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
    async computeDiff(args, _ctx) {
      const { path, blockId, markdown } = args as {
        path: string;
        blockId: string;
        markdown: string;
      };
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
        diff: renderInsertDiff(blockId, markdown),
      };
    },
    async execute(args: unknown, ctx: ToolCallContext): Promise<string> {
      const { path, blockId, markdown, etag, derived_from } = args as {
        path: string;
        blockId: string;
        markdown: string;
        etag: string;
        derived_from?: string[];
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

      // writable_kinds gate — pre-write check; throws on violation,
      // surfaced as a 403-shaped tool error.
      try {
        assertWritableKind(ctx, extractPageKind(currentContent));
      } catch (err) {
        if (err instanceof WritableKindsViolation) {
          return JSON.stringify({ error: err.message, status: err.status });
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

      // Stamp block IDs on any freshly-inserted blocks so subsequent
      // kb.* calls can reference them. `assignBlockIds` preserves
      // existing IDs and only annotates new ones.
      const { markdown: annotated, blocks: newBlocks } = assignBlockIds(newContent);

      // Provenance for the NEW block IDs introduced by this insert.
      // The model's `derived_from` array applies to every new block
      // produced by the insertion — typically one, sometimes more if
      // the insert spans multiple blocks. Pre-existing blocks keep
      // their prior provenance via the merge in writeBlocksSidecar.
      const preWriteIds = new Set(blocks.map((b) => b.id));
      const compiledAt = new Date().toISOString();
      const provenanceByBlockId = new Map<string, BlockProvenance>();
      for (const b of newBlocks) {
        if (preWriteIds.has(b.id)) continue;
        provenanceByBlockId.set(b.id, {
          ...(derived_from !== undefined ? { derived_from } : {}),
          ...(ctx.agentSlug ? { agent: ctx.agentSlug } : {}),
          compiled_at: compiledAt,
        });
      }

      try {
        const { etag: newEtag } = await writer.write(path, annotated, etag, ctx.agentSlug);
        searchIndex.indexPage(path, annotated, ctx.agentSlug);
        // Sidecar write includes the new provenance — fixes the
        // long-standing gap where tool-edited pages had stale
        // .blocks.json (sidecar was only refreshed on the HTTP write
        // path).
        const absPath = join(writer.getDataRoot(), path);
        writeBlocksSidecar(absPath, newBlocks, provenanceByBlockId);

        return JSON.stringify({ ok: true, newEtag });
      } catch (err) {
        return JSON.stringify({ error: String(err) });
      }
    },
  };
}
