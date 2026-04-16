import { ulid } from "@ironlore/core";
import type { StorageWriter } from "../storage-writer.js";
import type { SearchIndex } from "../search-index.js";
import type { ToolCallContext, ToolImplementation } from "./types.js";

/**
 * kb.create_page — create a new page, assign frontmatter, return ID.
 */
export function createKbCreatePage(
  writer: StorageWriter,
  searchIndex: SearchIndex,
): ToolImplementation {
  return {
    definition: {
      name: "kb.create_page",
      description:
        "Create a new page. Returns the assigned page ID. The page is written through " +
        "StorageWriter so it gets block IDs, an ETag, git history, and FTS5 indexing.",
      inputSchema: {
        type: "object",
        properties: {
          parent: { type: "string", description: "Parent directory relative to data/ (e.g., 'wiki')" },
          title: { type: "string", description: "Page title" },
          markdown: { type: "string", description: "Initial page body (markdown)" },
          kind: {
            type: "string",
            enum: ["page", "source", "wiki"],
            description: "Page kind (default: page)",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional tags",
          },
        },
        required: ["parent", "title", "markdown"],
      },
    },
    async execute(args: unknown, ctx: ToolCallContext): Promise<string> {
      const { parent, title, markdown, kind, tags } = args as {
        parent: string;
        title: string;
        markdown: string;
        kind?: string;
        tags?: string[];
      };

      const id = ulid();
      const now = new Date().toISOString();
      const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60);
      const path = parent ? `${parent}/${slug}.md` : `${slug}.md`;

      const frontmatter = [
        "---",
        `schema: 1`,
        `id: ${id}`,
        `title: ${title}`,
        kind ? `kind: ${kind}` : null,
        `created: ${now}`,
        `modified: ${now}`,
        tags && tags.length > 0 ? `tags: [${tags.join(", ")}]` : null,
        "---",
      ]
        .filter(Boolean)
        .join("\n");

      const content = `${frontmatter}\n\n# ${title}\n\n${markdown}\n`;

      try {
        const { etag } = await writer.write(path, content, null, ctx.agentSlug);
        searchIndex.indexPage(path, content, ctx.agentSlug);
        return JSON.stringify({ ok: true, id, path, etag });
      } catch (err) {
        return JSON.stringify({ error: String(err) });
      }
    },
  };
}
