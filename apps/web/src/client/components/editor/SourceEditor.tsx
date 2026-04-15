import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown as markdownLang } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  lineNumbers,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";

// ---------------------------------------------------------------------------
// Theme — matches OKLCh design tokens
// ---------------------------------------------------------------------------

const editorTheme = EditorView.theme({
  "&": {
    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
    fontSize: "13px",
    lineHeight: "1.5",
    height: "100%",
    color: "var(--color-primary)",
    backgroundColor: "transparent",
  },
  ".cm-content": {
    padding: "1.5rem 2rem",
    caretColor: "var(--color-ironlore-blue)",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--color-ironlore-blue)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "oklch(from var(--color-ironlore-blue) l c h / 0.35)",
  },
  ".cm-activeLine": {
    backgroundColor: "oklch(from var(--color-ironlore-slate-hover) l c h / 0.5)",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--color-secondary)",
    borderRight: "1px solid var(--color-border)",
    paddingRight: "0.5rem",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "oklch(0.28 0.01 260)",
    color: "var(--color-primary)",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-scroller": {
    overflow: "auto",
  },
  ".cm-block-id": {
    opacity: "0.35",
  },
  ".cm-frontmatter": {
    opacity: "0.28",
    fontSize: "11px",
    lineHeight: "1.35",
  },
});

// ---------------------------------------------------------------------------
// Block-ID comment dimming
//
// Markdown blocks that have been written through the StorageWriter carry
// an HTML comment (`<!-- #blk_<ULID> -->`) anchored to the last line of
// the block. They are load-bearing metadata but they break reading flow
// at this density, so source mode keeps them visible (you may want to
// copy a citation) while painting them at low opacity.
// ---------------------------------------------------------------------------

const BLOCK_ID_COMMENT_RE = /<!-- #blk_[A-Z0-9]{26} -->/g;

const blockIdMark = Decoration.mark({ class: "cm-block-id" });
const frontmatterLineDec = Decoration.line({ attributes: { class: "cm-frontmatter" } });

function blockIdDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;

  // ─── Frontmatter: the leading `---`/`---` YAML block is metadata, not
  // prose. We paint it at very low opacity so it recedes but stays
  // editable (users occasionally need to touch `tags` or `title`). The
  // content is the source of truth, so we never strip it — just dim.
  const firstLine = doc.line(1).text;
  if (firstLine === "---") {
    let endLine = -1;
    for (let i = 2; i <= Math.min(doc.lines, 50); i++) {
      if (doc.line(i).text === "---") {
        endLine = i;
        break;
      }
    }
    if (endLine > 0) {
      for (let i = 1; i <= endLine; i++) {
        builder.add(doc.line(i).from, doc.line(i).from, frontmatterLineDec);
      }
    }
  }

  // ─── Block-ID comments appended to the last line of any block.
  for (const { from, to } of view.visibleRanges) {
    const text = doc.sliceString(from, to);
    BLOCK_ID_COMMENT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration pattern
    while ((match = BLOCK_ID_COMMENT_RE.exec(text)) !== null) {
      const start = from + match.index;
      builder.add(start, start + match[0].length, blockIdMark);
    }
  }
  return builder.finish();
}

const dimBlockIds: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = blockIdDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = blockIdDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

const highlightStyle = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.heading, fontWeight: "600", color: "var(--color-primary)" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strong, fontWeight: "700" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
    { tag: tags.link, color: "var(--color-ironlore-blue)" },
    { tag: tags.url, color: "var(--color-ironlore-blue)", textDecoration: "underline" },
    { tag: tags.monospace, color: "oklch(0.70 0.10 145)" },
    { tag: tags.meta, color: "var(--color-secondary)" },
    { tag: tags.processingInstruction, color: "var(--color-secondary)" },
    { tag: tags.quote, color: "var(--color-secondary)", fontStyle: "italic" },
  ]),
);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SourceEditorProps {
  markdown: string;
  onChange: (markdown: string) => void;
}

export function SourceEditor({ markdown, onChange }: SourceEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Mount CodeMirror
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only effect; markdown sync is handled by the separate useEffect below
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current(update.state.doc.toString());
      }
    });

    const state = EditorState.create({
      doc: markdown,
      extensions: [
        lineNumbers(),
        history(),
        search(),
        markdownLang(),
        editorTheme,
        highlightStyle,
        dimBlockIds,
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        updateListener,
        EditorView.lineWrapping,
      ],
    });

    const view = new EditorView({ state, parent: container });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Sync external markdown changes (e.g., after merge or mode switch)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const currentDoc = view.state.doc.toString();
    if (currentDoc === markdown) return;

    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: markdown,
      },
    });
  }, [markdown]);

  return <div ref={containerRef} className="h-full overflow-hidden" />;
}
