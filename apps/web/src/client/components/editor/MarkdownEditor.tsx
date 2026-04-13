import { baseKeymap, toggleMark } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import {
  ellipsis,
  emDash,
  inputRules,
  smartQuotes,
  wrappingInputRule,
} from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import { defaultMarkdownParser, defaultMarkdownSerializer } from "prosemirror-markdown";
import type { Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { useCallback, useEffect, useRef } from "react";
import "./editor.css";

// ---------------------------------------------------------------------------
// Block-ID preservation
// ---------------------------------------------------------------------------

/**
 * Regex matching Ironlore block-ID HTML comments.
 * These are injected by the server's `assignBlockIds()` and must survive
 * roundtrips through the editor without loss.
 */
const BLOCK_ID_RE = /<!-- #blk_[A-Z0-9]{26} -->/g;

/**
 * Strip block-ID comments before feeding markdown into ProseMirror.
 * Block IDs are structural metadata managed by the server — the editor
 * doesn't need to display or edit them.
 *
 * Returns the cleaned markdown and a map of line numbers → block IDs
 * for reinsertion on save.
 */
function stripBlockIds(markdown: string): {
  cleaned: string;
  blockIds: Map<number, string>;
} {
  const blockIds = new Map<number, string>();
  const lines = markdown.split("\n");
  const cleaned: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = line.match(/<!-- #(blk_[A-Z0-9]{26}) -->/);
    if (match) {
      blockIds.set(cleaned.length, match[1]!);
      const stripped = line.replace(BLOCK_ID_RE, "").trimEnd();
      cleaned.push(stripped);
    } else {
      cleaned.push(line);
    }
  }

  return { cleaned: cleaned.join("\n"), blockIds };
}

/**
 * Reinsert block IDs into markdown after ProseMirror serialization.
 * Uses the saved line → blockId map from `stripBlockIds`. New blocks
 * (lines that didn't previously have an ID) are left for the server's
 * `assignBlockIds()` to handle on PUT.
 */
function reinsertBlockIds(markdown: string, blockIds: Map<number, string>): string {
  if (blockIds.size === 0) return markdown;

  const lines = markdown.split("\n");
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const blockId = blockIds.get(i);
    if (blockId && !lines[i]!.includes(`<!-- #${blockId} -->`)) {
      result.push(`${lines[i]} <!-- #${blockId} -->`);
    } else {
      result.push(lines[i]!);
    }
  }

  return result.join("\n");
}

// ---------------------------------------------------------------------------
// Input rules
// ---------------------------------------------------------------------------

function buildInputRules(schema: Schema) {
  const rules = [...smartQuotes, ellipsis, emDash];

  // > blockquote
  if (schema.nodes.blockquote) {
    rules.push(wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote));
  }

  return inputRules({ rules });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface MarkdownEditorProps {
  markdown: string;
  onChange: (markdown: string) => void;
  onSelectionChange?: (selection: { from: number; to: number } | null) => void;
}

export function MarkdownEditor({ markdown, onChange, onSelectionChange }: MarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const blockIdsRef = useRef<Map<number, string>>(new Map());
  const onChangeRef = useRef(onChange);
  const onSelectionChangeRef = useRef(onSelectionChange);
  // Track whether we're programmatically updating (external markdown change)
  const suppressRef = useRef(false);

  // Keep callback refs current without recreating the editor
  onChangeRef.current = onChange;
  onSelectionChangeRef.current = onSelectionChange;

  const createView = useCallback(
    (container: HTMLDivElement) => {
      const { cleaned, blockIds } = stripBlockIds(markdown);
      blockIdsRef.current = blockIds;

      const schema = defaultMarkdownParser.schema;
      const doc = defaultMarkdownParser.parse(cleaned);
      if (!doc) return null;

      const state = EditorState.create({
        doc,
        plugins: [
          buildInputRules(schema),
          keymap({
            "Mod-z": undo,
            "Mod-Shift-z": redo,
            "Mod-y": redo,
            "Mod-b": toggleMark(schema.marks.strong),
            "Mod-i": toggleMark(schema.marks.em),
            "Mod-`": toggleMark(schema.marks.code),
          }),
          keymap(baseKeymap),
          history(),
        ],
      });

      const view = new EditorView(container, {
        state,
        dispatchTransaction(tr) {
          const newState = view.state.apply(tr);
          view.updateState(newState);

          if (tr.docChanged && !suppressRef.current) {
            const serialized = defaultMarkdownSerializer.serialize(newState.doc);
            const withIds = reinsertBlockIds(serialized, blockIdsRef.current);
            onChangeRef.current(withIds);
          }

          if (tr.selectionSet && onSelectionChangeRef.current) {
            const { from, to } = newState.selection;
            onSelectionChangeRef.current(from === to ? null : { from, to });
          }
        },
      });

      return view;
    },
    // Only recreate view when markdown identity changes from outside
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Mount / unmount the editor view
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const view = createView(container);
    viewRef.current = view;

    return () => {
      view?.destroy();
      viewRef.current = null;
    };
  }, [createView]);

  // Sync external markdown changes into the editor (e.g., after merge)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const { cleaned, blockIds } = stripBlockIds(markdown);
    const currentSerialized = defaultMarkdownSerializer.serialize(view.state.doc);

    // Don't replace if content matches — avoids cursor jumps
    if (currentSerialized === cleaned) return;

    blockIdsRef.current = blockIds;
    const doc = defaultMarkdownParser.parse(cleaned);
    if (!doc) return;

    suppressRef.current = true;
    const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
    view.dispatch(tr);
    suppressRef.current = false;
  }, [markdown]);

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto px-8 py-6"
      aria-label="Markdown editor"
    />
  );
}
