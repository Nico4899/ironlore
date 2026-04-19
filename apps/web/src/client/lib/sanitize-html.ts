/**
 * DOMParser-based HTML sanitizer for third-party HTML we do NOT author —
 * notably mammoth's .docx → HTML output.
 *
 * Why not rehype-sanitize: adding another unified pipeline for arbitrary
 * HTML would pull `rehype-parse` into the client bundle. Mammoth already
 * emits a narrow, predictable tag surface (paragraphs, lists, tables,
 * basic inline marks), so a direct allow-list pass on a DOM tree is
 * cheaper and stays in the browser's native parser.
 *
 * Tag / attribute allow-lists intentionally mirror `ironloreSchema` in
 * `render-markdown-safe.ts` so docx HTML composes the same way rendered
 * markdown does.
 */

const ALLOWED_TAGS = new Set([
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "P",
  "BLOCKQUOTE",
  "PRE",
  "CODE",
  "UL",
  "OL",
  "LI",
  "HR",
  "BR",
  "DIV",
  "TABLE",
  "THEAD",
  "TBODY",
  "TR",
  "TH",
  "TD",
  "A",
  "STRONG",
  "EM",
  "B",
  "I",
  "U",
  "DEL",
  "SUP",
  "SUB",
  "IMG",
  "SPAN",
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  A: new Set(["href", "title"]),
  IMG: new Set(["src", "alt", "title", "width", "height"]),
  TD: new Set(["align", "colspan", "rowspan"]),
  TH: new Set(["align", "colspan", "rowspan"]),
};

const ALLOWED_PROTOCOLS = ["http:", "https:", "mailto:"];

function isSafeUrl(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  // Same-page anchors, absolute paths, query strings — always safe.
  // (No protocol implied; the browser resolves against the current origin.)
  if (trimmed.startsWith("/") || trimmed.startsWith("#") || trimmed.startsWith("?")) return true;
  try {
    const url = new URL(trimmed, "http://local/");
    return ALLOWED_PROTOCOLS.includes(url.protocol);
  } catch {
    return false;
  }
}

function clean(node: Element): void {
  // Walk children with a live cursor (not a snapshot): when we unwrap
  //  a disallowed tag we expose its children at the same position and
  //  must re-sanitize them. A snapshotted copy would let a payload
  //  like `<svg><circle onerror=...></svg>` escape — the outer <svg>
  //  would be unwrapped, but <circle> would never be inspected.
  let child = node.firstElementChild;
  while (child) {
    const next = child.nextElementSibling;
    if (!ALLOWED_TAGS.has(child.tagName)) {
      // Move the child's children into place, then drop the child.
      //  The first moved node becomes the new cursor so we re-enter
      //  sanitization on it (and every sibling that follows).
      const firstMoved = child.firstChild as Element | null;
      while (child.firstChild) node.insertBefore(child.firstChild, child);
      node.removeChild(child);
      child = (firstMoved as Element | null) ?? next;
      continue;
    }
    const allowed = ALLOWED_ATTRS[child.tagName] ?? new Set<string>();
    for (const attr of Array.from(child.attributes)) {
      if (!allowed.has(attr.name)) {
        child.removeAttribute(attr.name);
        continue;
      }
      if ((attr.name === "href" || attr.name === "src") && !isSafeUrl(attr.value)) {
        child.removeAttribute(attr.name);
      }
    }
    clean(child);
    child = next;
  }
}

/**
 * Sanitize third-party HTML into a safe subset.
 *
 * Unknown tags are unwrapped (children preserved); disallowed attributes
 * and unsafe URL protocols are stripped. The output is suitable for
 * `dangerouslySetInnerHTML` in viewer components with a scoped biome
 * override.
 */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return "";
  clean(root);
  return root.innerHTML;
}
