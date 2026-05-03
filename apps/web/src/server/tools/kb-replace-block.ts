import { join } from "node:path";
import { parseBlocks } from "@ironlore/core";
import { assignBlockIds, type BlockProvenance, writeBlocksSidecar } from "../block-ids.js";
import type { SearchIndex } from "../search-index.js";
import type { StorageWriter } from "../storage-writer.js";
import { checkToolAcl } from "./acl-gate.js";
import { extractPageKind } from "./page-kind.js";
import type { ToolCallContext, ToolImplementation } from "./types.js";
import { assertWritableKind, WritableKindsViolation } from "./writable-kinds-gate.js";

/** Render a minimal +/- diff for a single-block replacement. */
function renderReplaceDiff(oldText: string, newText: string, blockId: string): string {
  const oldLines = oldText.split("\n").map((l) => `- ${l}`);
  const newLines = newText.split("\n").map((l) => `+ ${l}`);
  return [`@@ block ${blockId} @@`, ...oldLines, ...newLines].join("\n");
}

/**
 * kb.replace_block — atomic block replacement with ETag concurrency.
 *
 * The model provides a block ID (from a prior `kb.read_page`), the
 * replacement markdown, and the ETag from the last read. The server
 * validates:
 *   1. The ETag matches the current file (409 if stale).
 *   2. The block ID exists in the current content (404 if not).
 *   3. The agent's `writable_kinds` permit mutation (403 if denied).
 *
 * On success, `derived_from` (if provided) is written into
 * `.blocks.json` with the `agent` field server-stamped from the
 * calling agent's slug — models cannot forge provenance.
 */
export function createKbReplaceBlock(
  writer: StorageWriter,
  searchIndex: SearchIndex,
): ToolImplementation {
  return {
    definition: {
      name: "kb.replace_block",
      description:
        "Replace a specific block in a page. Requires the block ID and current ETag from kb.read_page. " +
        "Optionally pass derived_from to cite source blocks for provenance tracking.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Page path relative to data/" },
          blockId: { type: "string", description: "Block ID to replace (e.g., blk_01HY0A...)" },
          markdown: { type: "string", description: "Replacement markdown for this block" },
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
        diff: renderReplaceDiff(target.text, markdown, blockId),
        op: "replace",
        blockId,
        currentMd: target.text,
        proposedMd: markdown,
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

      // Phase-9 multi-user: gate on write access before doing anything
      //  destructive. Single-user runs + cron heartbeats permit.
      const aclCheck = checkToolAcl(ctx, writer, path, "write");
      if (!aclCheck.ok) return JSON.stringify(aclCheck.envelope);

      // Read current content.
      let currentContent: string;
      try {
        const read = writer.read(path);
        currentContent = read.content;

        // ETag check.
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

      // writable_kinds gate — pre-write check using the page's
      // declared kind. Throws WritableKindsViolation when the persona
      // doesn't permit; we surface it as a 403-shaped tool error.
      try {
        assertWritableKind(ctx, extractPageKind(currentContent));
      } catch (err) {
        if (err instanceof WritableKindsViolation) {
          return JSON.stringify({ error: err.message, status: err.status });
        }
        throw err;
      }

      // Find the target block.
      const blocks = parseBlocks(currentContent);
      const targetIdx = blocks.findIndex((b) => b.id === blockId);
      if (targetIdx === -1) {
        return JSON.stringify({
          error: `Block ${blockId} not found in ${path}. Re-read with kb.read_page to get current block IDs.`,
          availableBlocks: blocks.map((b) => b.id),
        });
      }

      const target = blocks[targetIdx];
      if (!target) {
        return JSON.stringify({ error: "Internal error: block index out of range" });
      }

      // Replace the block text in the content string.
      const before = currentContent.slice(0, target.startOffset);
      const after = currentContent.slice(target.endOffset);
      const newContent = before + markdown + after;

      // Stamp block IDs on any freshly-inserted blocks so subsequent
      // kb.* calls can reference them. `assignBlockIds` preserves
      // existing IDs and only annotates new ones.
      const { markdown: annotated, blocks: newBlocks } = assignBlockIds(newContent);

      // Compute provenance for the NEW block IDs introduced by this
      // edit. The model's single `derived_from` array applies to every
      // block produced by the replacement — typically one, but the
      // model can replace one block with several. Pre-existing block
      // IDs (untouched by the edit) keep their prior provenance via
      // the merge logic in writeBlocksSidecar.
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

      // Write through StorageWriter (same WAL + git path as everything else).
      try {
        const { etag: newEtag } = await writer.write(path, annotated, etag, ctx.agentSlug);
        searchIndex.indexPage(path, annotated, ctx.agentSlug);
        // Sidecar write closes the long-standing gap where tool-edited
        // pages had stale .blocks.json (the sidecar was only refreshed
        // on the HTTP write path). Provenance survives untouched
        // blocks via the merge in writeBlocksSidecar.
        const absPath = join(writer.getDataRoot(), path);
        writeBlocksSidecar(absPath, newBlocks, provenanceByBlockId);
        return JSON.stringify({ ok: true, newEtag });
      } catch (err) {
        return JSON.stringify({ error: String(err) });
      }
    },
  };
}
