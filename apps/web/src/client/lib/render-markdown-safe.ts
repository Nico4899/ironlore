import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

/**
 * Explicit allow-list schema for rehype-sanitize.
 *
 * Only elements that CommonMark + GFM can express are allowed. Everything
 * else is stripped. This is the single sanitization code path for all
 * rendered markdown in Ironlore — editor preview, transcript viewer,
 * mermaid viewer, agent output.
 *
 * Callouts (e.g. GFM alerts `> [!NOTE]`) are deferred until a syntax and
 * remark plugin are chosen. When added, include the relevant callout
 * container elements here.
 */
export const ironloreSchema = {
  strip: ["script", "style"],
  tagNames: [
    // Block
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "blockquote",
    "pre",
    "code",
    "ul",
    "ol",
    "li",
    "hr",
    "br",
    "div",
    // Tables (GFM)
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    // Inline
    "a",
    "strong",
    "em",
    "del",
    "sup",
    "sub",
    "img",
    "span",
    // Task lists (GFM)
    "input",
  ],
  attributes: {
    a: ["href", "title"],
    img: ["src", "alt", "title", "width", "height"],
    td: ["align"],
    th: ["align"],
    code: ["className"],
    pre: ["className"],
    input: ["type", "checked", "disabled"],
    li: ["className"],
    "*": ["id"],
  },
  protocols: {
    href: ["http", "https", "mailto"],
    src: ["http", "https"],
  },
  required: {
    input: { type: "checkbox", disabled: true },
  },
};

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: false })
  .use(rehypeSanitize, ironloreSchema)
  .use(rehypeStringify);

/**
 * Strip a leading YAML frontmatter block (`---\n…\n---\n`) so the
 * preview renders the body only. Without this, the renderer treats the
 * delimiters as horizontal rules and the YAML body collapses into a
 * single paragraph (see Pass 1 review). The frontmatter is still
 * visible in source mode and is the source of truth for tags / id /
 * acl, so dropping it from the preview is non-destructive.
 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function stripFrontmatter(md: string): string {
  return md.replace(FRONTMATTER_RE, "");
}

/**
 * Render markdown to sanitized HTML.
 *
 * All rendered markdown — editor preview, transcript viewer, mermaid
 * viewer, agent output — goes through this function. One sanitizer, one
 * code path. Zero `dangerouslySetInnerHTML` without this on the input side.
 */
export function renderMarkdownSafe(md: string): string {
  return processor.processSync(stripFrontmatter(md)).toString();
}
