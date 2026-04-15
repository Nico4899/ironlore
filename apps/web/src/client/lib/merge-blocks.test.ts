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
