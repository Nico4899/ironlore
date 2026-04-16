import { existsSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { WsEventInput } from "@ironlore/core";
import { detectPageType, isBinaryExtension } from "@ironlore/core";
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
  ".txt": "text/plain",
  ".log": "text/plain",
  ".vtt": "text/vtt",
  ".srt": "text/plain",
  ".eml": "message/rfc822",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ipynb": "application/x-ipynb+json",
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
type BroadcastFn = (event: WsEventInput) => void;

export function createPagesApi(
  writer: StorageWriter,
  searchIndex: SearchIndex,
  broadcast?: BroadcastFn,
): Hono {
  const api = new Hono();

  // -----------------------------------------------------------------------
  // List pages (tree) — served from SQLite index
  // -----------------------------------------------------------------------
  api.get("/", (c) => {
    const entries = searchIndex.getTree();
    return c.json({ pages: entries });
  });

  // -----------------------------------------------------------------------
  // Create an empty folder — registered before the generic /:path{.+}
  // catch-all so Hono matches the more specific prefix first.
  // -----------------------------------------------------------------------
  api.post("/folders/:path{.+}", (c) => {
    const dirPath = c.req.param("path") ?? "";
    if (!dirPath) {
      return c.json({ error: "Path required" }, 400);
    }

    try {
      writer.mkdir(dirPath);
      broadcast?.({
        type: "tree:add",
        path: dirPath,
        name: basename(dirPath),
        fileType: "directory",
      });
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof ForbiddenError) {
        return c.json({ error: "Forbidden" }, 403);
      }
      throw err;
    }
  });

  // -----------------------------------------------------------------------
  // Delete a folder (recursive)
  // -----------------------------------------------------------------------
  api.delete("/folders/:path{.+}", (c) => {
    const dirPath = c.req.param("path") ?? "";
    if (!dirPath) {
      return c.json({ error: "Path required" }, 400);
    }

    try {
      writer.rmdir(dirPath);
      for (const entry of searchIndex.getTree()) {
        if (
          (entry.path === dirPath || entry.path.startsWith(`${dirPath}/`)) &&
          entry.type !== "directory"
        ) {
          searchIndex.removePage(entry.path);
        }
      }
      broadcast?.({ type: "tree:delete", path: dirPath });
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof ForbiddenError) {
        return c.json({ error: "Forbidden" }, 403);
      }
      throw err;
    }
  });

  // -----------------------------------------------------------------------
  // Read a page
  // -----------------------------------------------------------------------
  api.get("/:path{.+}", (c) => {
    const pagePath = c.req.param("path") ?? "";
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
  api.put("/:path{.+}", async (c) => {
    const pagePath = c.req.param("path") ?? "";
    if (!pagePath) {
      return c.json({ error: "Path required" }, 400);
    }

    if (extname(pagePath).toLowerCase() !== ".md") {
      return c.json({ error: "This endpoint only accepts markdown files" }, 400);
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

      const absPath = join(writer.getDataRoot(), pagePath);
      const isNew = !existsSync(absPath);

      const { etag } = await writer.write(pagePath, annotated, ifMatchQuoted);

      // Write .blocks.json sidecar alongside the markdown file
      writeBlocksSidecar(absPath, blocks);

      // Update search index + backlinks
      searchIndex.indexPage(pagePath, annotated, "user");

      // Broadcast tree event
      if (broadcast) {
        if (isNew) {
          broadcast({
            type: "tree:add",
            path: pagePath,
            name: basename(pagePath),
            fileType: detectPageType(pagePath),
          });
        } else {
          broadcast({ type: "tree:update", path: pagePath, etag });
        }
      }

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
            currentContent: err.currentContent,
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
  api.delete("/:path{.+}", async (c) => {
    const pagePath = c.req.param("path") ?? "";
    if (!pagePath) {
      return c.json({ error: "Path required" }, 400);
    }

    // If-Match is optional on DELETE: editor sessions with a cached ETag
    // pass it for concurrency protection; sidebar deletes (non-markdown,
    // never-opened) pass nothing and accept unconditional removal.
    const ifMatch = c.req.header("If-Match");

    try {
      const ifMatchQuoted = ifMatch ? `"${parseEtag(ifMatch)}"` : null;
      await writer.delete(pagePath, ifMatchQuoted);

      // Remove from search index
      searchIndex.removePage(pagePath);

      broadcast?.({ type: "tree:delete", path: pagePath });

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

  // -----------------------------------------------------------------------
  // Move a page
  //
  // Pages come in two shapes (see docs/01-content-model.md):
  //   1. A single `.md` / `.csv` / etc. file.
  //   2. A directory: `<page>/index.md + assets/ + …`.
  //
  // The single-file path reads → writes → deletes and renames the
  // `.blocks.json` sidecar. The directory path delegates to
  // `StorageWriter.moveDir` which performs an atomic `renameSync` on
  // the whole subtree so assets travel with the page.
  // -----------------------------------------------------------------------
  api.post("/:path{.+}/move", async (c) => {
    const sourcePath = c.req.param("path") ?? "";
    if (!sourcePath) {
      return c.json({ error: "Path required" }, 400);
    }

    const body = await c.req.json<{ destination: string }>();
    if (!body.destination || typeof body.destination !== "string") {
      return c.json({ error: "destination string required in body" }, 400);
    }

    const ifMatch = c.req.header("If-Match");
    const ifMatchQuoted = ifMatch ? `"${parseEtag(ifMatch)}"` : null;

    const srcAbs = join(writer.getDataRoot(), sourcePath);
    const isDirectory = existsSync(srcAbs) && statSync(srcAbs).isDirectory();

    try {
      if (isDirectory) {
        // ───── Directory move (page = folder with index.md + assets/) ─────
        const { etag, movedFiles } = await writer.moveDir(
          sourcePath,
          body.destination,
          ifMatchQuoted,
        );

        // Re-index: every moved file leaves its old FTS row behind and
        // gets a fresh one at the new path. Only re-read content for
        // files the index actually tokenizes (markdown today; extractable
        // binaries are handled by the file-watcher on next scan).
        for (const { oldRel, newRel } of movedFiles) {
          searchIndex.removePage(oldRel);
          if (newRel.endsWith(".md")) {
            try {
              const { content } = writer.read(newRel);
              searchIndex.indexPage(newRel, content, "user");
            } catch {
              // File unreadable after move — skip; next reindex will pick it up.
            }
          } else {
            searchIndex.upsertPage(newRel, detectPageType(newRel));
          }
        }

        // Broadcast one event per affected file so `useTreeStore` can
        // update its map without a full cold refresh.
        if (broadcast) {
          for (const { oldRel, newRel } of movedFiles) {
            broadcast({
              type: "tree:move",
              oldPath: oldRel,
              newPath: newRel,
              name: basename(newRel),
              fileType: detectPageType(newRel),
            });
          }
          // Directory node itself — the folder row in the sidebar.
          broadcast({
            type: "tree:move",
            oldPath: sourcePath,
            newPath: body.destination,
            name: basename(body.destination),
            fileType: "directory",
          });
        }

        return c.json({ etag });
      }

      // ───── Single-file move ─────
      const { content, etag: sourceEtag } = writer.read(sourcePath);
      const effectiveIfMatch = ifMatchQuoted ?? sourceEtag;

      const { etag } = await writer.write(body.destination, content, null);
      await writer.delete(sourcePath, effectiveIfMatch);

      searchIndex.removePage(sourcePath);
      searchIndex.indexPage(body.destination, content, "user");

      // Move the `.blocks.json` sidecar if it exists (single file only —
      // directory moves already carry the sidecar in the renameSync).
      const srcSidecar = join(writer.getDataRoot(), `${sourcePath}.blocks.json`);
      const dstSidecar = join(writer.getDataRoot(), `${body.destination}.blocks.json`);
      if (existsSync(srcSidecar)) {
        const { renameSync } = await import("node:fs");
        renameSync(srcSidecar, dstSidecar);
      }

      broadcast?.({
        type: "tree:move",
        oldPath: sourcePath,
        newPath: body.destination,
        name: basename(body.destination),
        fileType: detectPageType(body.destination),
      });

      return c.json({ etag });
    } catch (err) {
      if (err instanceof EtagMismatchError) {
        return c.json(
          { error: "Conflict", currentEtag: err.currentEtag, currentContent: err.currentContent },
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
  api.get("/:path{.+}", (c) => {
    const filePath = c.req.param("path") ?? "";
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
      return c.body(new Uint8Array(buffer));
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
  api.put("/:path{.+}", async (c) => {
    const filePath = c.req.param("path") ?? "";
    if (!filePath) {
      return c.json({ error: "Path required" }, 400);
    }

    const ext = extname(filePath).toLowerCase();
    // Binary file types must be uploaded through their dedicated routes.
    // Everything else (csv, source code, text, transcript, mermaid) is text-
    // writable through /raw.
    if (isBinaryExtension(filePath) || ext === ".md") {
      return c.json({ error: "This file type cannot be written via /raw" }, 400);
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

  // -----------------------------------------------------------------------
  // Upload binary files (docx, xlsx, pdf, images, etc.)
  // -----------------------------------------------------------------------
  api.post("/upload/:path{.+}", async (c) => {
    const filePath = c.req.param("path") ?? "";
    if (!filePath) {
      return c.json({ error: "Path required" }, 400);
    }

    const body = await c.req.arrayBuffer();
    if (!body || body.byteLength === 0) {
      return c.json({ error: "Empty body" }, 400);
    }

    try {
      const { etag } = await writer.writeBinary(filePath, new Uint8Array(body));
      return c.json({ ok: true, path: filePath, etag });
    } catch (err) {
      if (err instanceof ForbiddenError) {
        return c.json({ error: "Forbidden" }, 403);
      }
      throw err;
    }
  });

  return api;
}
