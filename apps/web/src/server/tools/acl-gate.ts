import {
  type AclOp,
  AclViolation,
  assertCanAccess,
  loadEffectiveAcl,
  parsePageAcl,
} from "../acl.js";
import type { StorageWriter } from "../storage-writer.js";
import type { ToolCallContext } from "./types.js";

/**
 * Tool-side ACL gate — Phase-9 multi-user / per-page ACLs.
 *
 * The HTTP route gate (`pages-api.ts → checkAcl`) covers human
 * traffic. Agent runs are the other half: an autonomous run that hits
 * `kb.read_page` / `kb.replace_block` etc. needs to honour the same
 * ACL rules, otherwise multi-user installs leak privileged content
 * the moment any user kicks off an agent.
 *
 * The gate threads the originating user's identity in via
 * `ToolCallContext.acl` (set by the executor from the
 * `POST /agents/:slug/run` request's session). Absent identity ->
 * runs without a user context (heartbeats, evolver cron) — the gate
 * permits, on the rationale that those runs operate in the agent's
 * persona scope rather than a user identity, and the structural
 * rails (`writable_kinds`, project egress allow-list, branch-based
 * inbox review) already constrain what they can do.
 *
 * Single-user mode (`ToolCallContext.acl` absent in the executor
 * setup) short-circuits to "permit" — no ACL parse runs.
 *
 * See [docs/04-ai-and-agents.md §The edit protocol](../../../docs/04-ai-and-agents.md)
 * and [docs/08-projects-and-isolation.md §Multi-user mode and per-page ACLs](../../../docs/08-projects-and-isolation.md).
 */

export type ToolAclResult =
  | { ok: true }
  | { ok: false; envelope: { error: string; status: 403; path: string; op: AclOp } };

/**
 * Permit or deny an `op` against `pagePath` for the run's user
 * identity. The function reads the page (via `writer.read`) and
 * inherits ACL from the closest ancestor `index.md` when the page
 * itself declares no ACL. Returns a structured envelope on deny so
 * the calling tool can return JSON the model can reason about
 * instead of throwing.
 *
 * Rules:
 *   - No `ctx.acl` (single-user / heartbeat run) → permit.
 *   - Page doesn't exist (ENOENT) → permit; the calling tool will
 *     surface its own "not found" envelope. We don't want the gate
 *     to mask a legit 404 with a 403.
 *   - Otherwise: parse ACL (with ancestor inheritance), call
 *     `assertCanAccess`. AclViolation → deny envelope.
 */
export function checkToolAcl(
  ctx: ToolCallContext,
  writer: StorageWriter,
  pagePath: string,
  op: AclOp,
): ToolAclResult {
  if (!ctx.acl) return { ok: true };

  const reader = (path: string): string | null => {
    try {
      return writer.read(path).content;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  };

  const target = reader(pagePath);
  if (target === null) return { ok: true };

  // For the page itself, parse first so a non-default own-ACL wins
  //  over any ancestor inheritance.
  const own = parsePageAcl(target);
  const acl =
    own.owner === null && own.read === null && own.write === null
      ? loadEffectiveAcl(pagePath, reader)
      : own;

  try {
    assertCanAccess(acl, ctx.acl.userId, ctx.acl.username, op);
    return { ok: true };
  } catch (err) {
    if (err instanceof AclViolation) {
      return {
        ok: false,
        envelope: {
          error: `ACL violation: user '${ctx.acl.username}' may not ${op} '${pagePath}'`,
          status: 403,
          path: pagePath,
          op,
        },
      };
    }
    throw err;
  }
}

/**
 * Check whether a user can READ each candidate page; return only the
 * permitted slice. Used by `kb.search` / `kb.global_search` to filter
 * out hits the calling user lacks read permission on. Permits in
 * single-user mode (no `ctx.acl`).
 *
 * Pages that fail to read (ENOENT, transient I/O error) are omitted
 * from the output rather than treated as denials — a stale FTS row
 * for a deleted file shouldn't surface as a search result regardless
 * of ACL.
 */
export function filterReadableForTool<T extends { path: string }>(
  ctx: ToolCallContext,
  writer: StorageWriter,
  hits: readonly T[],
): T[] {
  if (!ctx.acl) return [...hits];
  const out: T[] = [];
  for (const hit of hits) {
    const result = checkToolAcl(ctx, writer, hit.path, "read");
    if (result.ok) out.push(hit);
  }
  return out;
}

/**
 * Permit-or-deny `kb.create_page`: the target page doesn't exist yet,
 * so the gate inspects the closest ancestor `index.md`'s ACL instead.
 * If no ancestor declares an ACL, the default (write = owner-only)
 * applies — a brand-new page in a vault with no ancestor `index.md`
 * is created freely (the user becomes the page's owner on first
 * write via `stampOwner` upstream in pages-api / kb-create-page).
 *
 * `parent` is the directory the new page lands in (the `parent` arg
 * to `kb.create_page`). Empty string = vault root.
 */
export function checkToolAclForCreate(
  ctx: ToolCallContext,
  writer: StorageWriter,
  parent: string,
): ToolAclResult {
  if (!ctx.acl) return { ok: true };

  const reader = (path: string): string | null => {
    try {
      return writer.read(path).content;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  };

  // Walk parent chain looking for an `index.md` with a non-default
  //  ACL. We synthesize a "phantom child" path so `loadEffectiveAcl`
  //  starts from the parent dir; the fake basename never matches an
  //  existing file, so the helper proceeds to the inheritance walk.
  const phantom = parent === "" ? "__new__.md" : `${parent}/__new__.md`;
  const acl = loadEffectiveAcl(phantom, reader);

  // Default ACL on a brand-new page: read=everyone, write=owner-only.
  // For create, treat a fully-default ancestor chain as "permit" —
  // the page hasn't been written yet, so there's no owner to compare
  // against, and the user is about to become it. Once we have a
  // non-default ancestor ACL, run the standard write check.
  if (acl.owner === null && acl.read === null && acl.write === null) {
    return { ok: true };
  }

  try {
    assertCanAccess(acl, ctx.acl.userId, ctx.acl.username, "write");
    return { ok: true };
  } catch (err) {
    if (err instanceof AclViolation) {
      return {
        ok: false,
        envelope: {
          error: `ACL violation: user '${ctx.acl.username}' may not create pages under '${parent || "/"}'`,
          status: 403,
          path: parent,
          op: "write",
        },
      };
    }
    throw err;
  }
}
