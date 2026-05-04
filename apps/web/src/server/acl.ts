/**
 * Per-page ACL parser + gate for multi-user mode.
 *
 * docs/08-projects-and-isolation.md §Multi-user mode and per-page
 * ACLs is the spec source of truth. This module implements the
 * parse-and-check half — the wiring into HTTP routes lives in
 * `pages-api.ts`.
 *
 * Frontmatter shape:
 *
 *     ---
 *     id: ...
 *     owner: <userId>          # stamped by kb.create_page / first PUT
 *     acl:
 *       read:  [alice, everyone]
 *       write: [alice, owner]
 *     ---
 *
 * Defaults when `acl:` is absent: `read: [everyone], write: [owner]`.
 * Single-user installs (`project.yaml mode: single-user`) skip the
 * parse + check entirely — there's only one user, so every gate
 * trivially passes.
 *
 * The format intentionally lets users write `everyone` and `owner`
 * as identifiers. Everything else is a literal username.
 */

export type AclOp = "read" | "write";

export interface PageAcl {
  /** Owner user ID, stamped on first write (or `null` if untouched). */
  owner: string | null;
  /** Read allow-list; `null` means default (= everyone). */
  read: string[] | null;
  /** Write allow-list; `null` means default (= owner only). */
  write: string[] | null;
}

export const ACL_DEFAULT: PageAcl = { owner: null, read: null, write: null };

export class AclViolation extends Error {
  readonly status = 403 as const;
  constructor(
    readonly op: AclOp,
    readonly username: string,
  ) {
    super(`ACL violation: user '${username}' may not ${op} this page`);
    this.name = "AclViolation";
  }
}

/**
 * Pull the relevant ACL fields from a markdown page's frontmatter.
 *
 * Implementation: hand-rolled regex walk over the YAML block. We
 * already use this style for `extractPageKind` and the
 * writable-kinds-gate persona reader — pulling in a full YAML
 * parser per request would be overkill for a four-key lookup.
 *
 * Returns `ACL_DEFAULT` (all-null) when the page has no frontmatter
 * or no relevant fields. Callers treat that as "use defaults."
 */
export function parsePageAcl(markdown: string): PageAcl {
  if (!markdown.startsWith("---")) return { ...ACL_DEFAULT };
  const endIdx = markdown.indexOf("\n---", 3);
  if (endIdx === -1) return { ...ACL_DEFAULT };
  const fm = markdown.slice(4, endIdx);

  const owner = matchScalar(fm, "owner");
  const aclBlock = extractAclBlock(fm);
  const read = aclBlock ? matchList(aclBlock, "read") : null;
  const write = aclBlock ? matchList(aclBlock, "write") : null;

  return { owner, read, write };
}

/**
 * The canonical "may this user do this op on this page?" check.
 *
 * Returns `true` iff the user passes. The HTTP handler maps `false`
 * to a 403 response; agent tools throw `AclViolation`.
 */
export function canAccess(acl: PageAcl, userId: string, username: string, op: AclOp): boolean {
  // Resolve the allow-list for the op. Null defaults differ:
  //   - read default = everyone (every user passes).
  //   - write default = owner only (nobody passes when owner unset).
  const list = op === "read" ? acl.read : acl.write;
  if (list === null) {
    if (op === "read") return true;
    // write default: owner only.
    return acl.owner === null ? false : acl.owner === userId;
  }

  for (const entry of list) {
    if (entry === "everyone") return true;
    if (entry === "owner") {
      if (acl.owner === userId) return true;
      continue;
    }
    if (entry === username) return true;
  }
  return false;
}

/**
 * Throw on deny. The HTTP handler catches this and maps to 403;
 * tools propagate it through the dispatcher's normal error path.
 */
export function assertCanAccess(acl: PageAcl, userId: string, username: string, op: AclOp): void {
  if (!canAccess(acl, userId, username, op)) {
    throw new AclViolation(op, username);
  }
}

/**
 * Whether this ACL is "fully default" — owner unset, both lists null.
 * The inheritance walker uses this to decide whether to climb to an
 * ancestor `index.md` for a non-default ACL. Once a page declares
 * even one field (typically `owner` after first write), inheritance
 * stops at that page.
 */
export function isDefaultAcl(acl: PageAcl): boolean {
  return acl.owner === null && acl.read === null && acl.write === null;
}

