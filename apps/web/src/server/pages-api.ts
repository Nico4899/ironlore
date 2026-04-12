import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { ForbiddenError, parseEtag } from "@ironlore/core";
import { createPatch } from "diff";
import { Hono } from "hono";
import { assignBlockIds, parseBlocks, writeBlocksSidecar } from "./block-ids.js";
import type { SearchIndex } from "./search-index.js";
import { EtagMismatchError, type StorageWriter } from "./storage-writer.js";

/**
 * Create page API routes for a project.
 *
 * Routes:
 *   GET  /pages/*path  → 200 { content, etag, blocks } | 404
 *   PUT  /pages/*path  ← If-Match + { markdown } → 200 { etag } | 409 | 403
 *   DELETE /pages/*path ← If-Match → 204 | 409 | 404
 *   GET  /pages        → 200 { pages: TreeEntry[] }
 */
export function createPagesApi(writer: StorageWriter, searchIndex: SearchIndex): Hono {
  const api = new Hono();

  // -----------------------------------------------------------------------
  // List pages (tree)
  // -----------------------------------------------------------------------
  api.get("/", (c) => {
    const dataRoot = writer.getDataRoot();
    const entries = walkTree(dataRoot, dataRoot);
    return c.json({ pages: entries });
  });

  // -----------------------------------------------------------------------
  // Read a page
  // -----------------------------------------------------------------------
  api.get("/*", (c) => {
    const pagePath = c.req.path.replace(/^\//, "");
    if (!pagePath) {
      return c.json({ error: "Path required" }, 400);
    }

    try {
      const { content, etag } = writer.read(pagePath);
      const blocks = parseBlocks(content);

      c.header("ETag", etag);
      c.header("Cache-Control", "no-cache");
      return c.json({
        content,
        etag,
        blocks: blocks.map((b) => ({ id: b.id, type: b.type, text: b.text })),
      });
    } catch (err) {
      if (err instanceof ForbiddenError) {
        return c.json({ error: "Forbidden" }, 403);
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return c.json({ error: "Not found" }, 404);
      }
      throw err;
    }
  });

  // -----------------------------------------------------------------------
  // Write a page
  // -----------------------------------------------------------------------
  api.put("/*", async (c) => {
    const pagePath = c.req.path.replace(/^\//, "");
    if (!pagePath) {
      return c.json({ error: "Path required" }, 400);
    }

    const ifMatch = c.req.header("If-Match");
    const body = await c.req.json<{ markdown: string }>();

    if (typeof body.markdown !== "string") {
      return c.json({ error: "Body must include 'markdown' string" }, 400);
    }

    // Assign block IDs to new blocks before writing
    const { markdown: annotated, blocks } = assignBlockIds(body.markdown);

    try {
      const parsedIfMatch = ifMatch ? parseEtag(ifMatch) : null;
      // Re-wrap for comparison: computeEtag returns quoted
      const ifMatchQuoted = parsedIfMatch ? `"${parsedIfMatch}"` : null;

      const { etag } = await writer.write(pagePath, annotated, ifMatchQuoted);

      // Write .blocks.json sidecar alongside the markdown file
      const absPath = join(writer.getDataRoot(), pagePath);
      writeBlocksSidecar(absPath, blocks);

      // Update search index + backlinks
      searchIndex.indexPage(pagePath, annotated, "user");

      c.header("ETag", etag);
      return c.json({ etag });
    } catch (err) {
      if (err instanceof EtagMismatchError) {
        const diff = createPatch(pagePath, annotated, err.currentContent);
        return c.json(
          {
            error: "Conflict",
            currentEtag: err.currentEtag,
            diff,
          },
          409,
        );
      }
      if (err instanceof ForbiddenError) {
        return c.json({ error: "Forbidden" }, 403);
      }
      throw err;
    }
  });

  // -----------------------------------------------------------------------
  // Delete a page
  // -----------------------------------------------------------------------
  api.delete("/*", async (c) => {
    const pagePath = c.req.path.replace(/^\//, "");
    if (!pagePath) {
      return c.json({ error: "Path required" }, 400);
    }

    const ifMatch = c.req.header("If-Match");
    if (!ifMatch) {
      return c.json({ error: "If-Match header required" }, 428);
    }

    try {
      const parsed = parseEtag(ifMatch);
      await writer.delete(pagePath, `"${parsed}"`);

      // Remove from search index
      searchIndex.removePage(pagePath);

      return c.body(null, 204);
    } catch (err) {
      if (err instanceof EtagMismatchError) {
        const diff = createPatch(pagePath, "", err.currentContent);
        return c.json(
          {
            error: "Conflict",
            currentEtag: err.currentEtag,
            diff,
          },
          409,
        );
      }
      if (err instanceof ForbiddenError) {
        return c.json({ error: "Forbidden" }, 403);
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return c.json({ error: "Not found" }, 404);
      }
      throw err;
    }
  });

  return api;
}

interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  kind?: string;
}

function walkTree(dir: string, root: string): TreeEntry[] {
  const entries: TreeEntry[] = [];

  try {
    const items = readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      // Skip hidden files/dirs except .agents
      if (item.name.startsWith(".") && item.name !== ".agents") continue;
      // Skip sidecar files
      if (item.name.endsWith(".blocks.json")) continue;

      const fullPath = join(dir, item.name);
      const relPath = relative(root, fullPath);

      if (item.isDirectory()) {
        entries.push({ name: item.name, path: relPath, type: "directory" });
        entries.push(...walkTree(fullPath, root));
      } else if (item.name.endsWith(".md")) {
        entries.push({ name: item.name, path: relPath, type: "file" });
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }

  return entries;
}
