import { type Block, parseBlocks } from "@ironlore/core";

/**
 * Block-level three-way merge used by the 409 conflict UI.
 *
 * The server returns the remote markdown and its current ETag. The client
 * knows its own local markdown (what the user tried to save). The last
 * common state — the base — is implicit in the block IDs: blocks that
 * appear in both sides with the same ID and identical text were unchanged
 * on both sides, so they can be auto-included; blocks that differ by ID
 * are one-sided additions; blocks that share an ID but differ in text are
 * the real conflicts the user has to resolve.
 *
 * This is not a true three-way diff (we don't materialise the merge base),
 * but block IDs give us enough stability that the same invariants hold in
 * practice — renaming, splitting, or reordering is rare at the block level
 * compared to the line level.
 */

export type SegmentKind =
  | "common" // Same block ID, same text on both sides — auto-keep.
  | "only-local" // Block exists only in local (user added it).
  | "only-remote" // Block exists only in remote (the other editor added it).
  | "conflict"; // Same block ID, different text — user picks a resolution.

export interface MergeSegment {
  kind: SegmentKind;
  /** Stable block ID, or a synthetic one for blocks with no ID comment. */
  id: string;
  /** Local block text (if present). */
  local?: string;
  /** Remote block text (if present). */
  remote?: string;
  /** Type of the block (heading, paragraph, list, ...). */
  blockType?: Block["type"];
}

export interface ResolvedMerge {
  /** Final merged markdown, ready to PUT with the current server ETag. */
  markdown: string;
  /** Whether any conflict segments remain unresolved. */
  hasUnresolvedConflicts: boolean;
}

export type ConflictChoice = "local" | "remote" | "both" | "custom";

export interface ConflictResolution {
  choice: ConflictChoice;
  /** Used when `choice === "custom"` — user-edited block text. */
  customText?: string;
}

/**
 * Compare local and remote markdown, returning segments in a merged order.
 *
 * Ordering rule: walk blocks in the order they appear across both sides
 * via longest-common-subsequence over block IDs. One-sided additions are
 * interleaved at their original position. This keeps merged output
 * reading order faithful to what both editors intended.
 */
export function diffBlocks(localMd: string, remoteMd: string): MergeSegment[] {
  const local = parseBlocks(localMd);
  const remote = parseBlocks(remoteMd);

  const segments: MergeSegment[] = [];

  // Build ID → block maps for O(1) lookup.
  const remoteById = new Map<string, Block>();
  for (const b of remote) remoteById.set(b.id, b);
  const localById = new Map<string, Block>();
  for (const b of local) localById.set(b.id, b);

  // LCS over block IDs — stable when both sides mostly share structure.
  const lcs = computeLcs(
    local.map((b) => b.id),
    remote.map((b) => b.id),
  );
  const inLcs = new Set(lcs);

  let li = 0;
  let ri = 0;

  while (li < local.length || ri < remote.length) {
    // Emit purely-local-added blocks before the next common anchor.
    // Re-reads `local[li]` on every iteration — the pre-fix version
    // captured `lb` once at the top of the outer loop and reused it,
    // which caused the same block to be emitted repeatedly while
    // `li` advanced underneath. A single-paragraph-before-shared
    // layout (local=[L, S], remote=[S]) used to emit [L, L] instead
    // of [L, common(S)].
    while (li < local.length) {
      const cur = local[li];
      if (!cur || inLcs.has(cur.id)) break;
      segments.push({
        kind: "only-local",
        id: cur.id,
        local: cur.text,
        blockType: cur.type,
      });
      li++;
    }

    // Emit purely-remote-added blocks before the next common anchor.
    while (ri < remote.length) {
      const cur = remote[ri];
      if (!cur || inLcs.has(cur.id)) break;
      segments.push({
        kind: "only-remote",
        id: cur.id,
        remote: cur.text,
        blockType: cur.type,
      });
      ri++;
    }

    // Re-read after possible advances above.
    const lb2 = local[li];
    const rb2 = remote[ri];
    if (!lb2 || !rb2) break;

    // At this point both heads should be on the same LCS element.
    if (lb2.id === rb2.id) {
      if (lb2.text === rb2.text) {
        segments.push({
          kind: "common",
          id: lb2.id,
          local: lb2.text,
          remote: rb2.text,
          blockType: lb2.type,
        });
      } else {
        segments.push({
          kind: "conflict",
          id: lb2.id,
          local: lb2.text,
          remote: rb2.text,
          blockType: lb2.type,
        });
      }
      li++;
      ri++;
    } else {
      // LCS desync — shouldn't happen, but guard against infinite loop.
      li++;
      ri++;
    }
  }

  return segments;
}

/**
 * Apply user resolutions to the segment list and produce final markdown.
 */
export function applyResolutions(
  segments: MergeSegment[],
  resolutions: Map<string, ConflictResolution>,
): ResolvedMerge {
  const parts: string[] = [];
  let hasUnresolvedConflicts = false;

  for (const seg of segments) {
    if (seg.kind === "common" || seg.kind === "only-local") {
      if (seg.local) parts.push(seg.local);
    } else if (seg.kind === "only-remote") {
      if (seg.remote) parts.push(seg.remote);
    } else {
      // conflict
      const res = resolutions.get(seg.id);
      if (!res) {
        hasUnresolvedConflicts = true;
        if (seg.local) parts.push(seg.local);
        continue;
      }
      switch (res.choice) {
        case "local":
          if (seg.local) parts.push(seg.local);
          break;
        case "remote":
          if (seg.remote) parts.push(seg.remote);
          break;
        case "both":
          if (seg.local) parts.push(seg.local);
          if (seg.remote) parts.push(seg.remote);
          break;
        case "custom":
          parts.push(res.customText ?? seg.local ?? seg.remote ?? "");
          break;
      }
    }
  }

  return { markdown: `${parts.join("\n\n")}\n`, hasUnresolvedConflicts };
}

/**
 * Longest common subsequence over strings. Returns the sequence itself.
 * Standard DP — O(m*n) time, O(m*n) memory. Input sizes are block counts,
 * so this is fine in practice.
 */
function computeLcs(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return [];

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const ai = a[i - 1] as string;
      const bj = b[j - 1] as string;
      const prev = dp[i - 1]?.[j - 1] ?? 0;
      const up = dp[i - 1]?.[j] ?? 0;
      const left = dp[i]?.[j - 1] ?? 0;
      const row = dp[i] as number[];
      row[j] = ai === bj ? prev + 1 : Math.max(up, left);
    }
  }

  const result: string[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    const ai = a[i - 1] as string;
    const bj = b[j - 1] as string;
    if (ai === bj) {
      result.push(ai);
      i--;
      j--;
    } else if ((dp[i - 1]?.[j] ?? 0) >= (dp[i]?.[j - 1] ?? 0)) {
      i--;
    } else {
      j--;
    }
  }
  return result.reverse();
}
