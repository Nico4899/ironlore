import { describe, expect, it } from "vitest";
import { renderMarkdownSafe } from "./render-markdown-safe.js";

describe("renderMarkdownSafe", () => {
  // -------------------------------------------------------------------------
  // Basic rendering
  // -------------------------------------------------------------------------

  it("renders headings", () => {
    const html = renderMarkdownSafe("# Hello\n## World");
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("<h2>World</h2>");
  });

  it("renders paragraphs", () => {
    const html = renderMarkdownSafe("Hello world");
    expect(html).toContain("<p>Hello world</p>");
  });

  it("renders bold and italic", () => {
    const html = renderMarkdownSafe("**bold** and *italic*");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
  });

  it("renders links with allowed protocols", () => {
    const html = renderMarkdownSafe("[link](https://example.com)");
    expect(html).toContain('<a href="https://example.com">link</a>');
  });

  it("renders images with relative src", () => {
    const html = renderMarkdownSafe('![alt text](assets/img.png "title")');
    expect(html).toContain("img");
    expect(html).toContain('alt="alt text"');
    expect(html).toContain('src="assets/img.png"');
  });

  it("allows http/https image src (remote images permitted)", () => {
    const html = renderMarkdownSafe("![alt](https://example.com/img.png)");
    expect(html).toContain('src="https://example.com/img.png"');
  });

  it("renders code blocks", () => {
    const html = renderMarkdownSafe("```js\nconst x = 1;\n```");
    expect(html).toContain("<pre>");
    expect(html).toContain("<code");
    expect(html).toContain("const x = 1;");
  });

  it("renders inline code", () => {
    const html = renderMarkdownSafe("Use `npm install`");
    expect(html).toContain("<code>npm install</code>");
  });

  it("renders blockquotes", () => {
    const html = renderMarkdownSafe("> Quote here");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("Quote here");
  });

  it("renders unordered lists", () => {
    const html = renderMarkdownSafe("- item 1\n- item 2");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>item 1</li>");
    expect(html).toContain("<li>item 2</li>");
  });

  it("renders ordered lists", () => {
    const html = renderMarkdownSafe("1. first\n2. second");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>first</li>");
  });

  it("renders horizontal rules", () => {
    const html = renderMarkdownSafe("---");
    expect(html).toContain("<hr>");
  });

  // -------------------------------------------------------------------------
  // GFM extensions
  // -------------------------------------------------------------------------

  it("renders tables", () => {
    const html = renderMarkdownSafe("| A | B |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<thead>");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<td>1</td>");
  });

  it("renders strikethrough", () => {
    const html = renderMarkdownSafe("~~deleted~~");
    expect(html).toContain("<del>deleted</del>");
  });

  it("renders task lists", () => {
    const html = renderMarkdownSafe("- [x] done\n- [ ] pending");
    expect(html).toContain("checked");
    expect(html).toContain("input");
  });

  // -------------------------------------------------------------------------
  // Sanitization — dangerous content is stripped
  // -------------------------------------------------------------------------

  it("strips <script> tags", () => {
    const html = renderMarkdownSafe("<script>alert('xss')</script>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert");
  });

  it("strips <style> tags", () => {
    const html = renderMarkdownSafe("<style>body{display:none}</style>");
    expect(html).not.toContain("<style>");
    expect(html).not.toContain("display:none");
  });

  it("strips event handlers from allowed elements", () => {
    // With allowDangerousHtml: false, remark-rehype won't pass HTML through,
    // so raw HTML is treated as text. This is the correct behavior.
    const md = '[click me](javascript:alert("xss"))';
    const html = renderMarkdownSafe(md);
    expect(html).not.toContain("javascript:");
  });

  it("strips javascript: protocol from links", () => {
    // remark won't parse this as a link, but if it did, rehype-sanitize strips it
    const html = renderMarkdownSafe("[x](javascript:void(0))");
    expect(html).not.toContain("javascript:");
  });

  it("strips data: protocol from images", () => {
    const html = renderMarkdownSafe("![x](data:image/png;base64,abc)");
    // data: protocol not in allowed list
    expect(html).not.toContain("data:");
  });

  it("strips iframe tags", () => {
    const html = renderMarkdownSafe('<iframe src="https://evil.com"></iframe>');
    expect(html).not.toContain("<iframe");
  });

  it("strips form elements", () => {
    const html = renderMarkdownSafe('<form action="/steal"><input type="text"></form>');
    expect(html).not.toContain("<form");
  });

  it("strips onclick attributes", () => {
    // Raw HTML is not passed through by remark-rehype with allowDangerousHtml: false
    const html = renderMarkdownSafe('<a href="#" onclick="alert(1)">click</a>');
    expect(html).not.toContain("onclick");
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it("handles empty input", () => {
    const html = renderMarkdownSafe("");
    expect(html).toBe("");
  });

  it("handles whitespace-only input", () => {
    const html = renderMarkdownSafe("   \n\n   ");
    expect(html.trim()).toBe("");
  });

  it("preserves multiple paragraphs", () => {
    const html = renderMarkdownSafe("Paragraph 1\n\nParagraph 2");
    expect(html).toContain("<p>Paragraph 1</p>");
    expect(html).toContain("<p>Paragraph 2</p>");
  });
});
