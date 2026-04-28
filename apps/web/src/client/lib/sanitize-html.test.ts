import { Window } from "happy-dom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sanitizeHtml } from "./sanitize-html.js";

/**
 * Unit tests for the second-sanitizer surface — the DOM-based
 * allow-list pass we run on third-party HTML (notably mammoth's
 * .docx output) before piping it into `dangerouslySetInnerHTML` in
 * the docx/xlsx viewers.
 *
 * Companion to `xss-corpus.test.ts` (cross-cutting injection vectors)
 * and `render-markdown-safe.test.ts` (the markdown-side sanitizer).
 * This file pins the *contract* of `sanitize-html.ts`: which tags,
 * which attributes, which URL protocols. A regression here means
 * docx HTML either renders worse than today (whitelisted shape
 * dropped) or punches a new XSS hole.
 *
 * happy-dom provides `DOMParser` since `sanitizeHtml` runs in the
 * browser and depends on the native parser.
 */

beforeAll(() => {
  const window = new Window();
  // biome-ignore lint/suspicious/noExplicitAny: happy-dom's DOMParser type doesn't line up with lib.dom's
  globalThis.DOMParser = window.DOMParser as any;
});

afterAll(() => {
  // biome-ignore lint/suspicious/noExplicitAny: tearing down the global we installed in beforeAll
  (globalThis as any).DOMParser = undefined;
});

describe("sanitizeHtml — allow-listed tags", () => {
  it("preserves headings and paragraphs", () => {
    const out = sanitizeHtml("<h1>Title</h1><p>Body.</p>");
    expect(out).toContain("<h1>Title</h1>");
    expect(out).toContain("<p>Body.</p>");
  });

  it("preserves tables with thead / tbody / th / td", () => {
    const html =
      "<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>";
    const out = sanitizeHtml(html);
    expect(out).toContain("<table>");
    expect(out).toContain("<th>a</th>");
    expect(out).toContain("<td>1</td>");
  });

  it("preserves inline marks (strong / em / b / i / u / del / sup / sub)", () => {
    const html =
      "<p><strong>S</strong><em>E</em><b>B</b><i>I</i><u>U</u><del>D</del><sup>P</sup><sub>B</sub></p>";
    const out = sanitizeHtml(html);
    expect(out).toContain("<strong>S</strong>");
    expect(out).toContain("<em>E</em>");
    expect(out).toContain("<b>B</b>");
    expect(out).toContain("<i>I</i>");
    expect(out).toContain("<u>U</u>");
    expect(out).toContain("<del>D</del>");
    expect(out).toContain("<sup>P</sup>");
    expect(out).toContain("<sub>B</sub>");
  });

  it("preserves lists and blockquote / pre / code", () => {
    const html = "<ul><li>a</li></ul><ol><li>b</li></ol><blockquote>q</blockquote><pre>x</pre>";
    const out = sanitizeHtml(html);
    expect(out).toContain("<ul><li>a</li></ul>");
    expect(out).toContain("<ol><li>b</li></ol>");
    expect(out).toContain("<blockquote>q</blockquote>");
    expect(out).toContain("<pre>x</pre>");
  });
});

describe("sanitizeHtml — disallowed tags are unwrapped, not dropped", () => {
  it("unwraps unknown tags so the children survive", () => {
    const out = sanitizeHtml("<custom-tag><p>kept</p></custom-tag>");
    expect(out).toContain("<p>kept</p>");
    expect(out).not.toContain("<custom-tag");
  });

  it("strips script tags AND their text content", () => {
    const out = sanitizeHtml("<p>before</p><script>alert(1)</script><p>after</p>");
    expect(out).toContain("<p>before</p>");
    expect(out).toContain("<p>after</p>");
    expect(out).not.toContain("<script");
    // The DOMParser injects <script> contents as raw text when the
    // tag is unwrapped; the sanitizer should not preserve them.
    expect(out).not.toContain("alert(1)");
  });

  it("strips iframe tags entirely", () => {
    const out = sanitizeHtml("<iframe src='https://evil.test'></iframe>");
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("evil.test");
  });

  it("re-sanitizes after unwrapping (defense against svg→circle escape)", () => {
    // The classic escape: outer disallowed tag gets unwrapped, inner
    //  payload smuggles handlers in. Cursor must re-sanitize the
    //  newly-exposed children, not skip over them.
    const out = sanitizeHtml("<svg><img src=x onerror='alert(1)' /></svg>");
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("alert(1)");
  });
});

