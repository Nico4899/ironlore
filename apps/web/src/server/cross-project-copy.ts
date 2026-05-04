import { existsSync, readFileSync } from "node:fs";
import { join as pathJoin, posix } from "node:path";
import { Hono } from "hono";
import { simpleGit } from "simple-git";
import { loadProjectConfig } from "./fetch-for-project.js";
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
  /**
   * Per-asset copy outcomes (per docs/08 §Cross-project copy workflow
   * #5: "Same rename-or-skip conflict flow applies to each asset").
   * Empty when the page references no assets. `renamed` mirrors the
   * page's collision flow.
   */
  assets: Array<{ srcPath: string; targetPath: string; renamed: boolean; skipped?: boolean }>;
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

    // Promotion allow-list gate (per docs/08 §Cross-project copy
    //  workflow + §Promotion: the only crossing point). The target's
    //  `accept_promotions_from` lists which sources may copy IN.
    //  Absent field = backwards-compat allow-from-anywhere; present
    //  field is enforced strictly. Refusing here is the server-side
    //  half of the modal's filtered picker — defense-in-depth so a
    //  raw curl can't bypass the UI.
    try {
      const dstCfg = loadProjectConfig(dst.projectDir);
      if (dstCfg.accept_promotions_from !== undefined && !dstCfg.accept_promotions_from.includes(srcId)) {
        return c.json(
          {
            error: `Project '${body.targetProjectId}' does not accept promotions from '${srcId}'`,
            acceptPromotionsFrom: dstCfg.accept_promotions_from,
          },
          403,
        );
      }
    } catch {
      // Missing / malformed project.yaml on the destination → no
      //  allow-list to enforce; fall through (backwards-compat).
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

      // Walk the page's markdown for `![alt](path)` image references
      //  and copy each binary asset alongside the page (per docs/08
      //  §Cross-project copy workflow #5). Same rename/overwrite
      //  conflict flow applies per asset; failures are non-fatal
      //  (the page is already in the destination — surface them in
      //  the response so the user can investigate). Asset paths are
      //  resolved relative to the SOURCE page's directory.
      const assets = await copyReferencedAssets({
        srcServices: src,
        dstServices: dst,
        srcPagePath: srcPath,
        srcMarkdown: sourceRead.content,
        dstPagePath: finalPath,
        onConflict,
      });

      // Audit trail (per docs/08 §Cross-project copy workflow #6):
      //  the source repo gets a content-free `copy to <dst>` commit
      //  so `git log` reads the full crossing trail without having
      //  to cross-reference projects. Failure here is non-fatal —
      //  the destination write already succeeded; we just log a
      //  warning so the operator can investigate.
      try {
        await writeSourceAuditCommit({
          srcDir: src.projectDir,
          srcPath,
          targetProjectId: body.targetProjectId,
          targetPath: finalPath,
        });
      } catch (err) {
        console.warn(
          `[cross-project-copy] source audit commit failed for ${srcId}/${srcPath}:`,
          err instanceof Error ? err.message : String(err),
        );
      }

      const resp: CopyResponse = {
        targetProjectId: body.targetProjectId,
        targetPath: finalPath,
        etag: result.etag,
        renamed,
        assets,
      };
      return c.json(resp);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  return api;
}

/**
 * Extract every `![alt](path)` image reference from a markdown blob.
 * Skips absolute URLs (http://, https://, data:) — only relative
 * paths get resolved against the source vault. Duplicate paths are
 * collapsed (a page citing the same asset twice copies it once).
 */
function extractMarkdownAssetRefs(markdown: string): string[] {
  const out = new Set<string>();
  // Match `![...](path)` — the path is anything that isn't a closing
  //  paren or whitespace. The capturing group strips title attrs
  //  (`...](path "title")`) by stopping at the first space.
  const re = /!\[[^\]]*\]\(([^)\s]+)/g;
  let match: RegExpExecArray | null = re.exec(markdown);
  while (match !== null) {
    const ref = match[1];
    if (ref) out.add(ref);
    match = re.exec(markdown);
  }
  return [...out].filter((ref) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return false; // http://, https://, data:, etc.
    if (ref.startsWith("//")) return false; // protocol-relative
    if (ref.startsWith("#")) return false; // fragment-only
    return true;
  });
}

/**
 * Copy every binary asset referenced by the source page into the
 * destination project. Asset paths are resolved relative to the
 * source page's directory in BOTH projects so the resulting
 * destination layout mirrors the source (a page that references
 * `assets/foo.png` lands with `<dst>/assets/foo.png` populated).
 *
 * Each asset is read with `node:fs` (assets bypass the source's
 * StorageWriter — they're already on disk and we don't want to load
 * binary contents through a markdown-shaped reader) and written
 * through the destination's `writer.writeBinary`. Conflicts honour
 * the same `onConflict` strategy the page uses; rename appends
 * `-copy` / `-copy-2` suffixes to the basename.
 */
