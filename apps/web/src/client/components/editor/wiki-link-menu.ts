import type { TreeNode } from "@ironlore/core";
import type { EditorState } from "prosemirror-state";

/**
 * Wiki-link trigger context detected from the current selection.
 * When non-null, the wiki-link picker should be open and filtered
 * by `query`. Mirrors the shape of the slash-menu context so the
 * editor can manage both with parallel state.
 *
 * Trigger rule: `[[` immediately before the caret, preceded by
 * start-of-line or whitespace so `a[[b` (paired brackets in a URL
 * or matrix reference) doesn't fire. Accepts spaces in the query
 * since page names often have them (`[[Getting started]]`).
 */
export interface WikiLinkContext {
  query: string;
  /** Position of the leading `[[` inside the paragraph. */
  from: number;
  /** End of the query text (the caret). */
  to: number;
}

const MAX_QUERY_LEN = 48;

/**
 * Detect an open `[[query` token at the caret. Returns `null`
 * unless:
 *   · the caret is inside a paragraph (same constraint as the
 *     slash menu — wiki links don't make sense inside code fences
 *     or headings)
 *   · there is a `[[` run earlier in the same paragraph preceded
 *     by start-of-line or whitespace
 *   · there is no `]]` between the `[[` and the caret (otherwise
 *     the wiki link is already closed)
 *   · the query length hasn't blown past `MAX_QUERY_LEN` (long runs
 *     of prose aren't a pending wiki link)
 */
export function getWikiLinkContext(state: EditorState): WikiLinkContext | null {
  const { $from, empty } = state.selection;
  if (!empty) return null;
  const parent = $from.parent;
  if (parent.type.name !== "paragraph") return null;

  const text = parent.textContent;
  const caretOffset = $from.parentOffset;

  // Scan backward for the nearest `[[` preceded by whitespace or
  //  SOL. Bail if we see `]]` first (closed ref) or run past the
  //  length cap.
  let triggerOffset = -1;
  for (let i = caretOffset - 2; i >= 0; i--) {
    const pair = text.slice(i, i + 2);
    if (pair === "]]") return null;
    if (caretOffset - i > MAX_QUERY_LEN + 2) return null;
    if (pair === "[[") {
      const prev = i === 0 ? " " : text[i - 1];
      if (prev === " " || prev === "\t" || prev === undefined) {
        triggerOffset = i;
      }
      break;
    }
  }
  if (triggerOffset < 0) return null;

  const query = text.slice(triggerOffset + 2, caretOffset);
  const startOfParagraph = $from.start();
  return {
    query,
    from: startOfParagraph + triggerOffset,
    to: startOfParagraph + caretOffset,
  };
}

/**
 * Score a candidate page against the user's typed query. Pure
 * substring matching — prefix matches on the name outrank
 * mid-string hits, and path-only matches come last so typing the
 * page name (the common case) surfaces the right page first.
 */
function scoreCandidate(name: string, path: string, query: string): number {
  if (query.length === 0) return 1;
  const q = query.toLowerCase();
  const n = name.toLowerCase();
  const p = path.toLowerCase();
  if (n.startsWith(q)) return 4;
  if (n.includes(q)) return 3;
  if (p.startsWith(q)) return 2;
  if (p.includes(q)) return 1;
  return 0;
}

export interface WikiLinkCandidate {
  path: string;
  name: string;
}

/**
 * Filter + rank the tree nodes for the wiki-link picker. Directories
 * are excluded because wiki links point at individual pages, not
 * folders. Returns at most `limit` results (default 8) so the
 * popover stays visually bounded.
 */
export function filterWikiLinkCandidates(
  nodes: TreeNode[],
  query: string,
  limit = 8,
): WikiLinkCandidate[] {
  const scored: Array<{ c: WikiLinkCandidate; score: number }> = [];
  for (const n of nodes) {
    if (n.type === "directory") continue;
    const score = scoreCandidate(n.name, n.path, query);
    if (score === 0 && query.length > 0) continue;
    scored.push({ c: { path: n.path, name: n.name }, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.c.name.localeCompare(b.c.name);
  });
  return scored.slice(0, limit).map((x) => x.c);
}
