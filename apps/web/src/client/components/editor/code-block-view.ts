import Prism from "prismjs";
// Load grammars up front so the first highlight doesn't pay a
//  dynamic-import round-trip. Order matters: `jsx` needs `markup`
//  and `javascript`; `tsx` needs `jsx` and `typescript`. Keep the
//  dependency chain intact or Prism will crash on load.
import "prismjs/components/prism-markup.js";
import "prismjs/components/prism-clike.js";
import "prismjs/components/prism-javascript.js";
import "prismjs/components/prism-markup-templating.js";
import "prismjs/components/prism-typescript.js";
import "prismjs/components/prism-jsx.js";
import "prismjs/components/prism-tsx.js";
import "prismjs/components/prism-bash.js";
import "prismjs/components/prism-css.js";
import "prismjs/components/prism-diff.js";
import "prismjs/components/prism-go.js";
import "prismjs/components/prism-json.js";
import "prismjs/components/prism-markdown.js";
import "prismjs/components/prism-python.js";
import "prismjs/components/prism-rust.js";
import "prismjs/components/prism-sql.js";
import "prismjs/components/prism-yaml.js";
import type { Node } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView, type NodeView } from "prosemirror-view";

/**
 * Curated language list for the code-block dropdown. Extending
 * this is (a) add a grammar import above, (b) push an entry here.
 * The first column is what's written into the markdown fence;
 * the second is what shows in the dropdown.
 */
export const CODE_LANGUAGES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "plain" },
  { value: "bash", label: "bash" },
  { value: "css", label: "css" },
  { value: "diff", label: "diff" },
  { value: "go", label: "go" },
  { value: "html", label: "html" },
  { value: "javascript", label: "javascript" },
  { value: "json", label: "json" },
  { value: "markdown", label: "markdown" },
  { value: "python", label: "python" },
  { value: "rust", label: "rust" },
  { value: "sql", label: "sql" },
  { value: "tsx", label: "tsx" },
  { value: "typescript", label: "typescript" },
  { value: "yaml", label: "yaml" },
];

// Prism loads `markup` (HTML) as a base grammar; alias it so
//  users can pick it as `html` in the dropdown.
const LANG_ALIAS: Record<string, string> = {
  html: "markup",
  ts: "typescript",
  js: "javascript",
  py: "python",
};

function resolveGrammarKey(raw: string): string {
  const key = raw.trim().toLowerCase();
  return LANG_ALIAS[key] ?? key;
}

// ---------------------------------------------------------------------------
// NodeView — just the chrome (language selector + pre/code shell).
//
// Why a NodeView and not a plain toDOM? We need a dropdown that is
// *not* content-editable and that mutates the node's `params` attr.
// That's the role of a NodeView; highlighting is handled by a
// separate plugin (below) using Decorations so the editor's
// selection and text-input paths keep working normally.
// ---------------------------------------------------------------------------

export class CodeBlockView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private codeEl: HTMLElement;
  private select: HTMLSelectElement;

  constructor(
    private node: Node,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    const wrapper = document.createElement("div");
    wrapper.className = "il-codeblock";

    const bar = document.createElement("div");
    bar.className = "il-codeblock__bar";
    bar.contentEditable = "false";

    const label = document.createElement("span");
    label.className = "il-codeblock__label";
    label.textContent = "lang";
    bar.appendChild(label);

    this.select = document.createElement("select");
    this.select.className = "il-codeblock__select";
    for (const { value, label: displayLabel } of CODE_LANGUAGES) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = displayLabel;
      this.select.appendChild(opt);
    }
    this.select.value = String(node.attrs.params ?? "");
    this.select.addEventListener("change", this.onLanguageChange);
    this.select.addEventListener("mousedown", (e) => e.stopPropagation());
    bar.appendChild(this.select);

    const pre = document.createElement("pre");
    pre.className = "il-codeblock__pre";
    this.codeEl = document.createElement("code");
    this.codeEl.className = this.grammarClass();
    pre.appendChild(this.codeEl);

    wrapper.appendChild(bar);
    wrapper.appendChild(pre);

    this.dom = wrapper;
    this.contentDOM = this.codeEl;
  }

  private onLanguageChange = (e: Event) => {
    e.stopPropagation();
    const value = (e.target as HTMLSelectElement).value;
    const pos = this.getPos();
    if (pos === undefined) return;
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(pos, undefined, {
        ...this.node.attrs,
        params: value,
      }),
    );
  };

  private grammarClass(): string {
    const raw = String(this.node.attrs.params ?? "").trim();
    if (!raw) return "language-none";
    return `language-${resolveGrammarKey(raw)}`;
  }

  update(node: Node): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    const nextParams = String(node.attrs.params ?? "");
    if (this.select.value !== nextParams) this.select.value = nextParams;
    this.codeEl.className = this.grammarClass();
    return true;
  }

  // The language dropdown events are chrome — let the browser handle
  //  them, don't let ProseMirror swallow them.
  stopEvent(event: Event): boolean {
    const target = event.target as HTMLElement | null;
    return !!target?.closest(".il-codeblock__bar");
  }

  destroy(): void {
    this.select.removeEventListener("change", this.onLanguageChange);
  }
}

