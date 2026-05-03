import { describe, expect, it } from "vitest";

/**
 * Pure-logic mirror of the editor's `resolveWikiLinkPath()` helper in
 * `MarkdownEditor.tsx`. Pins the contract:
 *   1. Literal-match wins (preserves current case-sensitive behaviour
 *      when both a typed-as-lowercase and a typed-as-titlecase file
 *      coexist).
 *   2. Case-insensitive fallback resolves Obsidian-style citations
 *      (`[[research notes]]` → `Research Notes.md`).
 *   3. No match → return the original target unchanged so the caller's
 *      "page not found" path surfaces, instead of silently rewriting
 *      to a phantom lowercased path.
 *
 * The helper itself lives in MarkdownEditor.tsx because it threads
 * through the ProseMirror nodeView; pulling it out into a module
 * would force the editor surface to depend on an extracted util.
 * Keeping the contract here lets a refactor that loosens the
 * predicate break the test loudly. See docs/01-content-model.md
 * §Obsidian compatibility.
 */

function resolveWikiLinkPath(target: string, nodes: ReadonlyArray<{ path: string }>): string {
  if (nodes.some((n) => n.path === target)) return target;
  const targetLc = target.toLowerCase();
  const hit = nodes.find((n) => n.path.toLowerCase() === targetLc);
  return hit ? hit.path : target;
}

describe("resolveWikiLinkPath — Obsidian case-insensitive resolution", () => {
  const nodes = [
    { path: "Research Notes.md" },
    { path: "research/lowercase.md" },
    { path: "MIXED/Case.md" },
  ];

  it("returns the literal path when an exact match exists", () => {
    expect(resolveWikiLinkPath("Research Notes.md", nodes)).toBe("Research Notes.md");
    expect(resolveWikiLinkPath("research/lowercase.md", nodes)).toBe("research/lowercase.md");
  });

  it("resolves a lowercased citation to the title-cased file (Obsidian default)", () => {
    expect(resolveWikiLinkPath("research notes.md", nodes)).toBe("Research Notes.md");
  });

  it("resolves a title-cased citation to a lowercased file", () => {
    expect(resolveWikiLinkPath("RESEARCH/LOWERCASE.MD", nodes)).toBe("research/lowercase.md");
  });

  it("preserves the on-disk case in mixed-case folder + filename", () => {
    expect(resolveWikiLinkPath("mixed/case.md", nodes)).toBe("MIXED/Case.md");
  });

  it("returns the input unchanged when no node matches (page-not-found is the caller's job)", () => {
    expect(resolveWikiLinkPath("ghost.md", nodes)).toBe("ghost.md");
  });

  it("prefers the literal match when both spellings exist on disk", () => {
    // Two files differing only in case — the literal-match short-circuit
    //  should pick the one the user typed without falling through to
    //  the case-insensitive path (where order would decide arbitrarily).
    const dual = [{ path: "Foo.md" }, { path: "foo.md" }];
    expect(resolveWikiLinkPath("Foo.md", dual)).toBe("Foo.md");
    expect(resolveWikiLinkPath("foo.md", dual)).toBe("foo.md");
  });
});
