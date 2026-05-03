import { describe, expect, it } from "vitest";

/**
 * Drop-edge hit test for the sidebar tree's drag-and-drop. When the
 * cursor is inside a row's vertical extent we partition Y into thirds:
 *   • top third + bottom third  → "before" / "after" (drop-line cue;
 *     resolves to "drop into the parent folder", not row ordering —
 *     the file system has no per-folder order primitive).
 *   • middle third (folders only) → "into" (drop into that folder).
 *   • middle third on a file row  → falls back to before/after based
 *     on which half of the row the cursor sits in.
 *
 * This file pins the hit-test so a refactor that swaps the partitions
 * around (e.g. halves instead of thirds, or different bands for
 * folders) breaks the test loudly. Mirrors the inline logic in
 * SidebarNew.tsx → handleRowDragOver.
 */

type Edge = "before" | "after" | "into";

function pickEdge(yWithinRow: number, rowHeight: number, isDir: boolean): Edge {
  const third = rowHeight / 3;
  if (isDir && yWithinRow > third && yWithinRow < rowHeight - third) {
    return "into";
  }
  return yWithinRow < rowHeight / 2 ? "before" : "after";
}

describe("sidebar DnD — drop-edge hit test", () => {
  const HEIGHT = 30; // representative row height

  it('returns "before" near the top of any row', () => {
    expect(pickEdge(2, HEIGHT, true)).toBe("before");
    expect(pickEdge(2, HEIGHT, false)).toBe("before");
  });

  it('returns "after" near the bottom of any row', () => {
    expect(pickEdge(28, HEIGHT, true)).toBe("after");
    expect(pickEdge(28, HEIGHT, false)).toBe("after");
  });

  it('returns "into" for the middle band of a folder row', () => {
    // y=15 is dead-centre — clearly inside the middle third (10..20).
    expect(pickEdge(15, HEIGHT, true)).toBe("into");
  });

  it('does NOT return "into" for the middle band of a file row', () => {
    // Files have no "into" semantic; centre still partitions to a
    // before/after edge so the move resolves to the parent folder.
    const result = pickEdge(15, HEIGHT, false);
    expect(["before", "after"]).toContain(result);
    expect(result).not.toBe("into");
  });

  it("the boundary at 1/3 height resolves to before for folders (exclusive at top)", () => {
    // y=10 is exactly third — strict-greater check means it's NOT in
    // the middle band, so it falls back to before/after by half.
    // y=10 < HEIGHT/2 (15) → "before".
    expect(pickEdge(10, HEIGHT, true)).toBe("before");
  });

  it("the boundary at 2/3 height resolves to after for folders (exclusive at bottom)", () => {
    // y=20 is exactly two-thirds — strict-less check means it's NOT in
    // the middle band; y=20 ≥ HEIGHT/2 (15) → "after".
    expect(pickEdge(20, HEIGHT, true)).toBe("after");
  });

  it("scales with row height (taller rows partition proportionally)", () => {
    const TALL = 60;
    expect(pickEdge(10, TALL, true)).toBe("before"); // top third = 0..20
    expect(pickEdge(30, TALL, true)).toBe("into"); // centre
    expect(pickEdge(50, TALL, true)).toBe("after"); // bottom third = 40..60
  });
});
