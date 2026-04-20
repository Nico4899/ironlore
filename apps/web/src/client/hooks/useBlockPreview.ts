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
  for (let i = 0; i < matches.length; i++) {
    const here = matches[i];
    if (!here) continue;
    const next = matches[i + 1];
    const bodyStart = here.end;
    const bodyEnd = next ? next.start : content.length;
    const text = content.slice(bodyStart, bodyEnd).trim();
    if (!text) continue;
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
 * citation, fetching the page lazily the first time a citation on
 * that page is hovered. Callers enable the fetch by passing
 * `active: true` (usually: mouse-enter fired).
 */
export function useBlockPreview(
  pagePath: string,
  blockId: string | undefined,
  active: boolean,
): string | null {
  const [text, setText] = useState<string | null>(() => {
    if (!blockId) return null;
    return BLOCK_CACHE.get(cacheKey(pagePath, blockId)) ?? null;
  });

  useEffect(() => {
    if (!active || !blockId) return;
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
      if (hit) setText(hit);
    });
    return () => {
      cancelled = true;
    };
  }, [active, pagePath, blockId]);

  return text;
}