async function copyReferencedAssets(params: {
  srcServices: ProjectServices;
  dstServices: ProjectServices;
  srcPagePath: string;
  srcMarkdown: string;
  dstPagePath: string;
  onConflict: "rename" | "overwrite";
}): Promise<CopyResponse["assets"]> {
  const refs = extractMarkdownAssetRefs(params.srcMarkdown);
  if (refs.length === 0) return [];

  const srcDataRoot = params.srcServices.writer.getDataRoot();
  const srcPageDir = posix.dirname(params.srcPagePath);
  const dstPageDir = posix.dirname(params.dstPagePath);

  const out: CopyResponse["assets"] = [];

  for (const ref of refs) {
    // Resolve the source asset path relative to the page directory.
    //  Use posix joins so the relative path stays portable even on
    //  Windows checkouts.
    const srcRelPath = posix.normalize(posix.join(srcPageDir, ref));
    if (srcRelPath.startsWith("..")) {
      // Path escapes the data root — refuse and skip rather than
      //  silently leaking out-of-tree files.
      out.push({ srcPath: ref, targetPath: "", renamed: false, skipped: true });
      continue;
    }
    const srcAbsPath = pathJoin(srcDataRoot, srcRelPath);
    if (!existsSync(srcAbsPath)) {
      // Broken reference — flag it but don't fail the page copy.
      out.push({ srcPath: srcRelPath, targetPath: "", renamed: false, skipped: true });
      continue;
    }

    let bytes: Buffer;
    try {
      bytes = readFileSync(srcAbsPath);
    } catch {
      out.push({ srcPath: srcRelPath, targetPath: "", renamed: false, skipped: true });
      continue;
    }

    // Destination path: same basename, mirrored under the destination
    //  page's directory. Conflict handling per the spec uses the
    //  same `-copy` suffix algorithm the page uses.
    const desiredAssetPath = posix.normalize(posix.join(dstPageDir, ref));
    const { finalPath: assetFinal, renamed: assetRenamed } = resolveAssetCollision(
      params.dstServices,
      desiredAssetPath,
      params.onConflict,
    );
    try {
      await params.dstServices.writer.writeBinary(assetFinal, bytes);
      out.push({ srcPath: srcRelPath, targetPath: assetFinal, renamed: assetRenamed });
    } catch {
      out.push({ srcPath: srcRelPath, targetPath: assetFinal, renamed: assetRenamed, skipped: true });
    }
  }

  return out;
}

/**
 * Like `resolveCollision` for pages, but for binary assets — same
 * `-copy` / `-copy-N` rename algorithm + `existsSync` probe through
 * the destination's data root. We use the writer's ENOENT-on-read
 * via `safeReadBinaryEtag` to mirror the page path's collision
 * detection.
 */
function resolveAssetCollision(
  dst: ProjectServices,
  desiredPath: string,
  onConflict: "rename" | "overwrite",
): { finalPath: string; renamed: boolean } {
  if (onConflict === "overwrite") {
    return { finalPath: desiredPath, renamed: false };
  }
  const dataRoot = dst.writer.getDataRoot();
  if (!existsSync(pathJoin(dataRoot, desiredPath))) {
    return { finalPath: desiredPath, renamed: false };
  }
  const dot = desiredPath.lastIndexOf(".");
  const stem = dot === -1 ? desiredPath : desiredPath.slice(0, dot);
  const ext = dot === -1 ? "" : desiredPath.slice(dot);
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem}-copy${i === 1 ? "" : `-${i}`}${ext}`;
    if (!existsSync(pathJoin(dataRoot, candidate))) {
      return { finalPath: candidate, renamed: true };
    }
  }
  throw new Error("Too many colliding assets — clean the target manually");
}

/**
 * Stamp an empty (content-free) commit on the source repo so the
 * crossing is auditable from either side of the boundary. The
 * commit message follows the spec's `copy to <dst>/<dst-path>`
 * convention so `git log --grep="^copy to"` reveals every promotion
 * out of the project.
 *
 * `--allow-empty` is required: by definition a `copy to` commit
 * makes no on-disk change to the source; the commit IS the audit
 * artifact. Authored as the calling user (we don't have a session
 * here yet — falls back to git's configured user.email; multi-user
 * attribution is a Phase-9 follow-up).
 */
async function writeSourceAuditCommit(params: {
  srcDir: string;
  srcPath: string;
  targetProjectId: string;
  targetPath: string;
}): Promise<void> {
  const git = simpleGit(params.srcDir);
  await git.commit(`copy to ${params.targetProjectId}/${params.targetPath}`, [], {
    "--allow-empty": null,
  });
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
