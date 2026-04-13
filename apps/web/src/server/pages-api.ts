import { readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { detectPageType, isSupportedExtension, type PageType } from "@ironlore/core";
import { ForbiddenError, parseEtag } from "@ironlore/core/server";
import { createPatch } from "diff";
import { Hono } from "hono";
import { assignBlockIds, parseBlocks, writeBlocksSidecar } from "./block-ids.js";
import type { SearchIndex } from "./search-index.js";
import { EtagMismatchError, type StorageWriter } from "./storage-writer.js";

// ---------------------------------------------------------------------------
// MIME type map for raw file serving
// ---------------------------------------------------------------------------

const MIME_MAP: Record<string, string> = {
  // Images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  // Video
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  // Audio
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  // Documents
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  // Code / text
  ".md": "text/markdown",
  ".mermaid": "text/plain",
  ".mmd": "text/plain",
  ".ts": "text/plain",
  ".tsx": "text/plain",
  ".js": "text/plain",
  ".jsx": "text/plain",
  ".py": "text/plain",
  ".go": "text/plain",
  ".rs": "text/plain",
  ".rb": "text/plain",
  ".java": "text/plain",
  ".kt": "text/plain",
  ".swift": "text/plain",
  ".c": "text/plain",
  ".cpp": "text/plain",
  ".h": "text/plain",
  ".hpp": "text/plain",
  ".cs": "text/plain",
  ".php": "text/plain",
  ".sh": "text/plain",
  ".bash": "text/plain",
  ".zsh": "text/plain",
  ".fish": "text/plain",
  ".lua": "text/plain",
  ".r": "text/plain",
  ".sql": "text/plain",
  ".yaml": "text/plain",
  ".yml": "text/plain",
  ".toml": "text/plain",
  ".json": "application/json",
  ".xml": "text/xml",
  ".html": "text/html",
  ".css": "text/css",
  ".scss": "text/plain",
};

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
    const pagePath = c.req.param("*") ?? "";
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
    const pagePath = c.req.param("*") ?? "";
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
    const pagePath = c.req.param("*") ?? "";
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

/**
 * Create raw file serving API for non-markdown content.
 *
 * Routes:
 *   GET  /raw/*path → raw file bytes with correct Content-Type
 *   PUT  /raw/*path ← raw text body (CSV only) → 200 { etag } | 409
 */
export function createRawApi(writer: StorageWriter): Hono {
  const api = new Hono();

  // -----------------------------------------------------------------------
  // Serve raw file content
  // -----------------------------------------------------------------------
  api.get("/*", (c) => {
    const filePath = c.req.param("*") ?? "";
    if (!filePath) {
      return c.json({ error: "Path required" }, 400);
    }

    try {
      const { buffer, etag } = writer.readRaw(filePath);
      const ext = extname(filePath).toLowerCase();
      const contentType = MIME_MAP[ext] ?? "application/octet-stream";

      c.header("ETag", etag);
      c.header("Cache-Control", "no-cache");
      c.header("Content-Type", contentType);
      c.header("Content-Disposition", "inline");
      c.header("Content-Length", String(buffer.length));
      // Convert Node Buffer to a standard ArrayBuffer for Hono's c.body()
      const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      return c.body(ab as ArrayBuffer);
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
  // Write raw text content (CSV only)
  // -----------------------------------------------------------------------
  api.put("/*", async (c) => {
    const filePath = c.req.param("*") ?? "";
    if (!filePath) {
      return c.json({ error: "Path required" }, 400);
    }

    const ext = extname(filePath).toLowerCase();
    if (ext !== ".csv") {
      return c.json({ error: "Only CSV files can be written via /raw" }, 400);
    }

    const ifMatch = c.req.header("If-Match");
    const body = await c.req.text();

    try {
      const parsedIfMatch = ifMatch ? parseEtag(ifMatch) : null;
      const ifMatchQuoted = parsedIfMatch ? `"${parsedIfMatch}"` : null;

      const { etag } = await writer.write(filePath, body, ifMatchQuoted);

      c.header("ETag", etag);
      return c.json({ etag });
    } catch (err) {
      if (err instanceof EtagMismatchError) {
        return c.json(
          {
            error: "Conflict",
            currentEtag: err.currentEtag,
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

  return api;
}

// ---------------------------------------------------------------------------
// Tree walking
// ---------------------------------------------------------------------------

interface TreeEntry {
  name: string;
  path: string;
  type: PageType | "directory";
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
      } else if (isSupportedExtension(item.name)) {
        const pageType = detectPageType(item.name);
        entries.push({ name: item.name, path: relPath, type: pageType });
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }

  return entries;
}
