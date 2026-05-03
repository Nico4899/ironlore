import { parseBlocks } from "@ironlore/core";
import type { StorageWriter } from "../storage-writer.js";
import { checkToolAcl } from "./acl-gate.js";
import type { ToolCallContext, ToolImplementation } from "./types.js";

/**
 * kb.read_page — read a page's content, ETag, and block list.
 *
 * The agent uses this to fetch the current state of a page before
 * editing. The returned ETag must be passed back on any subsequent
 * `kb.replace_block` or `kb.delete_block` call for optimistic
 * concurrency.
 *
 * Phase-9 multi-user: gated by `checkToolAcl` for read access.
 * Single-user installs and runs without a user identity (heartbeats /
 * cron) skip the gate; multi-user runs that originated from a user
 * session enforce the page's ACL (with ancestor `index.md`
 * inheritance) before returning content.
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
    async execute(args: unknown, ctx: ToolCallContext): Promise<string> {
      const { path } = args as { path: string };
      const aclCheck = checkToolAcl(ctx, writer, path, "read");
      if (!aclCheck.ok) return JSON.stringify(aclCheck.envelope);
      try {
        const { content, etag } = writer.read(path);
        const blocks = parseBlocks(content).map((b) => ({
          id: b.id,
          type: b.type,
          preview: b.text.slice(0, 120),
        }));
        return JSON.stringify({ content, etag, blocks });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return JSON.stringify({ error: "Page not found", path });
        }
        if (code === "EISDIR") {
          // Wrap the raw Node errno so the model sees a structured
          // envelope (and the dispatcher's `is_error` flag fires
          // correctly via top-level `error` detection). The audit
          // caught wiki-gardener's `kb.read_page("wiki")` returning
          // a raw `EISDIR: illegal operation on a directory, read`
          // string instead of telling the model what the path
          // actually was — and how to recover.
          return JSON.stringify({
            error: `Path '${path}' is a directory, not a page. Use kb.search to list its contents or pick a specific .md file inside it.`,
            path,
            kind: "directory",
          });
        }
        throw err;
      }
    },
  };
}
