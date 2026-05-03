import type { TreeNode } from "@ironlore/core";
import { describe, expect, it } from "vitest";

/**
 * Pure-logic mirror of the FolderPeekPopover's two derivations:
 *   1. `flattenDescendants(folderPath, nodes)` — every node whose path
 *      starts with `<folderPath>/`, with depth + relative path stamped on.
 *   2. `filterByQuery(descendants, query)` — case-insensitive substring
 *      against the relative path or basename.
 *
 * These are the two derivations that decide what the popover shows; if
 * a refactor changes the prefix rule (e.g. starts including the folder
 * row itself, or follows symlinks) or the query semantics, the popover
 * will silently misbehave. Pin the contract.
 */

interface DescendantRow extends TreeNode {
  rel: string;
  depth: number;
}

function flattenDescendants(folderPath: string, nodes: TreeNode[]): DescendantRow[] {
  const prefix = `${folderPath}/`;
  return nodes
    .filter((n) => n.path.startsWith(prefix))
    .map((n) => {
      const rel = n.path.slice(prefix.length);
      const depth = rel.split("/").length - 1;
      return { ...n, rel, depth };
    });
}

function filterByQuery(rows: DescendantRow[], query: string): DescendantRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((n) => n.rel.toLowerCase().includes(q) || n.name.toLowerCase().includes(q));
}

const NODES: TreeNode[] = [
  { id: "research", name: "research", path: "research", type: "directory" },
  { id: "research/notes.md", name: "notes.md", path: "research/notes.md", type: "markdown" },
  {
    id: "research/sources",
    name: "sources",
    path: "research/sources",
    type: "directory",
  },
  {
    id: "research/sources/paper.pdf",
    name: "paper.pdf",
    path: "research/sources/paper.pdf",
    type: "pdf",
  },
  {
    id: "research/sources/transcript.txt",
    name: "transcript.txt",
    path: "research/sources/transcript.txt",
    type: "transcript",
  },
  // Sibling folder — must NOT leak into research's descendants.
  { id: "scratch", name: "scratch", path: "scratch", type: "directory" },
  { id: "scratch/draft.md", name: "draft.md", path: "scratch/draft.md", type: "markdown" },
  // Path that *starts with* "research" but isn't under it (no slash).
  { id: "research-old.md", name: "research-old.md", path: "research-old.md", type: "markdown" },
];

describe("FolderPeek — flattenDescendants", () => {
  it("returns every node strictly under the folder", () => {
    const rows = flattenDescendants("research", NODES);
    expect(rows.map((r) => r.path)).toEqual([
      "research/notes.md",
      "research/sources",
      "research/sources/paper.pdf",
      "research/sources/transcript.txt",
    ]);
  });

  it("does not include the folder row itself", () => {
    const rows = flattenDescendants("research", NODES);
    expect(rows.find((r) => r.path === "research")).toBeUndefined();
  });

  it("does not include sibling folders that share a name prefix (no slash boundary)", () => {
    // "research-old.md" begins with "research" but is not under research/.
    const rows = flattenDescendants("research", NODES);
    expect(rows.find((r) => r.path === "research-old.md")).toBeUndefined();
  });

  it("does not include unrelated trees", () => {
    const rows = flattenDescendants("research", NODES);
    expect(rows.find((r) => r.path.startsWith("scratch"))).toBeUndefined();
  });

  it("computes depth relative to the queried folder", () => {
    const rows = flattenDescendants("research", NODES);
    const notes = rows.find((r) => r.path === "research/notes.md");
    const paper = rows.find((r) => r.path === "research/sources/paper.pdf");
    expect(notes?.depth).toBe(0); // direct child
    expect(paper?.depth).toBe(1); // one folder deeper
  });

  it("returns empty for an empty folder", () => {
    const rows = flattenDescendants("scratch/empty", NODES);
    expect(rows).toEqual([]);
  });
});

describe("FolderPeek — filterByQuery", () => {
  const rows = flattenDescendants("research", NODES);

  it("returns all rows for an empty query", () => {
    expect(filterByQuery(rows, "")).toHaveLength(4);
    expect(filterByQuery(rows, "   ")).toHaveLength(4);
  });

  it("filters by basename substring (case-insensitive)", () => {
    const r = filterByQuery(rows, "PAPER");
    expect(r.map((n) => n.name)).toEqual(["paper.pdf"]);
  });

  it("filters by relative path substring (matches across folder boundary)", () => {
    const r = filterByQuery(rows, "sources/");
    expect(r.map((n) => n.path)).toEqual([
      "research/sources/paper.pdf",
      "research/sources/transcript.txt",
    ]);
  });

  it("returns empty for a no-match query", () => {
    expect(filterByQuery(rows, "definitely-not-here")).toEqual([]);
  });
});