/**
 * Resolve the *effective* ACL for a page by walking up the directory
 * tree to the closest ancestor `index.md` that declares an ACL.
 *
 * `pagePath` is project-relative (e.g. `team/notes/standup.md`); the
 * walker tries `team/notes/index.md`, `team/index.md`, `index.md`. If
 * none of them declare an ACL the per-page default applies (read =
 * everyone, write = owner-only).
 *
 * `readPage` is the dependency-injected reader so this helper stays
 * test-agnostic of `StorageWriter`. Callers in production wire it to
 * `(p) => writer.read(p).content`; tests pass a Map-backed stub.
 *
 * Why ancestor `index.md` and not the parent directory file: the file
 * tree is a path, not a node. Directories don't carry frontmatter; the
 * convention from docs/08 §Multi-user mode is "ACL inheritance lives
 * on `<dir>/index.md`," which doubles as the human-visible README of
 * the section.
 */
export function loadEffectiveAcl(
  pagePath: string,
  readPage: (path: string) => string | null,
): PageAcl {
  const own = (() => {
    const content = readPage(pagePath);
    return content === null ? { ...ACL_DEFAULT } : parsePageAcl(content);
  })();
  if (!isDefaultAcl(own)) return own;

  // Walk ancestors. `team/notes/standup.md` → ["team/notes", "team", ""]
  // and we read `<ancestor>/index.md` (or `index.md` at root).
  let dir = pagePath.includes("/") ? pagePath.slice(0, pagePath.lastIndexOf("/")) : "";
  // Already-an-index.md at the same level: don't ask itself.
  if (pagePath === `${dir}/index.md` || pagePath === "index.md") {
    dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
  }
  while (true) {
    const candidate = dir === "" ? "index.md" : `${dir}/index.md`;
    if (candidate !== pagePath) {
      const content = readPage(candidate);
      if (content !== null) {
        const acl = parsePageAcl(content);
        if (!isDefaultAcl(acl)) return acl;
      }
    }
    if (dir === "") break;
    dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
  }
  return own; // every ancestor was default → default rules
}

/**
 * Thrown when a page's declared ACL would grant access wider than
 * its ancestor `index.md`'s ACL allows. Per docs/08-projects-and-isolation.md
 * §Multi-user mode and per-page ACLs §6: "Leaf pages can override but
 * not widen — a page under a read-private directory cannot declare
 * `read: everyone`." Caught at the HTTP route boundary and surfaced
 * as a 403 alongside the offending op.
 */
export class AclWideningError extends Error {
  readonly status = 403 as const;
  constructor(readonly op: AclOp) {
    super(
      `ACL violation: cannot widen ancestor ${op} ACL — leaf pages may narrow but not broaden inherited permissions`,
    );
    this.name = "AclWideningError";
  }
}

/**
 * Returns true iff the leaf list grants access wider than the ancestor
 * list. Null lists resolve to their per-op defaults (read = everyone,
 * write = owner-only) BEFORE comparison, so a leaf that omits a field
 * is treated as the maximally permissive value for that op.
 *
 *   - Ancestor `[everyone]` → leaf can never widen further.
 *   - Leaf `[everyone]` while ancestor isn't → widens.
 *   - Otherwise: every entry in leaf must appear in ancestor.
 */
function isWiderList(leaf: string[] | null, ancestor: string[] | null, op: AclOp): boolean {
  const ancEffective = ancestor ?? (op === "read" ? ["everyone"] : ["owner"]);
  if (ancEffective.includes("everyone")) return false;
  const leafEffective = leaf ?? (op === "read" ? ["everyone"] : ["owner"]);
  if (leafEffective.includes("everyone")) return true;
  for (const entry of leafEffective) {
    if (!ancEffective.includes(entry)) return true;
  }
  return false;
}

/**
 * Reject a write whose declared ACL would widen the inherited
 * (ancestor `index.md`) ACL. No-op when the ancestor ACL is fully
 * default (nothing to widen) OR when the leaf doesn't declare its own
 * `acl:` block (inheritance handles it via `loadEffectiveAcl`).
 *
 * Note: a leaf that declares `acl: { write: [alice] }` without a
 * `read:` field has `read = null`, which resolves to "everyone" by
 * default — that IS a widening if the ancestor restricts read. Callers
 * who want to inherit one field but override the other must declare
 * BOTH fields explicitly to avoid the by-omission widening footgun.
 */
