import { existsSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { WsEventInput } from "@ironlore/core";
import { detectPageType, isBinaryExtension, ulid } from "@ironlore/core";
import { ForbiddenError, parseEtag } from "@ironlore/core/server";
import { createPatch } from "diff";
import { Hono } from "hono";
import {
  type AclOp,
  AclViolation,
  AclWideningError,
  assertCanAccess,
  assertNoAclWidening,
  loadEffectiveAcl,
  parsePageAcl,
  stampOwner,
} from "./acl.js";
import { assignBlockIds, parseBlocks, readBlocksSidecar, writeBlocksSidecar } from "./block-ids.js";
import { computePageBlockTrust } from "./block-trust.js";
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

/**
 * Per-project options threaded into the pages API. `mode` controls
 * whether ACL parsing + checks run; `single-user` (default) skips
 * the ACL path entirely so the existing single-user install pays
 * no extra cost.
 */
export interface PagesApiOptions {
  mode?: "single-user" | "multi-user";
}

/**
 * Read the calling user's identity from the auth middleware. The
 * middleware sets `userId` + `username` on the Hono context for
 * every authenticated request. Routes that hit ACL checks should
 * call this rather than reading the keys directly so future
 * additions (role, email, etc.) live in one place.
 */
function authedUser(c: { get: (key: string) => unknown }): {
  userId: string;
  username: string;
} {
  return {
    userId: (c.get("userId") as string | undefined) ?? "",
    username: (c.get("username") as string | undefined) ?? "",
  };
}

/**
 * Run the ACL gate for `op` against the page's current content.
 * No-op in single-user mode. Returns null on permit, a Hono Response
 * on deny — caller returns the response unchanged.
 */
function checkAcl(
  c: { json: (body: unknown, status?: number) => Response; get: (key: string) => unknown },
  mode: "single-user" | "multi-user",
  content: string,
  op: AclOp,
): Response | null {
  if (mode === "single-user") return null;
  const { userId, username } = authedUser(c);
  try {
    assertCanAccess(parsePageAcl(content), userId, username, op);
    return null;
  } catch (err) {
    if (err instanceof AclViolation) {
      return c.json({ error: err.message }, 403);
    }
    throw err;
  }
}

export function createPagesApi(
  writer: StorageWriter,
  searchIndex: SearchIndex,
  broadcast?: BroadcastFn,
  opts: PagesApiOptions = {},
): Hono {
  const api = new Hono();
  const mode = opts.mode ?? "single-user";

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
    // `.agents/` is reserved — every installed persona lives under
    //  it and nuking the whole tree would cascade-delete the user's
    //  entire agent roster. Individual `.agents/<slug>/` subfolders
    //  stay deletable (that's how you uninstall an agent). Enforced
    //  server-side as defense-in-depth on top of the client-side
    //  guard in SidebarNew.
    if (dirPath === ".agents") {
      return c.json({ error: "The .agents folder is reserved and cannot be deleted." }, 403);
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
  // Save an AI-panel conversation reply as a `kind: wiki` page —
  // Phase-11 query-to-wiki workflow (A.6.2).
  //
  // Body: { title: string, markdown: string, parent?: string,
  //         sourceIds?: string[] }
  //
  // The user is in the AI panel, the agent has just produced a
  // useful reply, the user clicks "Save as wiki page". This endpoint
  // creates a new `kind: wiki` page populated with the agent's
  // text + frontmatter `source_ids` so the trust-score pipeline
  // can later evaluate the citation chain (per Principle 5a +
  // [docs/04-ai-and-agents.md §Trust score](../../../docs/04-ai-and-agents.md)).
  //
  // Mounted before the generic `/:path{.+}` GET so Hono's prefix
  // match picks it first — same pattern the `/folders/...` and
  // `/provenance/...` routes use.
  // -----------------------------------------------------------------------
  api.post("/from-conversation", async (c) => {
    const body = await c.req.json<{
      title: string;
      markdown: string;
      parent?: string;
      sourceIds?: string[];
    }>();
    const { title, markdown, parent, sourceIds } = body;
    if (!title || !markdown) {
      return c.json({ error: "title and markdown required" }, 400);
    }

    const id = ulid();
    const now = new Date().toISOString();
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
    if (!slug) {
      return c.json({ error: "title produced an empty slug" }, 400);
    }
    const dir = (parent ?? "wiki").replace(/^\/+|\/+$/g, "");
    const path = dir ? `${dir}/${slug}.md` : `${slug}.md`;

    // Frontmatter — flow-style `source_ids` so the YAML stays one
    // line per array. Empty `sourceIds` is permitted (the user
    // saved a reply that didn't cite anything); the lint pipeline
    // will flag it as a provenance gap on the next run.
    const ids = Array.isArray(sourceIds) ? sourceIds.filter((s) => typeof s === "string") : [];
    const frontmatterLines = [
      "---",
      "schema: 1",
      `id: ${id}`,
      `title: ${title}`,
      "kind: wiki",
      `created: ${now}`,
      `modified: ${now}`,
      ids.length > 0 ? `source_ids: [${ids.join(", ")}]` : null,
      "---",
    ].filter(Boolean);
    const content = `${frontmatterLines.join("\n")}\n\n# ${title}\n\n${markdown}\n`;

    // Slug-collision check — the writer's `null`-etag write path
    // is "create or overwrite," but Save-as-wiki should never
    // overwrite. Pre-flight read: if the file exists, surface a
    // 409 so the client can disambiguate the title.
    try {
      writer.read(path);
      return c.json({ error: `A page already exists at ${path}` }, 409);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        if (err instanceof ForbiddenError) {
          return c.json({ error: "Forbidden" }, 403);
        }
        throw err;
      }
      // ENOENT — the slug is free, proceed to write.
    }

    try {
      const denied = checkAcl(c, mode, content, "write");
      if (denied) return denied;
      const { etag } = await writer.write(path, content, null, "user");
      searchIndex.indexPage(path, content, "user");
      broadcast?.({
        type: "tree:add",
        path,
        name: basename(path),
        fileType: "markdown",
      });
      return c.json({ ok: true, id, path, etag });
    } catch (err) {
      if (err instanceof ForbiddenError) {
        return c.json({ error: "Forbidden" }, 403);
      }
      throw err;
    }
  });

  // -----------------------------------------------------------------------
  // Read block-level provenance + trust for a page (Phase-11 A.3.x).
  //
  // Returns the persisted `.blocks.json` sidecar's per-block `agent`,
  // `compiled_at`, `derived_from` plus a server-computed trust state
  // (`fresh | stale | unverified`) for the "show your work"
  // affordance. Mounted before the generic `/:path{.+}` GET so Hono's
  // prefix match picks it first — same pattern the `/folders/...`
  // routes use.
  //
  // Trust score is derived at read time per
  // [docs/04-ai-and-agents.md §Trust score](../../../docs/04-ai-and-agents.md);
  // no `trust_score` column anywhere. The endpoint is read-only and
  // honors the same ACL gate as `GET /:path` so a user that can read
  // the page can read its provenance.
  // -----------------------------------------------------------------------
  api.get("/provenance/:path{.+}", (c) => {
    const pagePath = c.req.param("path") ?? "";
    if (!pagePath) return c.json({ error: "Path required" }, 400);
    try {
      const { content } = writer.read(pagePath);
      const denied = checkAcl(c, mode, content, "read");
      if (denied) return denied;
      const sidecar = readBlocksSidecar(join(writer.getDataRoot(), pagePath));
      if (!sidecar) {
        // No provenance to surface — page is fully human-written or
        // hasn't yet been touched by an agent. Empty array, not 404.
        return c.json({ blocks: [] });
      }
      const trust = computePageBlockTrust(writer.getDataRoot(), pagePath);
      const blocks = sidecar.blocks
        .filter((b) => b.agent !== undefined)
        .map((b) => ({
          id: b.id,
          agent: b.agent ?? null,
          compiledAt: b.compiled_at ?? null,
          derivedFrom: b.derived_from ?? [],
          trust: trust.get(b.id) ?? null,
        }));
      return c.json({ blocks });
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
  // Read a page
  // -----------------------------------------------------------------------
  api.get("/:path{.+}", (c) => {
    const pagePath = c.req.param("path") ?? "";
    if (!pagePath) {
      return c.json({ error: "Path required" }, 400);
    }

    try {
      const { content, etag } = writer.read(pagePath);
      const denied = checkAcl(c, mode, content, "read");
      if (denied) return denied;
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
    let { markdown: annotated, blocks } = assignBlockIds(body.markdown);

    try {
      const parsedIfMatch = ifMatch ? parseEtag(ifMatch) : null;
      // Re-wrap for comparison: computeEtag returns quoted
      const ifMatchQuoted = parsedIfMatch ? `"${parsedIfMatch}"` : null;

      const absPath = join(writer.getDataRoot(), pagePath);
      const isNew = !existsSync(absPath);

      // ACL check on existing pages — single-user mode is a no-op.
      // For new pages there's nothing on disk to check; the caller
      // becomes the owner via `stampOwner` below.
      if (!isNew) {
        const { content: existing } = writer.read(pagePath);
        const denied = checkAcl(c, mode, existing, "write");
        if (denied) return denied;
      }

      // First write of a multi-user page: stamp the caller as the
      // page's owner so subsequent ACL evaluations resolve `owner`
      // against them. Existing-owner pages are left untouched (no
      // hijacking).
      if (mode === "multi-user") {
        const { userId } = authedUser(c);
        if (userId) {
          const stamped = stampOwner(annotated, userId);
          if (stamped !== annotated) {
            annotated = stamped;
            blocks = assignBlockIds(stamped).blocks;
          }
        }

        // ACL widening guard (docs/08-projects-and-isolation.md
        //  §Multi-user mode #6): a leaf page whose declared `acl:`
        //  block grants more access than its ancestor `index.md`
        //  ACL is rejected at the route boundary. Default-ACL pages
        //  fall through (inheritance handles them via
        //  `loadEffectiveAcl`); pages without ancestors with a
        //  non-default ACL fall through too.
        try {
          const newAcl = parsePageAcl(annotated);
          const reader = (path: string): string | null => {
            if (path === pagePath) return null; // don't inherit from self
            try {
              return writer.read(path).content;
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
              throw err;
            }
          };
          const ancestor = loadEffectiveAcl(pagePath, reader);
          assertNoAclWidening(newAcl, ancestor);
        } catch (err) {
          if (err instanceof AclWideningError) {
            return c.json({ error: err.message, op: err.op }, 403);
          }
          throw err;
        }
      }

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

      // ACL gate — only when the page exists + is markdown (binary
      // files have no frontmatter, so ACL is N/A). Read first to
      // grab the content for the parse.
      if (mode === "multi-user" && extname(pagePath).toLowerCase() === ".md") {
        try {
          const { content: existing } = writer.read(pagePath);
          const denied = checkAcl(c, mode, existing, "write");
          if (denied) return denied;
        } catch {
          // ENOENT on a delete is benign — the writer.delete call
          // below will surface the right error.
        }
      }

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

    // ACL gate — moves are write operations against the source page.
    // Only the source-side ACL applies; if the destination already
    // exists at the target path the writer.move call will reject
    // anyway. Single-user mode skips the parse.
    if (mode === "multi-user" && !isDirectory && extname(sourcePath).toLowerCase() === ".md") {
      try {
        const { content: existing } = writer.read(sourcePath);
        const denied = checkAcl(c, mode, existing, "write");
        if (denied) return denied;
      } catch {
        // Source missing — let the move call surface the error.
      }
    }

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

      // Count distinct pages that link to the old path under any of
      //  the spellings users commonly use (`<path>`, `<path-no-ext>`,
      //  `<basename>`). Drives the "Update N inbound links?" prompt
      //  in the sidebar — docs/03-editor.md §Rename-rewrite.
      const inboundLinkCount = countInboundLinks(searchIndex, sourcePath);

      return c.json({ etag, inboundLinkCount });
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

  // -----------------------------------------------------------------------
  // Rewrite inbound `[[OldName]]` references after a rename
  //
  // Body: `{ oldPath: string; newPath: string }` — both project-relative
  // markdown paths. The endpoint walks every page that linked to any
  // spelling of `oldPath` (full path / no-ext / basename), rewrites
  // each occurrence to the corresponding `newPath` spelling, and
  // commits one StorageWriter.write per affected source. Backlinks
  // and FTS5 are reindexed inline so subsequent searches see the
  // updated outgoing-link table.
  //
  // Returns `{ updated: number }` — count of source pages actually
  // rewritten (a page that only used a spelling whose old/new value
  // is identical produces no diff and isn't counted).
  //
  // Per docs/03-editor.md §Rename-rewrite: "the only automated
  // cross-page write in Ironlore; always user-initiated, never
  // silent."
  // -----------------------------------------------------------------------
  api.post("/rewrite-backlinks", async (c) => {
    const body = await c.req.json<{ oldPath: string; newPath: string }>();
    if (!body.oldPath || !body.newPath) {
      return c.json({ error: "oldPath and newPath required" }, 400);
    }

    const pairs = linkRewritePairs(body.oldPath, body.newPath);
    if (pairs.length === 0) {
      return c.json({ updated: 0 });
    }

    // Collect distinct source pages by the union of every spelling's
    //  inbound-link list. A page that links via multiple spellings
    //  still gets one rewrite pass that handles all spellings at once.
    const sources = new Set<string>();
    for (const [oldT] of pairs) {
      for (const bl of searchIndex.getBacklinks(oldT)) sources.add(bl.sourcePath);
    }

    let updated = 0;
    for (const sourcePath of sources) {
      let content: string;
      let etag: string;
      try {
        ({ content, etag } = writer.read(sourcePath));
      } catch {
        continue;
      }
      let next = content;
      for (const [oldT, newT] of pairs) {
        // Replace `[[oldT]]`, `[[oldT|display]]`, `[[oldT#blk_X]]`,
        //  `[[oldT#blk_X|display]]`. Anchored on `[[`/`]]` so we never
        //  match user prose that happens to contain the spelling.
        const escaped = oldT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`\\[\\[${escaped}((?:#[^|\\]]*)?(?:\\|[^\\]]*)?)\\]\\]`, "g");
        next = next.replace(re, (_, suffix) => `[[${newT}${suffix}]]`);
      }
      if (next === content) continue;

      try {
        const { etag: newEtag } = await writer.write(sourcePath, next, etag);
        searchIndex.indexPage(sourcePath, next, "user");
        broadcast?.({
          type: "tree:update",
          path: sourcePath,
          etag: newEtag,
        });
        updated++;
      } catch {
        // Page raced with another writer — skip; the backlinks table
        //  still has the stale spelling, and the user can re-trigger
        //  the rewrite manually via a future "rewrite links" action.
      }
    }

    return c.json({ updated });
  });

  return api;
}

/**
 * The three spellings a user commonly types for a wiki-link target —
 * mirrors the `linkTargetCandidates` helper inside `search-index.ts`.
 * Inlined here to avoid widening that file's exported surface for a
 * single caller.
 */
function linkSpellings(p: string): { full: string; noExt: string; basename: string } {
  const noExt = p.replace(/\.md$/, "");
  const slash = noExt.lastIndexOf("/");
  const base = slash === -1 ? noExt : noExt.slice(slash + 1);
  return { full: p, noExt, basename: base };
}

/**
 * Build the (old → new) spelling pairs the rewrite endpoint applies
 * to every affected source page. Drops pairs whose old and new
 * spellings are identical — those are no-ops and would otherwise
 * pollute the regex pass without changing anything.
 */
function linkRewritePairs(oldPath: string, newPath: string): Array<[string, string]> {
  const o = linkSpellings(oldPath);
  const n = linkSpellings(newPath);
  return (
    [
      [o.full, n.full],
      [o.noExt, n.noExt],
      [o.basename, n.basename],
    ] as Array<[string, string]>
  ).filter(([a, b]) => a !== b);
}

/**
 * Count distinct source pages that link to `oldPath` under any of
 * the three common spellings. Surfaced on rename responses so the
 * client can decide whether to prompt the user with "Update N
 * inbound links?".
 */
function countInboundLinks(searchIndex: SearchIndex, oldPath: string): number {
  const { full, noExt, basename: base } = linkSpellings(oldPath);
  const sources = new Set<string>();
  for (const cand of [full, noExt, base]) {
    for (const bl of searchIndex.getBacklinks(cand)) sources.add(bl.sourcePath);
  }
  return sources.size;
}

/**
 * Create raw file serving API for non-markdown content.
 *
 * Routes:
 *   GET  /raw/*path → raw file bytes with correct Content-Type
 *   PUT  /raw/*path ← raw text body (CSV only) → 200 { etag } | 409
 */
export function createRawApi(writer: StorageWriter, dataRoot: string): Hono {
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
  // Legacy single-file endpoint: takes raw body at POST /raw/upload/:path.
  // Newly routed through the Phase-8 pipeline so it gets size limits,
  // MIME sniffing, extension allowlist, and image re-encoding. Callers
  // should migrate to POST /api/projects/:id/uploads (multipart).
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

    const { processUpload, UploadRejectedError } = await import("./uploads.js");
    const { basename: pathBasename, dirname: pathDirname } = await import("node:path");
    const normalizedPath = filePath.replace(/^\/+/, "");
    const filename = pathBasename(normalizedPath);
    const targetDir = pathDirname(normalizedPath);
    const declaredMime = c.req.header("content-type") ?? "application/octet-stream";

    try {
      const result = await processUpload(
        filename,
        declaredMime,
        Buffer.from(body),
        writer,
        dataRoot,
        { targetDir: targetDir === "." ? "" : targetDir },
      );
      return c.json({
        ok: true,
        path: result.path,
        etag: result.etag,
        reencoded: result.reencoded,
      });
    } catch (err) {
      if (err instanceof UploadRejectedError) {
        return c.json({ error: err.message, code: err.code }, err.httpStatus as 400 | 413);
      }
      if (err instanceof ForbiddenError) {
        return c.json({ error: "Forbidden" }, 403);
      }
      throw err;
    }
  });

  return api;
}