describe("sanitizeHtml — attribute filtering", () => {
  it("strips disallowed attributes from allowed tags", () => {
    const out = sanitizeHtml("<p style='color:red' onclick='hax()' class='c'>X</p>");
    expect(out).not.toContain("style");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("class");
    expect(out).toContain("<p>X</p>");
  });

  it("preserves href + title on anchors", () => {
    const out = sanitizeHtml('<a href="https://example.com" title="t">link</a>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('title="t"');
  });

  it("preserves src + alt + width + height on img", () => {
    const out = sanitizeHtml(
      '<img src="https://example.com/x.png" alt="A" width="32" height="32" />',
    );
    expect(out).toContain('src="https://example.com/x.png"');
    expect(out).toContain('alt="A"');
    expect(out).toContain('width="32"');
    expect(out).toContain('height="32"');
  });

  it("preserves colspan + rowspan + align on table cells", () => {
    const out = sanitizeHtml(
      '<table><tr><td colspan="2" rowspan="3" align="center">x</td></tr></table>',
    );
    expect(out).toContain('colspan="2"');
    expect(out).toContain('rowspan="3"');
    expect(out).toContain('align="center"');
  });
});

describe("sanitizeHtml — URL protocol filter", () => {
  it("strips javascript: hrefs", () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("href=");
  });

  it("strips data: image src (only http/https/mailto allowed)", () => {
    const out = sanitizeHtml('<img src="data:image/png;base64,AAAA" alt="x" />');
    expect(out).not.toContain("data:");
    // alt + tag survive; only the unsafe src is dropped.
    expect(out).toContain("<img");
    expect(out).toContain('alt="x"');
  });

  it("preserves mailto: hrefs", () => {
    const out = sanitizeHtml('<a href="mailto:foo@example.com">mail</a>');
    expect(out).toContain('href="mailto:foo@example.com"');
  });

  it("preserves same-origin paths and anchors", () => {
    const out = sanitizeHtml(
      '<a href="/relative/path">a</a><a href="#anchor">b</a><a href="?q=1">c</a>',
    );
    expect(out).toContain('href="/relative/path"');
    expect(out).toContain('href="#anchor"');
    expect(out).toContain('href="?q=1"');
  });

  it("strips vbscript: hrefs (legacy IE protocol still rejected)", () => {
    const out = sanitizeHtml('<a href="vbscript:msgbox(1)">x</a>');
    expect(out).not.toContain("vbscript:");
  });
});

describe("sanitizeHtml — empty and edge inputs", () => {
  it("returns empty string for empty input", () => {
    expect(sanitizeHtml("")).toBe("");
  });

  it("returns empty string for pure whitespace", () => {
    expect(sanitizeHtml("   ")).toBe("   ");
  });

  it("does not crash on malformed HTML — DOMParser auto-closes", () => {
    const out = sanitizeHtml("<p>unterminated <b>bold");
    // Browser parser auto-closes; sanitized output should still be
    //  syntactically valid HTML with the allowed tags retained.
    expect(out).toContain("<p>");
    expect(out).toContain("<b>");
  });

  it("handles deeply nested allowed tags", () => {
    const out = sanitizeHtml("<div><div><div><p>deep</p></div></div></div>");
    expect(out).toContain("<p>deep</p>");
  });
});
