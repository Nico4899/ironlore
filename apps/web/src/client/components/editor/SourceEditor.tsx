import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown as markdownLang } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
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
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "oklch(0.35 0.05 255 / 0.5)",
  },
  ".cm-activeLine": {
    backgroundColor: "oklch(0.28 0.01 260)",
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
});

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

  return <div ref={containerRef} className="overflow-hidden" style={{ flex: "1 1 50%" }} />;
}
