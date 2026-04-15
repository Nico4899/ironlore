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
import type { Schema } from "prosemirror-model";
import { EditorState, type Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../../stores/app.js";
import {
  buildSlashItems,
  filterSlashItems,
  getSlashContext,
  type SlashItem,
} from "./slash-menu.js";
import { wikiMarkdownParser, wikiMarkdownSerializer } from "./wiki-markdown.js";
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
 * YAML frontmatter at the top of a markdown file. ProseMirror has no schema
 * for it, so leaving it in would render as prose. We peel it off before
 * parsing and restore it verbatim on serialize.
 */
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

function splitFrontmatter(markdown: string): { frontmatter: string; body: string } {
  const match = markdown.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: "", body: markdown };
  return { frontmatter: match[0], body: markdown.slice(match[0].length) };
}

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

  for (const line of lines) {
    const match = line.match(/<!-- #(blk_[A-Z0-9]{26}) -->/);
    if (match?.[1]) {
      blockIds.set(cleaned.length, match[1]);
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
    const line = lines[i] ?? "";
    const blockId = blockIds.get(i);
    if (blockId && !line.includes(`<!-- #${blockId} -->`)) {
      result.push(`${line} <!-- #${blockId} -->`);
    } else {
      result.push(line);
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

/** UI state for the slash-command popup. */
interface SlashMenuState {
  items: SlashItem[];
  index: number;
  query: string;
  /** Viewport-relative coords, used for fixed positioning. */
  coords: { left: number; top: number };
  /** Positions in the doc that cover the `/query` trigger text. */
  from: number;
  to: number;
}

export function MarkdownEditor({ markdown, onChange, onSelectionChange }: MarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const blockIdsRef = useRef<Map<number, string>>(new Map());
  const frontmatterRef = useRef<string>("");
  const onChangeRef = useRef(onChange);
  const onSelectionChangeRef = useRef(onSelectionChange);
  // Track whether we're programmatically updating (external markdown change)
  const suppressRef = useRef(false);

  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null);
  // Ref mirror so the EditorView `handleKeyDown` prop (bound once at mount)
  // can see the latest menu state without reinstalling the prop.
  const slashMenuRef = useRef<SlashMenuState | null>(null);
  slashMenuRef.current = slashMenu;

  // Keep callback refs current without recreating the editor
  onChangeRef.current = onChange;
  onSelectionChangeRef.current = onSelectionChange;

  /**
   * Run a slash-menu item: delete the `/query` trigger text, then execute
   * the item's command against the resulting clean state. The view's
   * dispatch is idempotent so synchronous chaining is safe.
   */
  const runSlashItem = useCallback((item: SlashItem, from: number, to: number) => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch(view.state.tr.delete(from, to));
    item.run(view.state, view.dispatch);
    view.focus();
    setSlashMenu(null);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only callback; external markdown sync handled by separate useEffect
  const createView = useCallback((container: HTMLDivElement) => {
    const { frontmatter, body } = splitFrontmatter(markdown);
    frontmatterRef.current = frontmatter;
    const { cleaned, blockIds } = stripBlockIds(body);
    blockIdsRef.current = blockIds;

    const schema = wikiMarkdownParser.schema;
    const doc = wikiMarkdownParser.parse(cleaned);
    if (!doc) return null;

    // The default markdown schema always has these marks
    const { strong, em, code } = schema.marks;
    const markKeys: Record<string, (s: EditorState, d?: (tr: Transaction) => void) => boolean> = {};
    if (strong) markKeys["Mod-b"] = toggleMark(strong);
    if (em) markKeys["Mod-i"] = toggleMark(em);
    if (code) markKeys["Mod-`"] = toggleMark(code);

    const state = EditorState.create({
      doc,
      plugins: [
        buildInputRules(schema),
        keymap({
          "Mod-z": undo,
          "Mod-Shift-z": redo,
          "Mod-y": redo,
          ...markKeys,
        }),
        keymap(baseKeymap),
        history(),
      ],
    });

    const allItems = buildSlashItems(schema);

    const view = new EditorView(container, {
      state,
      handleKeyDown(_v, event) {
        const menu = slashMenuRef.current;
        if (!menu || menu.items.length === 0) return false;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setSlashMenu((m) => (m ? { ...m, index: (m.index + 1) % m.items.length } : m));
          return true;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setSlashMenu((m) =>
            m ? { ...m, index: (m.index - 1 + m.items.length) % m.items.length } : m,
          );
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          const item = menu.items[menu.index];
          if (item) runSlashItem(item, menu.from, menu.to);
          return true;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setSlashMenu(null);
          return true;
        }
        return false;
      },
      handleDOMEvents: {
        // ProseMirror consumes clicks on marks by default so <a> anchors are
        // inert. Intercept the click and open external links in a new tab;
        // internal links (no scheme or same-origin) route through the app.
        click: (_v, event) => {
          const target = event.target as HTMLElement | null;
          const anchor = target?.closest("a");
          if (!anchor) return false;
          const href = anchor.getAttribute("href");
          if (!href) return false;
          event.preventDefault();
          if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
            window.open(href, "_blank", "noopener,noreferrer");
          } else {
            const withExt = href.endsWith(".md") ? href : `${href}.md`;
            useAppStore.getState().setActivePath(withExt);
          }
          return true;
        },
      },
      nodeViews: {
        wikilink: (node) => {
          const dom = document.createElement("span");
          const { target, display } = node.attrs as { target: string; display: string | null };
          dom.className = "ir-wikilink";
          dom.dataset.wikilink = target;
          dom.textContent = display ?? target;
          dom.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            // Strip any `#blk_…` anchor for navigation; anchor handling is
            // polish (scroll-to-block) and not required for Phase 2.
            const hashIdx = target.indexOf("#");
            const pagePath = hashIdx === -1 ? target : target.slice(0, hashIdx);
            if (pagePath) {
              const withExt = pagePath.endsWith(".md") ? pagePath : `${pagePath}.md`;
              useAppStore.getState().setActivePath(withExt);
            }
          });
          return { dom };
        },
      },
      dispatchTransaction(tr) {
        const newState = view.state.apply(tr);
        view.updateState(newState);

        if (tr.docChanged && !suppressRef.current) {
          const serialized = wikiMarkdownSerializer.serialize(newState.doc);
          const withIds = reinsertBlockIds(serialized, blockIdsRef.current);
          onChangeRef.current(frontmatterRef.current + withIds);
        }

        if (tr.selectionSet && onSelectionChangeRef.current) {
          const { from, to } = newState.selection;
          onSelectionChangeRef.current(from === to ? null : { from, to });
        }

        // Recompute slash-menu state after every transaction so the popup
        // tracks the cursor and filters as the user types.
        const ctx = getSlashContext(newState);
        if (!ctx) {
          if (slashMenuRef.current) setSlashMenu(null);
          return;
        }
        const filtered = filterSlashItems(allItems, ctx.query);
        if (filtered.length === 0) {
          if (slashMenuRef.current) setSlashMenu(null);
          return;
        }
        const coords = view.coordsAtPos(newState.selection.head);
        setSlashMenu((prev) => ({
          items: filtered,
          // Clamp carry-over selection when the list shrinks from filtering.
          index: prev ? Math.min(prev.index, filtered.length - 1) : 0,
          query: ctx.query,
          coords: { left: coords.left, top: coords.bottom },
          from: ctx.from,
          to: ctx.to,
        }));
      },
    });

    return view;
  }, []);

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

    const { frontmatter, body } = splitFrontmatter(markdown);
    frontmatterRef.current = frontmatter;
    const { cleaned, blockIds } = stripBlockIds(body);
    const currentSerialized = wikiMarkdownSerializer.serialize(view.state.doc);

    // Don't replace if content matches — avoids cursor jumps
    if (currentSerialized === cleaned) return;

    blockIdsRef.current = blockIds;
    const doc = wikiMarkdownParser.parse(cleaned);
    if (!doc) return;

    suppressRef.current = true;
    const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
    view.dispatch(tr);
    suppressRef.current = false;
  }, [markdown]);

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <div ref={containerRef} className="flex-1 overflow-y-auto px-8 py-6" />
      {slashMenu && (
        <div
          role="listbox"
          aria-label="Slash commands"
          className="fixed z-50 min-w-56 rounded border border-border bg-ironlore-slate py-1 shadow-lg"
          style={{ left: slashMenu.coords.left, top: slashMenu.coords.top + 4 }}
        >
          {slashMenu.items.map((item, i) => (
            <div key={item.title}>
              <button
                type="button"
                role="option"
                aria-selected={i === slashMenu.index}
                onMouseDown={(e) => {
                  // Run on mousedown so the editor doesn't lose its selection
                  // to the button focus before the command reads state.
                  e.preventDefault();
                  runSlashItem(item, slashMenu.from, slashMenu.to);
                }}
                onMouseEnter={() => setSlashMenu((m) => (m ? { ...m, index: i } : m))}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
                  i === slashMenu.index
                    ? "bg-ironlore-slate-hover text-primary"
                    : "text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
                }`}
              >
                <span className="text-secondary">{item.icon}</span>
                <span className="flex flex-col">
                  <span className="font-medium text-primary">{item.title}</span>
                  <span className="text-[11px] text-secondary">{item.description}</span>
                </span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
