/**
 * Extract the `kind:` frontmatter value from a markdown page.
 *
 * Mirrors the helper in `search-index.ts` (which is private to that
 * file) so the kb.* mutation tools can read a page's kind on the
 * write path without depending on the search index.
 *
 * Returns one of `"page" | "source" | "wiki"` for recognised values,
 * or null when the field is absent / malformed / the file has no
 * frontmatter. The `writable-kinds-gate` treats null as `"page"` for
 * the gate check — un-classified pages default to the most permissive
 * kind so legacy content stays editable.
 *
 * Tolerates a trailing block-ID HTML comment on the same line — pages
 * written through `assignBlockIds` have `kind: wiki <!-- #blk_… -->`
 * because the frontmatter content lines parse as paragraphs and get
 * IDs stamped on them. The `\b` after the captured value lets the
 * match end at the space before the comment.
 */
export function extractPageKind(markdown: string): "page" | "source" | "wiki" | null {
  if (!markdown.startsWith("---")) return null;
  const endIdx = markdown.indexOf("\n---", 3);
  if (endIdx === -1) return null;
  const frontmatter = markdown.slice(4, endIdx);
  const match = /^kind\s*:\s*"?(page|source|wiki)"?\b/m.exec(frontmatter);
  return (match?.[1] as "page" | "source" | "wiki" | undefined) ?? null;
}