// ---------------------------------------------------------------------------
// Highlight plugin — walks every code_block in the doc, tokenises
// with Prism, and produces Decoration.inline ranges. The decorations
// carry Prism's `token.type` as CSS class names so editor.css can
// theme them consistently with the rest of the app.
// ---------------------------------------------------------------------------

const codeHighlightKey = new PluginKey("ironlore-code-highlight");

interface PrismTokenLike {
  content: string | Array<PrismTokenLike | string>;
  type?: string;
  alias?: string | string[];
}

/**
 * Walk Prism's token tree, emitting `[from, to, classes]` ranges
 * relative to `base` (the position of the code-block's first
 * character in the doc). Nested tokens inherit their parent's
 * classes so a string-inside-a-template literal, for example, is
 * tagged with both `token template-string` and `token string`.
 */
function collectRanges(
  tokens: ReadonlyArray<PrismTokenLike | string>,
  base: number,
  parentClasses: string,
  out: Array<{ from: number; to: number; classes: string }>,
): number {
  let pos = base;
  for (const token of tokens) {
    if (typeof token === "string") {
      pos += token.length;
      continue;
    }
    const typeClasses = ["token", token.type ?? ""]
      .concat(
        Array.isArray(token.alias)
          ? token.alias
          : typeof token.alias === "string"
            ? [token.alias]
            : [],
      )
      .filter(Boolean)
      .join(" ");
    const fullClasses = parentClasses ? `${parentClasses} ${typeClasses}` : typeClasses;
    if (typeof token.content === "string") {
      const len = token.content.length;
      if (len > 0) {
        out.push({ from: pos, to: pos + len, classes: fullClasses });
      }
      pos += len;
    } else {
      pos = collectRanges(token.content, pos, fullClasses, out);
    }
  }
  return pos;
}

/**
 * ProseMirror plugin — produces Decoration.inline ranges for every
 * `code_block` in the doc, tokenised by Prism. The decorations are
 * recomputed only when the document changes; `apply` short-circuits
 * for selection-only transactions.
 */
export function codeHighlightPlugin(): Plugin {
  return new Plugin({
    key: codeHighlightKey,
    state: {
      init(_config, state) {
        return buildDecorations(state.doc);
      },
      apply(tr, oldSet) {
        if (!tr.docChanged) return oldSet;
        return buildDecorations(tr.doc);
      },
    },
    props: {
      decorations(state) {
        return codeHighlightKey.getState(state) as DecorationSet;
      },
    },
  });
}

function buildDecorations(doc: Node): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "code_block") return true;
    const raw = String(node.attrs.params ?? "").trim();
    if (!raw) return false;
    const grammarKey = resolveGrammarKey(raw);
    const grammar = Prism.languages[grammarKey];
    if (!grammar) return false;
    const text = node.textContent;
    const tokens = Prism.tokenize(text, grammar) as Array<PrismTokenLike | string>;
    const ranges: Array<{ from: number; to: number; classes: string }> = [];
    // `+1` because the doc position points at the node opening;
    //  its first text character is one further in.
    collectRanges(tokens, pos + 1, "", ranges);
    for (const r of ranges) {
      decorations.push(Decoration.inline(r.from, r.to, { class: r.classes }));
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
}
