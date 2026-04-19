import { describe, expect, it } from "vitest";
import { applyResolutions, type ConflictResolution, diffBlocks } from "./merge-blocks.js";

/**
 * Helper — wrap a paragraph in a block-ID comment so `parseBlocks` treats
 * it as an already-ID'd block. Mirrors what the server does on write.
 */
function withId(text: string, id: string): string {
  return `${text} <!-- #${id} -->`;
}

describe("diffBlocks", () => {
  it("marks identical ID + identical text as common", () => {
    const md = withId("# Heading", "blk_01HZZZZZZZZZZZZZZZZZZZZZZA");
    const segments = diffBlocks(md, md);
    expect(segments.filter((s) => s.kind === "common")).toHaveLength(1);
    expect(segments.filter((s) => s.kind === "conflict")).toHaveLength(0);
  });

  it("marks identical ID + different text as conflict", () => {
    const idA = "blk_01HZZZZZZZZZZZZZZZZZZZZZZA";
    const local = withId("Alpha body", idA);
    const remote = withId("Beta body", idA);

    const segments = diffBlocks(local, remote);
    const conflicts = segments.filter((s) => s.kind === "conflict");

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.id).toBe(idA);
    expect(conflicts[0]?.local).toContain("Alpha");
    expect(conflicts[0]?.remote).toContain("Beta");
  });

  it("classifies one-sided blocks as only-local / only-remote", () => {
    const idShared = "blk_01HZZZZZZZZZZZZZZZZZZZZZZA";
    const idLocalOnly = "blk_01HZZZZZZZZZZZZZZZZZZZZZZB";
    const idRemoteOnly = "blk_01HZZZZZZZZZZZZZZZZZZZZZZC";

    const local = [
      withId("Shared paragraph.", idShared),
      "",
      withId("Only on my side.", idLocalOnly),
    ].join("\n");
    const remote = [
      withId("Shared paragraph.", idShared),
      "",
      withId("Only on their side.", idRemoteOnly),
    ].join("\n");

    const segments = diffBlocks(local, remote);

    expect(segments.some((s) => s.kind === "only-local" && s.id === idLocalOnly)).toBe(true);
    expect(segments.some((s) => s.kind === "only-remote" && s.id === idRemoteOnly)).toBe(true);
    expect(segments.some((s) => s.kind === "common" && s.id === idShared)).toBe(true);
  });
});

describe("applyResolutions", () => {
  const idA = "blk_01HZZZZZZZZZZZZZZZZZZZZZZA";

  it("keeps common and one-sided blocks without needing a resolution", () => {
    const idLocal = "blk_01HZZZZZZZZZZZZZZZZZZZZZZB";
    const idRemote = "blk_01HZZZZZZZZZZZZZZZZZZZZZZC";

    const local = [withId("Shared.", idA), "", withId("Mine.", idLocal)].join("\n");
    const remote = [withId("Shared.", idA), "", withId("Theirs.", idRemote)].join("\n");

    const segments = diffBlocks(local, remote);
    const { markdown, hasUnresolvedConflicts } = applyResolutions(segments, new Map());

    expect(hasUnresolvedConflicts).toBe(false);
    expect(markdown).toContain("Shared.");
    expect(markdown).toContain("Mine.");
    expect(markdown).toContain("Theirs.");
  });

  it("flags hasUnresolvedConflicts when a conflict has no resolution", () => {
    const local = withId("Alpha", idA);
    const remote = withId("Beta", idA);
    const segments = diffBlocks(local, remote);
    const { hasUnresolvedConflicts } = applyResolutions(segments, new Map());
    expect(hasUnresolvedConflicts).toBe(true);
  });

  it("emits local text when choice = local", () => {
    const local = withId("Alpha", idA);
    const remote = withId("Beta", idA);
    const segments = diffBlocks(local, remote);

    const resolutions = new Map<string, ConflictResolution>([[idA, { choice: "local" }]]);
    const { markdown, hasUnresolvedConflicts } = applyResolutions(segments, resolutions);

    expect(hasUnresolvedConflicts).toBe(false);
    expect(markdown).toContain("Alpha");
    expect(markdown).not.toContain("Beta");
  });

  it("emits remote text when choice = remote", () => {
    const local = withId("Alpha", idA);
    const remote = withId("Beta", idA);
    const segments = diffBlocks(local, remote);

    const resolutions = new Map<string, ConflictResolution>([[idA, { choice: "remote" }]]);
    const { markdown } = applyResolutions(segments, resolutions);

    expect(markdown).toContain("Beta");
    expect(markdown).not.toContain("Alpha");
  });

  it("emits both versions when choice = both", () => {
    const local = withId("Alpha", idA);
    const remote = withId("Beta", idA);
    const segments = diffBlocks(local, remote);

    const resolutions = new Map<string, ConflictResolution>([[idA, { choice: "both" }]]);
    const { markdown } = applyResolutions(segments, resolutions);

    expect(markdown).toContain("Alpha");
    expect(markdown).toContain("Beta");
  });

  it("emits custom text when choice = custom", () => {
    const local = withId("Alpha", idA);
    const remote = withId("Beta", idA);
    const segments = diffBlocks(local, remote);

    const resolutions = new Map<string, ConflictResolution>([
      [idA, { choice: "custom", customText: "Gamma" }],
    ]);
    const { markdown } = applyResolutions(segments, resolutions);

    expect(markdown).toContain("Gamma");
    expect(markdown).not.toContain("Alpha");
    expect(markdown).not.toContain("Beta");
  });
});

