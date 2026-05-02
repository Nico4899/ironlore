import { useEffect, useState } from "react";
import { fetchPage } from "../lib/api.js";

/**
 * In-memory block cache keyed by `<pagePath>#<blockId>`. Lives at
 * module scope so every Blockref instance shares the same store —
 * the design spec requires that the tooltip preview "[comes] from
 * the cache that populated the citation" with no network call once
 * the block has been seen.
 *
 * Eviction: LRU with a 512-entry cap (generous for a session's
 * worth of citations). When capacity is exceeded, the oldest key
 * is dropped. This keeps per-session memory bounded on long-lived
 * tabs without adding a TTL or eviction timer.
 */
const BLOCK_CACHE = new Map<string, string>();
const CACHE_CAP = 512;
/** Pages we have already fetched (or are fetching) so we don't
 *  re-request on every hover when the page has many citations. */
const PAGE_INFLIGHT = new Map<string, Promise<void>>();

/**
 * Per-page "first block preview" cache. Used when a citation
 * points at a whole page (`[[Page]]`, no `#blk_…`) — we surface
 * the first real block's text so the hover card is never empty
 * for a page-only reference. Populated alongside `BLOCK_CACHE` by
 * `rememberBlocks` on page load.
 */
const PAGE_HEAD_CACHE = new Map<string, string>();

function cacheKey(pagePath: string, blockId: string): string {
  return `${pagePath}#${blockId}`;
}

function rememberBlocks(pagePath: string, content: string): void {
  // Block markers are HTML comments: `<!-- #blk_ULID -->`. The
  //  convention is that the block content follows the marker up to
  //  the next marker (or EOF). Split the body on the marker regex
  //  and stitch each block back to its id.
  const re = /<!--\s*#(blk_[A-Za-z0-9]+)\s*-->/g;
  const matches: Array<{ id: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null = re.exec(content);
  while (m !== null) {
    matches.push({ id: m[1] ?? "", start: m.index, end: m.index + m[0].length });
    m = re.exec(content);
  }
  let firstBlockText: string | null = null;
  for (let i = 0; i < matches.length; i++) {
    const here = matches[i];
    if (!here) continue;
    const next = matches[i + 1];
    const bodyStart = here.end;
    const bodyEnd = next ? next.start : content.length;
    const text = content.slice(bodyStart, bodyEnd).trim();
    if (!text) continue;
    if (firstBlockText === null) firstBlockText = text;
    const key = cacheKey(pagePath, here.id);
    // LRU behavior: delete-then-set pushes the key to the most-recent
    //  position in the Map's insertion order.
    BLOCK_CACHE.delete(key);
    BLOCK_CACHE.set(key, text);
    if (BLOCK_CACHE.size > CACHE_CAP) {
      const first = BLOCK_CACHE.keys().next().value;
      if (first) BLOCK_CACHE.delete(first);
    }
  }
  // Page-level head — fallback for `[[Page]]` (no block) hovers. If
  //  the page has no block markers (freshly seeded), strip the
  //  frontmatter and take the first non-empty line as the preview.
  if (firstBlockText === null) {
    const stripped = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    firstBlockText = stripped.trim().slice(0, 400) || null;
  }
  if (firstBlockText) {
    PAGE_HEAD_CACHE.delete(pagePath);
    PAGE_HEAD_CACHE.set(pagePath, firstBlockText);
    if (PAGE_HEAD_CACHE.size > CACHE_CAP) {
      const oldest = PAGE_HEAD_CACHE.keys().next().value;
      if (oldest) PAGE_HEAD_CACHE.delete(oldest);
    }
  }
}

async function ensurePageLoaded(pagePath: string): Promise<void> {
  let pending = PAGE_INFLIGHT.get(pagePath);
  if (pending) return pending;
  pending = fetchPage(pagePath)
    .then((page) => {
      rememberBlocks(pagePath, page.content);
    })
    .catch(() => {
      /* non-fatal — the hover tooltip silently degrades to just the
       *  page + block id header. */
    })
    .finally(() => {
      PAGE_INFLIGHT.delete(pagePath);
    });
  PAGE_INFLIGHT.set(pagePath, pending);
  return pending;
}

/**
 * Hook — returns the cached preview text for a `[[page#block]]`
 * citation, or for a page-only `[[page]]` ref (falls back to the
 * first block's text, or the body's head if the page has no block
 * markers yet). The page is fetched lazily the first time a
 * citation on it is hovered. Callers enable the fetch by passing
 * `active: true` (usually: mouse-enter fired).
 */
export function useBlockPreview(
  pagePath: string,
  blockId: string | undefined,
  active: boolean,
): string | null {
  const [text, setText] = useState<string | null>(() => {
    if (blockId) {
      return BLOCK_CACHE.get(cacheKey(pagePath, blockId)) ?? null;
    }
    return PAGE_HEAD_CACHE.get(pagePath) ?? null;
  });

  useEffect(() => {
    if (!active) return;
    // Block-specific path — try the block cache first.
    if (blockId) {
      const key = cacheKey(pagePath, blockId);
      const cached = BLOCK_CACHE.get(key);
      if (cached) {
        setText(cached);
        return;
      }
      let cancelled = false;
      void ensurePageLoaded(pagePath).then(() => {
        if (cancelled) return;
        const hit = BLOCK_CACHE.get(key);
        if (hit) {
          setText(hit);
          return;
        }
        // The block ID couldn't be resolved on the page — usually
        //  because the page was edited and the agent's cited ID is
        //  stale, OR because the page predates the seeder's
        //  block-ID retrofit and has no `<!-- #blk_… -->` markers.
        //  Either way, the page-head text is the best we can show
        //  and is strictly better than leaving the preview stuck on
        //  "Loading…" forever.
        const headFallback = PAGE_HEAD_CACHE.get(pagePath);
        if (headFallback) setText(headFallback);
      });
      return () => {
        cancelled = true;
      };
    }
    // Page-level path — hover on a `[[Page]]` ref. Surface the
    //  first block's text (or the body head) from the page cache.
    const cached = PAGE_HEAD_CACHE.get(pagePath);
    if (cached) {
      setText(cached);
      return;
    }
    let cancelled = false;
    void ensurePageLoaded(pagePath).then(() => {
      if (cancelled) return;
      const hit = PAGE_HEAD_CACHE.get(pagePath);
      if (hit) setText(hit);
    });
    return () => {
      cancelled = true;
    };
  }, [active, pagePath, blockId]);

  return text;
}