export function assertNoAclWidening(newAcl: PageAcl, ancestor: PageAcl): void {
  if (isDefaultAcl(ancestor)) return;
  // Leaf with no `acl:` block at all → inheritance applies; nothing to check.
  const leafDeclaresAcl = newAcl.read !== null || newAcl.write !== null;
  if (!leafDeclaresAcl) return;
  if (isWiderList(newAcl.read, ancestor.read, "read")) {
    throw new AclWideningError("read");
  }
  if (isWiderList(newAcl.write, ancestor.write, "write")) {
    throw new AclWideningError("write");
  }
}

/**
 * On first write of a page (no `owner:` in frontmatter yet), stamp
 * the calling user's ID. Returns the (possibly modified) markdown.
 * Already-owned pages are returned unchanged so a foreign editor
 * with write permission doesn't accidentally hijack ownership.
 */
export function stampOwner(markdown: string, userId: string): string {
  if (!markdown.startsWith("---")) return markdown;
  const endIdx = markdown.indexOf("\n---", 3);
  if (endIdx === -1) return markdown;
  const fm = markdown.slice(4, endIdx);
  if (matchScalar(fm, "owner") !== null) return markdown;

  // Insert `owner: <userId>` after the first frontmatter line so
  // the file's diff is small + readable.
  const beforeBlock = markdown.slice(0, 4); // "---\n"
  const afterBlock = markdown.slice(endIdx);
  const stamped = `owner: ${userId}\n${fm}`;
  return `${beforeBlock}${stamped}${afterBlock}`;
}

// ─── internal helpers ────────────────────────────────────────────

function matchScalar(fm: string, key: string): string | null {
  // Top-level scalar: `key: value` at start of line, no leading
  // whitespace (which would make it a nested key). Tolerates a
  // trailing block-ID HTML comment (assignBlockIds may append
  // ` <!-- #blk_… -->` to the last line of a frontmatter paragraph
  // because parseBlocks treats frontmatter as a paragraph).
  const re = new RegExp(`^${key}\\s*:\\s*"?([^"\\n<#]+?)"?(?:\\s*<!--[^]*?-->)?\\s*(?:#.*)?$`, "m");
  const m = re.exec(fm);
  return m?.[1] ? m[1].trim() : null;
}

function extractAclBlock(fm: string): string | null {
  // The `acl:` key opens a nested block. Capture every subsequent
  // line that starts with whitespace; the block ends at the first
  // un-indented line.
  const start = /^acl\s*:\s*$/m.exec(fm);
  if (!start) return null;
  const after = fm.slice((start.index ?? 0) + start[0].length).split(/\r?\n/);
  const lines: string[] = [];
  for (const line of after) {
    if (line.length === 0) continue;
    if (/^\s/.test(line)) lines.push(line);
    else break;
  }
  return lines.length === 0 ? null : lines.join("\n");
}

function matchList(block: string, key: string): string[] | null {
  // Two YAML shapes: flow `key: [a, b]` and block
  //   `key:
  //     - a
  //     - b`.
  // Both are common in seeded fixtures and the spec example.
  // Trailing `<!-- #blk_… -->` comments appear when the frontmatter
  // round-trips through `assignBlockIds`; the regexes tolerate them.
  const flow = new RegExp(
    `^\\s+${key}\\s*:\\s*\\[([^\\]]*)\\](?:\\s*<!--[^]*?-->)?\\s*$`,
    "m",
  ).exec(block);
  if (flow?.[1] !== undefined) {
    return flow[1]
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  const blockOpen = new RegExp(`^\\s+${key}\\s*:\\s*$`, "m").exec(block);
  if (!blockOpen) return null;
  const after = block.slice((blockOpen.index ?? 0) + blockOpen[0].length).split(/\r?\n/);
  const items: string[] = [];
  for (const line of after) {
    if (line.length === 0) continue; // skip the newline immediately after `<key>:`
    const m = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (!m) break;
    const value = m[1]?.replace(/^["']|["']$/g, "").trim();
    if (value) items.push(value);
  }
  return items.length === 0 ? null : items;
}
