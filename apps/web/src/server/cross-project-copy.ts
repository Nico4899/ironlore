import { Hono } from "hono";
import type { ProjectServices } from "./project-services.js";

/**
 * Cross-project copy endpoint (docs/08-projects-and-isolation.md
 * §Cross-project copy workflow).
 *
 * One HTTP route:
 *   POST /api/projects/:srcId/pages/:srcPath{.+}/copy-to
 *   body: { targetProjectId: string; targetPath?: string; onConflict?: "rename" | "overwrite" }
 *
 * The crossing is deliberately one human keystroke: the server reads
 * the source through its own StorageWriter, stamps a `copied_from`
 * frontmatter line with the source commit SHA, and writes through the
 * TARGET project's StorageWriter so locks, ETags, and git commits live
 * in the target's history — not the source's.
 *
 * Wiki-links are NOT rewritten on copy (§Link rewriting). Silently
 * translating `[[Target]]` into target-project URLs would mask broken
 * references; users see the broken-link indicator and decide.
 *
 * Binary asset copying is deferred to a follow-up; the spec describes
 * it but single-page copy is the shipping 1.0 cut — the modal
 * surfaces what's missing rather than silently failing.
 */
export interface CrossProjectCopyOptions {
  resolveProject: (projectId: string) => ProjectServices | null;
}

interface CopyRequestBody {
  targetProjectId?: string;
  targetPath?: string;
  onConflict?: "rename" | "overwrite";
}

interface CopyResponse {
  targetProjectId: string;
  targetPath: string;
  etag: string;
  renamed: boolean;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function createCrossProjectCopyApi(options: CrossProjectCopyOptions): Hono {
  const api = new Hono();

  api.post("/:srcId/pages/:srcPath{.+}/copy-to", async (c) => {
    const srcId = c.req.param("srcId") ?? "";
    const srcPath = c.req.param("srcPath") ?? "";
    if (!srcId || !srcPath) return c.json({ error: "Source project + path required" }, 400);

    const src = options.resolveProject(srcId);
    if (!src) return c.json({ error: `Unknown source project '${srcId}'` }, 404);

    let body: CopyRequestBody;
    try {
      body = await c.req.json<CopyRequestBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.targetProjectId) return c.json({ error: "targetProjectId required" }, 400);
    if (body.targetProjectId === srcId) {
      return c.json({ error: "Source and target project must differ" }, 400);
    }
    const dst = options.resolveProject(body.targetProjectId);
    if (!dst) {
      return c.json({ error: `Unknown target project '${body.targetProjectId}'` }, 404);
    }

    // Read source page. Only markdown pages are supported in 1.0 — the
    //  modal restricts to `.md`; defense-in-depth here.
    if (!srcPath.endsWith(".md")) {
      return c.json({ error: "Only .md pages are supported today" }, 400);
    }

    let sourceRead: { content: string; etag: string };
    try {
      sourceRead = src.writer.read(srcPath);
    } catch {
      return c.json({ error: `Source page '${srcPath}' not found` }, 404);
    }

    // Pull the source commit SHA so the stamp is a durable reference
    //  (not a content hash that changes next time anyone edits).
    const sourceSha = readHeadSha(src.projectDir);
    const stamped = stampProvenance(sourceRead.content, {
      srcProject: srcId,
      srcPath,
      sourceSha,
    });

    // Resolve target path + collision strategy.
    const desiredPath = (body.targetPath ?? srcPath).replace(/^\/+/, "");
    const onConflict = body.onConflict ?? "rename";
    const { finalPath, renamed } = resolveCollision(dst, desiredPath, onConflict);

    if (onConflict !== "rename" && onConflict !== "overwrite") {
      return c.json({ error: "onConflict must be 'rename' or 'overwrite'" }, 400);
    }

    // Write through the target's StorageWriter so locks + ETag are
    //  owned by the target project. Overwrite mode still respects the
    //  existing etag to avoid clobbering a concurrent edit.
    try {
      let result: { etag: string };
      if (onConflict === "overwrite" && finalPath === desiredPath) {
        const existing = safeRead(dst, finalPath);
        result = await dst.writer.write(finalPath, stamped, existing?.etag ?? null);
      } else {
        result = await dst.writer.write(finalPath, stamped, null);
      }
      const resp: CopyResponse = {
        targetProjectId: body.targetProjectId,
        targetPath: finalPath,
        etag: result.etag,
        renamed,
      };
      return c.json(resp);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  return api;
}

/** Read HEAD commit SHA for the project. Returns null on any error. */
function readHeadSha(projectDir: string): string | null {
  try {
    // Minimal git plumbing — read `.git/HEAD` and follow to the ref.
    //  We deliberately avoid spawning git for a single SHA lookup.
    const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const headPath = join(projectDir, ".git", "HEAD");
    if (!existsSync(headPath)) return null;
    const head = readFileSync(headPath, "utf-8").trim();
    if (head.startsWith("ref: ")) {
      const refPath = join(projectDir, ".git", head.slice(5));
      if (!existsSync(refPath)) return null;
      return readFileSync(refPath, "utf-8").trim();
    }
    return head;
  } catch {
    return null;
  }
}

/**
 * Stamp `copied_from: <src>/<path>@<sha>` onto a markdown page's
 * frontmatter. If the page has no frontmatter block, prepend one.
 */
export function stampProvenance(
  markdown: string,
  params: { srcProject: string; srcPath: string; sourceSha: string | null },
): string {
  const tag = `copied_from: ${params.srcProject}/${params.srcPath}${
    params.sourceSha ? `@${params.sourceSha}` : ""
  }`;

  const match = FRONTMATTER_RE.exec(markdown);
  if (match) {
    const existing = match[1] ?? "";
    const body = markdown.slice(match[0].length);
    // Strip any pre-existing `copied_from:` line so re-copies don't
    //  stack stamps.
    const cleaned = existing.replace(/^copied_from:[^\n]*\n?/m, "").trimEnd();
    const nextFrontmatter = cleaned ? `${cleaned}\n${tag}` : tag;
    return `---\n${nextFrontmatter}\n---\n${body}`;
  }
  return `---\n${tag}\n---\n\n${markdown}`;
}

function safeRead(dst: ProjectServices, path: string): { etag: string } | null {
  try {
    return dst.writer.read(path);
  } catch {
    return null;
  }
}

function resolveCollision(
  dst: ProjectServices,
  desiredPath: string,
  onConflict: "rename" | "overwrite",
): { finalPath: string; renamed: boolean } {
  if (onConflict === "overwrite") {
    return { finalPath: desiredPath, renamed: false };
  }
  // Rename mode. Try the original path first — if it's free, use it.
  if (!safeRead(dst, desiredPath)) {
    return { finalPath: desiredPath, renamed: false };
  }
  const dot = desiredPath.lastIndexOf(".");
  const stem = dot === -1 ? desiredPath : desiredPath.slice(0, dot);
  const ext = dot === -1 ? "" : desiredPath.slice(dot);
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem}-copy${i === 1 ? "" : `-${i}`}${ext}`;
    if (!safeRead(dst, candidate)) {
      return { finalPath: candidate, renamed: true };
    }
  }
  throw new Error("Too many colliding copies — rename target manually");
}
