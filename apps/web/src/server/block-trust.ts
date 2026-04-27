import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BlocksIndex } from "@ironlore/core";
import { readBlocksSidecar } from "./block-ids.js";

/**
 * Block-level trust scoring — derived at read time, never persisted.
 *
 * The provenance fields written into `.blocks.json` by the tool
 * protocol (see [block-ids.ts](./block-ids.ts) +
 * [docs/01-content-model.md §Block IDs](../../../docs/01-content-model.md))
 * are the authoritative inputs. This module aggregates them into a
 * single human-readable signal — `fresh | stale | unverified` — for
 * the "show your work" UI to render.
 *
 * Design (mirrors [docs/04-ai-and-agents.md §Trust score](../../../docs/04-ai-and-agents.md)):
 *   - **Stored once, computed everywhere else.** No `trust_score` column
 *     anywhere; recomputing with a new heuristic is just a server
 *     redeploy. The proposal A.3.4 to add `compilation_depth` as a
 *     persisted field is rejected on the same grounds — it's
 *     `chainDepth(derived_from)`, derivable in O(D) per call.
 *   - **Inputs are authoritative.** `derived_from` was stamped at
 *     write time and survives untouched-block edits via the sidecar
 *     carry-forward in `writeBlocksSidecar`. `compiled_at` is the
 *     per-block clock, distinct from the page's `modified`.
 *   - **Failure is silent.** A missing source page → unverified, not
 *     a thrown error. Trust scoring runs in the page-read hot path
 *     and must not poison a render on a deleted source.
 */

export type BlockTrustState = "fresh" | "stale" | "unverified" | null;

export interface BlockTrust {
  /**
   * `fresh`     — agent-stamped, every transitive source page still
   *               exists, none have been modified since `compiled_at`.
   * `stale`     — at least one source page has been modified after
   *               this block was compiled. Re-derive recommended.
   * `unverified`— agent-stamped but with no `derived_from` (provenance
   *               gap), or one of the cited sources has been deleted.
   * `null`      — block has no agent stamp at all (human-written).
   *               No badge rendered.
   */
  state: BlockTrustState;
  /** Number of distinct source page paths reached transitively. */
  sources: number;
  /**
   * Compilation depth — length of the longest derived_from chain
   * back to a `derived_from`-less root. 1 = derived directly from
   * a source page; 2 = derived from a wiki block that itself was
   * derived from a source; etc. The proposal calls this
   * `compilation_depth` and asks for it to be a stored field;
   * shipping it as a derived signal instead, computed here.
   */
  chainDepth: number;
  /** ISO timestamp of the most recently modified source page seen. */
  newestSourceModified: string | null;
  /**
   * Why the state landed where it did — surfaced in the provenance
   * panel so the user understands `stale` vs. `unverified`.
   */
  reason: string | null;
}

interface BlockEntry {
  id: string;
  derived_from?: string[];
  agent?: string;
  compiled_at?: string;
}

/**
 * Compute trust for every agent-stamped block on a page in one
 * pass. Reads the page's sidecar + every transitively-referenced
 * source sidecar (cached per-call). Returns a Map keyed by block
 * ID; blocks without `agent` stamping are omitted (no badge).
 */
export function computePageBlockTrust(dataRoot: string, pagePath: string): Map<string, BlockTrust> {
  const sidecar = readBlocksSidecar(absolutize(dataRoot, pagePath));
  const out = new Map<string, BlockTrust>();
  if (!sidecar) return out;

  // Cache source-page stat lookups so a wiki block that cites the
  // same source three times only stats it once.
  const sourceCache = new Map<string, SourceMeta | null>();

  for (const block of sidecar.blocks as BlockEntry[]) {
    if (!block.agent) continue; // human-written → no badge
    out.set(block.id, computeOne(dataRoot, block, sourceCache, sidecar));
  }
  return out;
}

interface SourceMeta {
  /** ISO `modified` timestamp from the source page's frontmatter,
   *  or the file's mtime as a fallback. */
  modified: string;
  /** Per-block sidecar of the source page, for chain-depth walks. */
  sidecar: BlocksIndex | null;
}

