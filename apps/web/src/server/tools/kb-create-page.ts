import { join } from "node:path";
import { ulid } from "@ironlore/core";
import { stampOwner } from "../acl.js";
import { assignBlockIds, type BlockProvenance, writeBlocksSidecar } from "../block-ids.js";
import type { SearchIndex } from "../search-index.js";
import type { StorageWriter } from "../storage-writer.js";
import { checkToolAclForCreate } from "./acl-gate.js";
import type { ToolCallContext, ToolImplementation } from "./types.js";
import { assertWritableKind, WritableKindsViolation } from "./writable-kinds-gate.js";

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
        "StorageWriter so it gets block IDs, an ETag, git history, and FTS5 indexing. " +
        "When the parent path is under `.agents/**/skills/`, the file is shaped as a skill " +
        "(`name` + `description` frontmatter only) so the skill-loader and BM25 surface can " +
        "discover it correctly. Pass a one-line `description` so other agents can find it.",
      inputSchema: {
        type: "object",
        properties: {
          parent: {
            type: "string",
            description: "Parent directory relative to data/ (e.g., 'wiki')",
          },
          title: { type: "string", description: "Page title (becomes `name` for skills)" },
          markdown: { type: "string", description: "Initial page body (markdown)" },
          kind: {
            type: "string",
            enum: ["page", "source", "wiki"],
            description: "Page kind (default: page). Ignored for skill paths.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional tags. Ignored for skill paths.",
          },
          description: {
            type: "string",
            description:
              "Required for skill paths (`.agents/**/skills/`). One-line summary that surfaces in BM25 + the skill-discovery UI.",
          },
        },
        required: ["parent", "title", "markdown"],
      },
    },
    async execute(args: unknown, ctx: ToolCallContext): Promise<string> {
      const { parent, title, markdown, kind, tags, description } = args as {
        parent: string;
        title: string;
        markdown: string;
        kind?: "page" | "source" | "wiki";
        tags?: string[];
        description?: string;
      };

      // Detect skill paths: any agent's `skills/` dir, including the
      // shared `.agents/.shared/skills/`. Skills must use the
      // `{name, description}` convention (see skill-loader.ts) — page
      // frontmatter (`schema`, `id`, `title`, `kind`) was previously
      // emitted here for every create, which produced files the
      // discovery layer didn't recognise as skills.
      const isSkillPath = /(?:^|\/)\.agents\/[^/]+\/skills(?:\/|$)/.test(parent);

      // writable_kinds gate — `kind` comes from input rather than an
      // existing page; default to "page" when unspecified.
      try {
        assertWritableKind(ctx, kind ?? null);
      } catch (err) {
        if (err instanceof WritableKindsViolation) {
          return JSON.stringify({ error: err.message, status: err.status });
        }
        throw err;
      }

      // Phase-9 multi-user ACL gate — check the parent's effective
      //  ACL because the target page doesn't exist yet. Single-user
      //  runs + cron heartbeats permit. The user becomes the page's
      //  owner on first write via `stampOwner` further down the chain.
      const aclCheck = checkToolAclForCreate(ctx, writer, parent ?? "");
      if (!aclCheck.ok) return JSON.stringify(aclCheck.envelope);

      const id = ulid();
      const now = new Date().toISOString();
      const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60);
      const path = parent ? `${parent}/${slug}.md` : `${slug}.md`;

      // Skills get a minimal `{name, description}` envelope so the
      // skill-loader's frontmatter strip leaves a clean body and the
      // discovery surface can read both fields. Pages get the full
      // `{schema, id, title, kind, created, modified, tags}` shape.
      const frontmatter = isSkillPath
        ? ["---", `name: ${title}`, `description: ${description ?? title}`, "---"].join("\n")
        : [
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

      let rawContent = `${frontmatter}\n\n# ${title}\n\n${markdown}\n`;
      // Phase-9 multi-user: stamp the originating user as the page's
      //  owner, mirroring `pages-api.ts`'s first-PUT behaviour.
      //  Single-user runs (no `ctx.acl`) skip the stamp — there's
      //  only one user, ownership doesn't matter.
      if (ctx.acl) {
        rawContent = stampOwner(rawContent, ctx.acl.userId);
      }
      // Stamp block IDs on the brand-new page so the sidecar has
      // consistent IDs to attach provenance to. `assignBlockIds`
      // returns the annotated content + parsed blocks.
      const { markdown: content, blocks } = assignBlockIds(rawContent);

      // Every block on a freshly-created page is "new", so stamp the
      // calling agent + compiled_at on all of them. `derived_from`
      // isn't supplied at create time — the model fills it in on
      // subsequent kb.replace_block calls per cited block.
      const compiledAt = new Date().toISOString();
      const provenanceByBlockId = new Map<string, BlockProvenance>();
      for (const b of blocks) {
        provenanceByBlockId.set(b.id, {
          ...(ctx.agentSlug ? { agent: ctx.agentSlug } : {}),
          compiled_at: compiledAt,
        });
      }

      try {
        const { etag } = await writer.write(path, content, null, ctx.agentSlug);
        searchIndex.indexPage(path, content, ctx.agentSlug);
        const absPath = join(writer.getDataRoot(), path);
        writeBlocksSidecar(absPath, blocks, provenanceByBlockId);
        return JSON.stringify({ ok: true, id, path, etag });
      } catch (err) {
        return JSON.stringify({ error: String(err) });
      }
    },
  };
}
