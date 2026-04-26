import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computePageBlockTrust } from "./block-trust.js";

/**
 * `computePageBlockTrust` — block-level trust scoring shipped as
 * the A.3.3 trust-score deliverable.
 *
 * Pinning four behaviours:
 *   1. Human-written blocks (no `agent` stamp) get no entry — no
 *      badge in the UI.
 *   2. Agent-stamped block with no `derived_from` → unverified
 *      (matches `kb.lint_provenance_gaps`).
 *   3. Agent-stamped block whose source page was modified after
 *      `compiled_at` → stale.
 *   4. Agent-stamped block whose source still exists + hasn't moved →
 *      fresh.
 *
 * Pinning here (not just at the lint level) so a future refactor of
 * the trust heuristic that breaks the contract fails the test.
 */

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "block-trust-"));
});
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

function writePage(relPath: string, body: string, sidecar: object | null): void {
  const abs = join(dataRoot, relPath);
  writeFileSync(abs, body, "utf-8");
  if (sidecar) {
    writeFileSync(abs.replace(/\.md$/, ".blocks.json"), JSON.stringify(sidecar, null, 2), "utf-8");
  }
}

describe("computePageBlockTrust", () => {
  it("returns no entry for human-written blocks (no agent stamp = no badge)", () => {
    writePage("human.md", "---\nid: 01\nmodified: 2026-04-25T10:00:00.000Z\n---\n\nhi", {
      version: 1,
      blocks: [{ id: "blk_HUMAN", type: "paragraph", start: 0, end: 2 }],
    });
    const out = computePageBlockTrust(dataRoot, "human.md");
    expect(out.size).toBe(0);
  });

  it("flags an agent-stamped block with no derived_from as unverified", () => {
    // Mirrors kb.lint_provenance_gaps — agent claimed authorship
    // without citing sources. Worst-case for trust.
    writePage("wiki.md", "---\nid: 01\nmodified: 2026-04-25T10:00:00.000Z\n---\n\nbody", {
      version: 1,
      blocks: [
        {
          id: "blk_GAP",
          type: "paragraph",
          start: 0,
          end: 4,
          agent: "wiki-gardener",
          compiled_at: "2026-04-25T09:00:00.000Z",
        },
      ],
    });
    const out = computePageBlockTrust(dataRoot, "wiki.md");
    const trust = out.get("blk_GAP");
    expect(trust?.state).toBe("unverified");
    expect(trust?.reason).toMatch(/no derived_from/);
    expect(trust?.sources).toBe(0);
  });

  it("flags an agent-stamped block whose source moved after compile as stale", () => {
    // Source was modified at 12:00, block compiled at 11:00 →
    // staleness signal. The doc's `findStaleSources` lint runs the
    // same comparison at the page level; this test pins the
    // per-block UI signal that complements it.
    writePage("src.md", "---\nid: SRC\nmodified: 2026-04-25T12:00:00.000Z\n---\n\ncontent", {
      version: 1,
      blocks: [{ id: "blk_SRC", type: "paragraph", start: 0, end: 7 }],
    });
    writePage("wiki.md", "---\nid: WIKI\nmodified: 2026-04-25T11:00:00.000Z\n---\n\nbody", {
      version: 1,
      blocks: [
        {
          id: "blk_WIKI",
          type: "paragraph",
          start: 0,
          end: 4,
          agent: "wiki-gardener",
          compiled_at: "2026-04-25T11:00:00.000Z",
          derived_from: ["src.md#blk_SRC"],
        },
      ],
    });
    const trust = computePageBlockTrust(dataRoot, "wiki.md").get("blk_WIKI");
    expect(trust?.state).toBe("stale");
    expect(trust?.sources).toBe(1);
    expect(trust?.newestSourceModified).toBe("2026-04-25T12:00:00.000Z");
  });

  it("flags an agent-stamped block whose cited source no longer exists as unverified", () => {
    writePage("wiki.md", "---\nid: 01\nmodified: 2026-04-25T10:00:00.000Z\n---\n\nbody", {
      version: 1,
      blocks: [
        {
          id: "blk_ORPHAN",
          type: "paragraph",
          start: 0,
          end: 4,
          agent: "wiki-gardener",
          compiled_at: "2026-04-25T09:00:00.000Z",
          derived_from: ["deleted.md#blk_GHOST"],
        },
      ],
    });
    const trust = computePageBlockTrust(dataRoot, "wiki.md").get("blk_ORPHAN");
    expect(trust?.state).toBe("unverified");
    expect(trust?.reason).toMatch(/no longer exist/);
  });

  it("returns fresh when every source exists and predates compiled_at", () => {
    writePage("src.md", "---\nid: SRC\nmodified: 2026-04-25T08:00:00.000Z\n---\n\ncontent", {
      version: 1,
      blocks: [{ id: "blk_SRC", type: "paragraph", start: 0, end: 7 }],
    });
    writePage("wiki.md", "---\nid: WIKI\nmodified: 2026-04-25T10:00:00.000Z\n---\n\nbody", {
      version: 1,
      blocks: [
        {
          id: "blk_FRESH",
          type: "paragraph",
          start: 0,
          end: 4,
          agent: "wiki-gardener",
          compiled_at: "2026-04-25T10:00:00.000Z",
          derived_from: ["src.md#blk_SRC"],
        },
      ],
    });
    const trust = computePageBlockTrust(dataRoot, "wiki.md").get("blk_FRESH");
    expect(trust?.state).toBe("fresh");
    expect(trust?.sources).toBe(1);
    expect(trust?.chainDepth).toBe(1);
  });

  it("computes chainDepth across two compilation hops", () => {
    // wiki2 derived from wiki1 derived from source — chainDepth 2.
    // The proposal A.3.4 wants `compilation_depth` as a stored
    // field; computing it on demand from `derived_from` validates
    // the "no need to denormalize" position.
    writePage("src.md", "---\nid: SRC\nmodified: 2026-04-25T08:00:00.000Z\n---\n\ncontent", {
      version: 1,
      blocks: [{ id: "blk_SRC", type: "paragraph", start: 0, end: 7 }],
    });
    writePage("wiki1.md", "---\nid: WIKI1\nmodified: 2026-04-25T09:00:00.000Z\n---\n\nbody1", {
      version: 1,
      blocks: [
        {
          id: "blk_W1",
          type: "paragraph",
          start: 0,
          end: 5,
          agent: "wiki-gardener",
          compiled_at: "2026-04-25T09:00:00.000Z",
          derived_from: ["src.md#blk_SRC"],
        },
      ],
    });
    writePage("wiki2.md", "---\nid: WIKI2\nmodified: 2026-04-25T10:00:00.000Z\n---\n\nbody2", {
      version: 1,
      blocks: [
        {
          id: "blk_W2",
          type: "paragraph",
          start: 0,
          end: 5,
          agent: "wiki-gardener",
          compiled_at: "2026-04-25T10:00:00.000Z",
          derived_from: ["wiki1.md#blk_W1"],
        },
      ],
    });
    const trust = computePageBlockTrust(dataRoot, "wiki2.md").get("blk_W2");
    expect(trust?.chainDepth).toBe(2);
  });

  it("returns empty when the page has no sidecar", () => {
    // No .blocks.json on disk → no provenance to score. Doesn't
    // throw — silent fall-through, matches the design ("trust
    // scoring runs in the page-read hot path and must not poison
    // a render").
    const out = computePageBlockTrust(dataRoot, "missing.md");
    expect(out.size).toBe(0);
  });
});