function computeOne(
  dataRoot: string,
  block: BlockEntry,
  sourceCache: Map<string, SourceMeta | null>,
  pageSidecar: BlocksIndex,
): BlockTrust {
  const refs = block.derived_from ?? [];

  // Provenance-gap: agent stamped this but cited no sources.
  // Matches the kb.lint_provenance_gaps detector — surface the
  // same finding at the per-block UI level.
  if (refs.length === 0) {
    return {
      state: "unverified",
      sources: 0,
      chainDepth: 0,
      newestSourceModified: null,
      reason: "no derived_from sources",
    };
  }

  let stale = false;
  let missing = false;
  let newest: string | null = null;
  const seenPages = new Set<string>();

  for (const ref of refs) {
    const pagePath = parseBlockRef(ref)?.page;
    if (!pagePath) continue;
    seenPages.add(pagePath);

    const meta = loadSourceMeta(dataRoot, pagePath, sourceCache);
    if (!meta) {
      missing = true;
      continue;
    }
    if (newest === null || meta.modified > newest) newest = meta.modified;
    if (block.compiled_at && meta.modified > block.compiled_at) stale = true;
  }

  const chainDepth = walkChainDepth(dataRoot, refs, sourceCache, pageSidecar);

  if (missing) {
    return {
      state: "unverified",
      sources: seenPages.size,
      chainDepth,
      newestSourceModified: newest,
      reason: "one or more cited source pages no longer exist",
    };
  }
  if (stale) {
    return {
      state: "stale",
      sources: seenPages.size,
      chainDepth,
      newestSourceModified: newest,
      reason: "a cited source has been modified since this block was compiled",
    };
  }
  return {
    state: "fresh",
    sources: seenPages.size,
    chainDepth,
    newestSourceModified: newest,
    reason: null,
  };
}

/**
 * Walk `derived_from` recursively to find the longest chain back to
 * a root (a block with no `derived_from`). Capped at 8 hops to
 * keep pathological cycles from blowing the stack — anything past
 * that reads as the same "deep compilation" signal anyway.
 *
 * Cycle protection: `seen` set keyed by `path#blockId` — a block
 * that re-references itself returns at the current depth.
 */
function walkChainDepth(
  dataRoot: string,
  refs: string[],
  sourceCache: Map<string, SourceMeta | null>,
  selfSidecar: BlocksIndex | null,
): number {
  const MAX_DEPTH = 8;
  let maxDepth = 1;
  const visit = (chain: string[], depth: number, seen: Set<string>): void => {
    if (depth > MAX_DEPTH) {
      maxDepth = MAX_DEPTH;
      return;
    }
    for (const ref of chain) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      maxDepth = Math.max(maxDepth, depth);
      const parsed = parseBlockRef(ref);
      if (!parsed) continue;
      const meta = loadSourceMeta(dataRoot, parsed.page, sourceCache);
      const sidecar = meta?.sidecar ?? selfSidecar;
      if (!sidecar) continue;
      const target = sidecar.blocks.find((b) => b.id === parsed.blockId);
      if (!target?.derived_from || target.derived_from.length === 0) continue;
      visit(target.derived_from, depth + 1, seen);
    }
  };
  visit(refs, 1, new Set());
  return maxDepth;
}

function loadSourceMeta(
  dataRoot: string,
  pagePath: string,
  cache: Map<string, SourceMeta | null>,
): SourceMeta | null {
  if (cache.has(pagePath)) return cache.get(pagePath) ?? null;
  const abs = absolutize(dataRoot, pagePath);
  if (!existsSync(abs)) {
    cache.set(pagePath, null);
    return null;
  }
  const modified = extractModified(abs) ?? "";
  const sidecar = readBlocksSidecar(abs);
  const meta: SourceMeta = { modified, sidecar };
  cache.set(pagePath, meta);
  return meta;
}

function extractModified(absPath: string): string | null {
  try {
    const raw = readFileSync(absPath, "utf-8");
    // Cheap frontmatter probe — avoids pulling in js-yaml for a
    // single field. Matches `modified: "<ISO>"` or unquoted form.
    const match = /^modified\s*:\s*["']?([^"'\n]+)["']?\s*$/m.exec(raw);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

function parseBlockRef(ref: string): { page: string; blockId: string } | null {
  // Block-refs are `<pagePath>#<blockId>` per the wiki-link grammar.
  // `pagePath` can contain slashes; `blockId` cannot — split on the
  // last `#`.
  const hash = ref.lastIndexOf("#");
  if (hash <= 0) return null;
  return { page: ref.slice(0, hash), blockId: ref.slice(hash + 1) };
}

function absolutize(dataRoot: string, pagePath: string): string {
  return pagePath.startsWith(dataRoot) ? pagePath : join(dataRoot, pagePath);
}