// ---------------------------------------------------------------------------
// Reading-order invariants
// ---------------------------------------------------------------------------
// docs/06-implementation-roadmap.md §Phase 2: "one-sided additions
// interleave at their original position". A merge that preserves block
// IDs but rearranges paragraphs is useless — these tests pin the
// ordering so LCS regressions (or a future rewrite) can't slip through.

describe("diffBlocks — reading-order invariants", () => {
  const idS1 = "blk_01HZZZZZZZZZZZZZZZZZZZZZZS";
  const idS2 = "blk_01HZZZZZZZZZZZZZZZZZZZZZZT";
  const idLocalOnly = "blk_01HZZZZZZZZZZZZZZZZZZZZZZL";
  const idRemoteOnly = "blk_01HZZZZZZZZZZZZZZZZZZZZZZR";

  it("handles a local-only addition before a shared block", () => {
    const local = `${withId("L-before.", idLocalOnly)}\n\n${withId("Shared.", idS1)}`;
    const remote = withId("Shared.", idS1);

    const segments = diffBlocks(local, remote);
    const kinds = segments.map((s) => s.kind);
    // Expect: only-local, then common.
    expect(kinds).toEqual(["only-local", "common"]);
  });

  it("handles a remote-only addition after a shared block", () => {
    const local = withId("Shared.", idS1);
    const remote = `${withId("Shared.", idS1)}\n\n${withId("R-after.", idRemoteOnly)}`;

    const segments = diffBlocks(local, remote);
    const kinds = segments.map((s) => s.kind);
    expect(kinds).toEqual(["common", "only-remote"]);
  });

  it("interleaves alternating one-sided additions around two shared anchors", () => {
    // local:   L1, shared1, shared2
    // remote:  shared1, R1, shared2, R2
    // Expected order after merge: L1, shared1, R1, shared2, R2
    // (Local adds land where they appeared in local; remote adds where
    //  they appeared in remote; shared anchors provide the interleave
    //  points.)
    const local = [
      withId("L1", idLocalOnly),
      withId("Shared1", idS1),
      withId("Shared2", idS2),
    ].join("\n\n");
    const idRemote2 = "blk_01HZZZZZZZZZZZZZZZZZZZZZZU";
    const remote = [
      withId("Shared1", idS1),
      withId("R1", idRemoteOnly),
      withId("Shared2", idS2),
      withId("R2", idRemote2),
    ].join("\n\n");

    const segments = diffBlocks(local, remote);
    const order = segments.map((s) => ({ kind: s.kind, id: s.id }));

    // Invariants: L1 appears before shared1; R1 appears after shared1
    // and before shared2; R2 appears after shared2.
    const idxL1 = order.findIndex((s) => s.id === idLocalOnly);
    const idxS1 = order.findIndex((s) => s.id === idS1);
    const idxR1 = order.findIndex((s) => s.id === idRemoteOnly);
    const idxS2 = order.findIndex((s) => s.id === idS2);
    const idxR2 = order.findIndex((s) => s.id === idRemote2);

    expect(idxL1).toBeLessThan(idxS1);
    expect(idxS1).toBeLessThan(idxR1);
    expect(idxR1).toBeLessThan(idxS2);
    expect(idxS2).toBeLessThan(idxR2);
  });

  it("handles entirely disjoint inputs (no shared IDs)", () => {
    const local = withId("Local only", "blk_01HZZZZZZZZZZZZZZZZZZZZZA1");
    const remote = withId("Remote only", "blk_01HZZZZZZZZZZZZZZZZZZZZZA2");

    const segments = diffBlocks(local, remote);
    // One-sided on each side, no conflicts.
    expect(segments.some((s) => s.kind === "only-local")).toBe(true);
    expect(segments.some((s) => s.kind === "only-remote")).toBe(true);
    expect(segments.some((s) => s.kind === "conflict")).toBe(false);
  });

  it("handles an empty local (first-sync case)", () => {
    const local = "";
    const remote = withId("Remote.", idS1);

    const segments = diffBlocks(local, remote);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.kind).toBe("only-remote");
    expect(segments[0]?.id).toBe(idS1);
  });

  it("handles an empty remote (page deleted upstream)", () => {
    const local = withId("Local.", idS1);
    const remote = "";

    const segments = diffBlocks(local, remote);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.kind).toBe("only-local");
  });

  it("handles identical inputs (no-op merge)", () => {
    const md = [withId("Header", idS1), withId("Body", idS2)].join("\n\n");
    const segments = diffBlocks(md, md);
    expect(segments.every((s) => s.kind === "common")).toBe(true);

    const { markdown, hasUnresolvedConflicts } = applyResolutions(segments, new Map());
    expect(hasUnresolvedConflicts).toBe(false);
    expect(markdown).toContain("Header");
    expect(markdown).toContain("Body");
  });

  it("a reordered shared block (same ID, different position) merges without dropping content", () => {
    // Local: A, B. Remote: B, A. LCS picks one as the common anchor;
    // the other surfaces as one-sided on the side that keeps it.
    const idA = "blk_01HZZZZZZZZZZZZZZZZZZZZZAA";
    const idB = "blk_01HZZZZZZZZZZZZZZZZZZZZZAB";
    const local = [withId("A", idA), withId("B", idB)].join("\n\n");
    const remote = [withId("B", idB), withId("A", idA)].join("\n\n");

    const segments = diffBlocks(local, remote);
    const { markdown, hasUnresolvedConflicts } = applyResolutions(segments, new Map());
    // No text-level conflicts; both IDs keep their content somewhere.
    expect(hasUnresolvedConflicts).toBe(false);
    expect(markdown).toContain("A");
    expect(markdown).toContain("B");
  });
});
