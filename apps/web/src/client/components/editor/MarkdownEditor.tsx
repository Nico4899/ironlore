import { Sparkles } from "lucide-react";
import { baseKeymap, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
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
import { liftListItem, sinkListItem, splitListItem } from "prosemirror-schema-list";
import { EditorState, type Transaction } from "prosemirror-state";
import { columnResizing, goToNextCell, tableEditing } from "prosemirror-tables";
import { EditorView } from "prosemirror-view";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../../stores/app.js";
import { useTreeStore } from "../../stores/tree.js";
import { CodeBlockView, codeHighlightPlugin } from "./code-block-view.js";
import { type EditorCommands, registerEditorCommands } from "./editor-commands.js";
import {
  buildSlashItems,
  filterSlashItems,
  getSlashContext,
  type SlashItem,
} from "./slash-menu.js";
import { isInTable, TableToolbar } from "./TableToolbar.js";
import {
  filterWikiLinkCandidates,
  getWikiLinkContext,
  type WikiLinkCandidate,
} from "./wiki-link-menu.js";
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
/**
 * Strip block-ID comments, recording each ID alongside the cleaned line
 * text it used to live on. Reinsertion below uses the text as a
 * fingerprint so block IDs stick to their content even if ProseMirror
 * shifts lines around (inserts a new paragraph, reorders blocks, etc).
 *
 * A pure line-index map (the pre-fix behavior) silently attached IDs
 * to the wrong blocks when the line count changed — the server's
 * `assignBlockIds` then preserved those wrong assignments because its
 * contract is "don't overwrite existing IDs". Using a content-based
 * ledger is strictly more robust: unmatched entries are discarded
 * rather than ending up on an arbitrary line.
 */
export function stripBlockIds(markdown: string): {
  cleaned: string;
  entries: Array<{ id: string; text: string }>;
} {
  const entries: Array<{ id: string; text: string }> = [];
  const lines = markdown.split("\n");
  const cleaned: string[] = [];

  for (const line of lines) {
    const match = line.match(/<!-- #(blk_[A-Z0-9]{26}) -->/);
    if (match?.[1]) {
      const stripped = line.replace(BLOCK_ID_RE, "").trimEnd();
      entries.push({ id: match[1], text: stripped });
      cleaned.push(stripped);
    } else {
      cleaned.push(line);
    }
  }

  return { cleaned: cleaned.join("\n"), entries };
}

/**
 * Reinsert block IDs into markdown after ProseMirror serialization.
 *
 * Content-based: for each output line, try to find an unused entry
 * whose stored text matches exactly. Once matched, the entry is
 * consumed so a later duplicate line can't steal the same ID.
 * Entries that never find a match (block was deleted or substantially
 * edited) drop silently. Lines with no match stay plain — the server's
 * `assignBlockIds()` on PUT will stamp a fresh ULID on them.
 *
 * Exported for the block-id-preservation test suite.
 */
export function reinsertBlockIds(
  markdown: string,
  entries: Array<{ id: string; text: string }>,
): string {
  if (entries.length === 0) return markdown;

  const lines = markdown.split("\n");
  const result: string[] = [];
  const consumed = new Set<number>();

  for (const line of lines) {
    // If the line already carries a block ID, leave it alone — it
    // came back through the roundtrip intact.
    if (BLOCK_ID_RE.test(line)) {
      result.push(line);
      continue;
    }
    // Blank lines don't anchor block IDs.
    if (line.trim() === "") {
      result.push(line);
      continue;
    }
    // Find the first unused entry whose text matches.
    let matchedIdx = -1;
    for (let i = 0; i < entries.length; i++) {
      if (consumed.has(i)) continue;
      if (entries[i]?.text === line) {
        matchedIdx = i;
        break;
      }
    }
    if (matchedIdx >= 0) {
      consumed.add(matchedIdx);
      const id = entries[matchedIdx]?.id;
      result.push(`${line} <!-- #${id} -->`);
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

/**
 * UI state for the `[[…]]` wiki-link picker. Parallel to the slash
 * menu — at most one is open at a time, and they share the same
 * keyboard-navigation vocabulary (↑/↓, Enter, Esc).
 */
interface WikiLinkMenuState {
  items: WikiLinkCandidate[];
  index: number;
  query: string;
  coords: { left: number; top: number };
  /** Position of the leading `[[` in the doc. */
  from: number;
  /** Caret position at the end of the query. */
  to: number;
}

export function MarkdownEditor({ markdown, onChange, onSelectionChange }: MarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const blockIdsRef = useRef<Array<{ id: string; text: string }>>([]);
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

  const [wikiMenu, setWikiMenu] = useState<WikiLinkMenuState | null>(null);
  const wikiMenuRef = useRef<WikiLinkMenuState | null>(null);
  wikiMenuRef.current = wikiMenu;

  // Anchor for the floating TableToolbar. Populated by the
  //  dispatch-transaction scanner below when the caret moves into
  //  a table cell; null otherwise. Viewport-relative coordinates so
  //  the toolbar can use `position: fixed`.
  const [tableAnchor, setTableAnchor] = useState<{ top: number; left: number } | null>(null);

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

  /**
   * Commit a wiki-link candidate. Replaces the `[[query` trigger
   * span with a `wikilink` inline node whose `target` attr is the
   * chosen page's path. The schema's serializer renders this back
   * to `[[<path>]]` on save, so the on-disk format is plain
   * markdown — no custom HTML payload escapes the document.
   */
  const runWikiLinkItem = useCallback((candidate: WikiLinkCandidate, from: number, to: number) => {
    const view = viewRef.current;
    if (!view) return;
    const wikilinkType = view.state.schema.nodes.wikilink;
    if (!wikilinkType) {
      setWikiMenu(null);
      return;
    }
    const node = wikilinkType.create({ target: candidate.path });
    view.dispatch(view.state.tr.replaceWith(from, to, node));
    view.focus();
    setWikiMenu(null);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only callback; external markdown sync handled by separate useEffect
  const createView = useCallback((container: HTMLDivElement) => {
    const { frontmatter, body } = splitFrontmatter(markdown);
    frontmatterRef.current = frontmatter;
    const { cleaned, entries } = stripBlockIds(body);
    blockIdsRef.current = entries;

    const schema = wikiMarkdownParser.schema;
    const doc = wikiMarkdownParser.parse(cleaned);
    if (!doc) return null;

    // The default markdown schema always has these marks
    const { strong, em, code } = schema.marks;
    const markKeys: Record<string, (s: EditorState, d?: (tr: Transaction) => void) => boolean> = {};
    if (strong) markKeys["Mod-b"] = toggleMark(strong);
    if (em) markKeys["Mod-i"] = toggleMark(em);
    if (code) markKeys["Mod-`"] = toggleMark(code);

    // List keymap — `Enter` inside a list item splits it so the
    //  next line continues the list (fixes "pressing Enter drops
    //  out of the list"), Tab/Shift-Tab indent/outdent. Mounted
    //  BEFORE `baseKeymap` so the list commands claim Enter first
    //  when the caret is in a list item; outside lists the splits
    //  fall through to the default block-split behaviour.
    const { list_item } = schema.nodes;
    const listKeys: Record<string, (s: EditorState, d?: (tr: Transaction) => void) => boolean> = {};
    if (list_item) {
      listKeys.Enter = splitListItem(list_item);
      listKeys.Tab = sinkListItem(list_item);
      listKeys["Shift-Tab"] = liftListItem(list_item);
    }

    // Table editing — arrow-key + Tab navigation across cells,
    //  add/remove row/col commands, column-resize drag handle.
    //  `tableEditing` plugin also hooks selection so partial-cell
    //  selections behave sensibly.
    const state = EditorState.create({
      doc,
      plugins: [
        buildInputRules(schema),
        keymap({
          "Mod-z": undo,
          "Mod-Shift-z": redo,
          "Mod-y": redo,
          ...markKeys,
          // Tab inside a table moves to the next cell (Shift-Tab →
          //  previous). prosemirror-tables' keymap goes on top of
          //  the list keys so cell navigation wins inside tables.
          Tab: goToNextCell(1),
          "Shift-Tab": goToNextCell(-1),
        }),
        keymap(listKeys),
        keymap(baseKeymap),
        columnResizing(),
        tableEditing(),
        // Prism-backed syntax highlighting for code_block nodes —
        //  emits Decoration.inline ranges so ProseMirror keeps
        //  full ownership of text + selection.
        codeHighlightPlugin(),
        history(),
      ],
    });

    const allItems = buildSlashItems(schema);

    const view = new EditorView(container, {
      state,
      handleKeyDown(_v, event) {
        // Two menus share the navigation vocabulary (↑/↓, Enter,
        //  Tab, Esc). Wiki-link menu takes precedence over slash —
        //  they can't be simultaneously open, but if the user was
        //  mid-slash and typed `[[` the newer trigger wins.
        const wiki = wikiMenuRef.current;
        if (wiki && wiki.items.length > 0) {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setWikiMenu((m) => (m ? { ...m, index: (m.index + 1) % m.items.length } : m));
            return true;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setWikiMenu((m) =>
              m ? { ...m, index: (m.index - 1 + m.items.length) % m.items.length } : m,
            );
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            const pick = wiki.items[wiki.index];
            if (pick) runWikiLinkItem(pick, wiki.from, wiki.to);
            return true;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setWikiMenu(null);
            return true;
          }
        }

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
          // Render the chip as a plain <span> (not <button>) so it
          // stays an inline atom inside the editor's text flow;
          // ProseMirror handles selection and caret placement.
          const dom = document.createElement("span");
          const { target, display } = node.attrs as { target: string; display: string | null };
          const hashIdx = target.indexOf("#");
          const pagePart = hashIdx === -1 ? target : target.slice(0, hashIdx);
          const blockRaw = hashIdx === -1 ? null : target.slice(hashIdx + 1);
          const shortBlock = blockRaw == null ? null : blockRaw.replace(/^blk_/, "").slice(-4);

          // Match the Blockref primitive's visual contract. The legacy
          //  `ir-wikilink` class is retained as a data hook for tests.
          dom.className = "il-blockref ir-wikilink";
          dom.dataset.wikilink = target;
          const label = document.createElement("span");
          label.textContent = display ?? pagePart;
          dom.appendChild(label);
          if (shortBlock) {
            const idNode = document.createElement("span");
            idNode.className = "il-blockref__id";
            idNode.textContent = `#${shortBlock}`;
            dom.appendChild(idNode);
          }

          dom.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!pagePart) return;
            const withExt = pagePart.endsWith(".md") ? pagePart : `${pagePart}.md`;
            useAppStore.getState().setActivePath(withExt);
            // Cmd/Ctrl-click opens the provenance pane instead of navigating.
            if ((e.metaKey || e.ctrlKey) && blockRaw) {
              useAppStore.getState().openProvenance(withExt, blockRaw);
            }
          });
          return { dom };
        },
        code_block: (node, nvView, getPos) => new CodeBlockView(node, nvView, getPos),
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

        // Table-toolbar anchor — surfaces only when the selection
        //  sits inside a table. We compute the viewport coords of
        //  the table's DOM rect so the toolbar can float above it.
        if (isInTable(newState)) {
          const $head = newState.selection.$head;
          // Walk up the ancestor chain to find the `table` node.
          let depth = $head.depth;
          let tablePos = -1;
          while (depth > 0) {
            if ($head.node(depth).type.name === "table") {
              tablePos = $head.before(depth);
              break;
            }
            depth -= 1;
          }
          if (tablePos >= 0) {
            const dom = view.domAtPos(tablePos + 1).node as HTMLElement | null;
            const tableEl = dom?.closest?.("table") ?? null;
            if (tableEl) {
              const rect = tableEl.getBoundingClientRect();
              setTableAnchor({ top: rect.top, left: rect.left });
            }
          }
        } else if (tableAnchor) {
          setTableAnchor(null);
        }

        // Recompute wiki-link + slash menu state after every transaction
        //  so both popups track the cursor and filter as the user
        //  types. The two triggers are mutually exclusive (you can't
        //  be inside both `[[` and `/` at the same caret), so
        //  checking wiki first and slash second is safe — closing
        //  one when the other is active.
        const wikiCtx = getWikiLinkContext(newState);
        if (wikiCtx) {
          const nodes = useTreeStore.getState().nodes;
          const items = filterWikiLinkCandidates(nodes, wikiCtx.query);
          if (items.length === 0) {
            if (wikiMenuRef.current) setWikiMenu(null);
          } else {
            const coords = view.coordsAtPos(newState.selection.head);
            setWikiMenu((prev) => ({
              items,
              index: prev ? Math.min(prev.index, items.length - 1) : 0,
              query: wikiCtx.query,
              coords: { left: coords.left, top: coords.top },
              from: wikiCtx.from,
              to: wikiCtx.to,
            }));
          }
          if (slashMenuRef.current) setSlashMenu(null);
          return;
        }
        if (wikiMenuRef.current) setWikiMenu(null);

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
          index: prev ? Math.min(prev.index, filtered.length - 1) : 0,
          query: ctx.query,
          coords: { left: coords.left, top: coords.top },
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

    // Register ProseMirror-backed toolbar commands while the view is
    //  mounted. Each call dispatches through `view.dispatch` so
    //  history tracking, input rules, and block-id preservation all
    //  continue to work.
    if (view) {
      const schema = view.state.schema;
      const run = (cmd: ReturnType<typeof toggleMark>) => {
        cmd(view.state, view.dispatch);
        view.focus();
      };
      const commands: EditorCommands = {
        toggleBold: () => {
          const m = schema.marks.strong;
          if (m) run(toggleMark(m));
        },
        toggleItalic: () => {
          const m = schema.marks.em;
          if (m) run(toggleMark(m));
        },
        toggleUnderline: () => {
          // No native `<u>` mark in the default markdown schema.
          //  Skip gracefully; Source mode handles it via HTML.
        },
        toggleStrike: () => {
          // `strikethrough` isn't in the default schema either.
          //  Skip in WYSIWYG; Source mode handles it via `~~…~~`.
        },
        toggleInlineCode: () => {
          const m = schema.marks.code;
          if (m) run(toggleMark(m));
        },
        setHeading: (level) => {
          const h = schema.nodes.heading;
          const p = schema.nodes.paragraph;
          if (!h || !p) return;
          // Toggle: if the current block is already this heading
          //  level, drop back to paragraph; otherwise set heading.
          const $head = view.state.selection.$from;
          const node = $head.parent;
          const already = node.type === h && node.attrs.level === level;
          const cmd = already ? setBlockType(p) : setBlockType(h, { level });
          cmd(view.state, view.dispatch);
          view.focus();
        },
        toggleBlockquote: () => {
          const bq = schema.nodes.blockquote;
          if (!bq) return;
          wrapIn(bq)(view.state, view.dispatch);
          view.focus();
        },
        insertCodeFence: () => {
          const cb = schema.nodes.code_block;
          if (!cb) return;
          setBlockType(cb)(view.state, view.dispatch);
          view.focus();
        },
        insertLink: () => {
          const linkMark = schema.marks.link;
          if (!linkMark) return;
          const url = window.prompt("Link URL", "https://");
          if (!url) return;
          const { from, to, empty } = view.state.selection;
          const tr = view.state.tr;
          if (empty) {
            // No selection — insert the URL itself as link text.
            const text = view.state.schema.text(url, [linkMark.create({ href: url })]);
            tr.insert(from, text);
          } else {
            tr.addMark(from, to, linkMark.create({ href: url }));
          }
          view.dispatch(tr);
          view.focus();
        },
      };
      registerEditorCommands(commands);
    }

    return () => {
      registerEditorCommands(null);
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
    const { cleaned, entries } = stripBlockIds(body);
    const currentSerialized = wikiMarkdownSerializer.serialize(view.state.doc);

    // Don't replace if content matches — avoids cursor jumps
    if (currentSerialized === cleaned) return;

    blockIdsRef.current = entries;
    const doc = wikiMarkdownParser.parse(cleaned);
    if (!doc) return;

    suppressRef.current = true;
    const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
    view.dispatch(tr);
    suppressRef.current = false;
  }, [markdown]);

  const bodyText = markdown.replace(/^---[\s\S]*?^---[\r\n]*/m, "").trim();
  const headingOnly = /^#{1,6}\s+\S+\s*$/.test(bodyText);
  const showStartCard = bodyText.length === 0 || headingOnly;

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      {/* Content padding mirrors screen-editor.jsx EditorArea: 28/44
       *  in the safe variant, bumped to 36/56 in the display-type
       *  variant via a `html[data-type-display="serif"]` selector in
       *  editor.css. */}
      <div ref={containerRef} className="il-editor-scroll flex-1 overflow-y-auto" />
      {showStartCard && <EditorStartCard />}
      {slashMenu && (
        <div
          role="listbox"
          aria-label="Slash commands"
          className="fixed z-50 min-w-56 rounded-md border border-border bg-ironlore-slate py-1 shadow-xl"
          style={{
            left: slashMenu.coords.left,
            // Anchor the menu's bottom 6px above the current caret line so
            // it sits above what the user is typing (was below, which hid
            // the trigger line as the list grew).
            bottom: `${Math.max(window.innerHeight - slashMenu.coords.top + 6, 8)}px`,
          }}
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

      {wikiMenu && (
        <div
          role="listbox"
          aria-label="Wiki-link candidates"
          className="fixed z-50 min-w-64 rounded-md border border-border bg-ironlore-slate py-1 shadow-xl"
          style={{
            left: wikiMenu.coords.left,
            bottom: `${Math.max(window.innerHeight - wikiMenu.coords.top + 6, 8)}px`,
          }}
        >
          {/* Mono `[[REF` overline so the popup reads as a wiki
           *  link context from the first glance — otherwise it
           *  collides visually with the slash menu. */}
          <div
            className="font-mono uppercase"
            style={{
              fontSize: 10.5,
              letterSpacing: "0.08em",
              color: "var(--il-text3)",
              padding: "6px 10px 4px",
            }}
          >
            [[ref
          </div>
          {wikiMenu.items.map((item, i) => (
            <button
              key={item.path}
              type="button"
              role="option"
              aria-selected={i === wikiMenu.index}
              onMouseDown={(e) => {
                e.preventDefault();
                runWikiLinkItem(item, wikiMenu.from, wikiMenu.to);
              }}
              onMouseEnter={() => setWikiMenu((m) => (m ? { ...m, index: i } : m))}
              className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs ${
                i === wikiMenu.index
                  ? "bg-ironlore-slate-hover text-primary"
                  : "text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
              }`}
            >
              <span className="flex flex-col overflow-hidden">
                <span className="truncate font-medium text-primary">{item.name}</span>
                <span
                  className="truncate font-mono text-[10.5px]"
                  style={{ color: "var(--il-text4)", letterSpacing: "0.02em" }}
                >
                  {item.path}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      {tableAnchor && viewRef.current && (
        <TableToolbar view={viewRef.current} anchor={tableAnchor} />
      )}
    </div>
  );
}

/**
 * Empty-state card shown over the editor when the body is blank (or only
 * carries the title heading). Pointer events pass through the wrapper so
 * the user can click anywhere to land the caret in the editor, but the
 * card itself accepts the prompt input.
 *
 * The placeholder wires into the AI panel: typing here and pressing
 * Enter seeds the AI panel's prompt and opens it — no hunting for the
 * sparkle icon on first file open.
 */
function EditorStartCard() {
  const [draft, setDraft] = useState("");

  const submit = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    // Lazy require to avoid a circular import between editor and stores.
    import("../../stores/ai-panel.js").then(({ useAIPanelStore }) => {
      useAIPanelStore.getState().setInputDraft(trimmed);
      useAppStore.getState().toggleAIPanel();
    });
    setDraft("");
  }, [draft]);

  return (
    <div className="pointer-events-none absolute inset-x-0 top-24 flex justify-center px-6">
      <form
        className="pointer-events-auto flex w-1/2 min-w-130 items-center gap-2 rounded-2xl border border-border-strong bg-ironlore-slate/90 px-4 py-2.5 shadow-xl backdrop-blur"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Sparkles className="h-4 w-4 shrink-0 text-ironlore-blue" />
        <input
          className="flex-1 bg-transparent text-sm text-primary placeholder:text-secondary focus:outline-none"
          placeholder="Ask AI to draft something, or start writing below…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-secondary">
          ↵
        </kbd>
      </form>
    </div>
  );
}
