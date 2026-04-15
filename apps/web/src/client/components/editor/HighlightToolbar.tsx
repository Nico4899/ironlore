import { Eraser, Highlighter, MessageSquarePlus, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAIPanelStore } from "../../stores/ai-panel.js";
import { useAppStore } from "../../stores/app.js";

/**
 * Floating toolbar that appears whenever the user has non-empty text
 * selected inside the editor. Actions:
 *
 *   - Paint the selection with one of four marker colors (saved as a
 *     ProseMirror `span` mark — same lifecycle as bold/italic so it
 *     persists in the markdown as `<mark class="hl hl-yellow">…</mark>`).
 *   - Erase a previously-painted highlight (when the active selection
 *     already carries the mark).
 *   - Start a comment (opens an inline textarea bound to the selection;
 *     the Phase 4 comment layer lands over this).
 *   - "Ask AI" — pipe the selected text into the AI panel as a context
 *     pill, focus the prompt, and open the panel if it's hidden. This is
 *     the bridge between editor and agent.
 *
 * The toolbar tracks the browser selection via `selectionchange` and
 * positions itself above the selection rectangle. On click-away (no
 * selection, or selection outside `.ProseMirror`) it disappears.
 *
 * Storage for highlight colors and comments is Phase 4; for now the
 * selection is passed through to the AI panel and the color marks are
 * painted via `document.execCommand` for visual feedback. When the
 * real ProseMirror schema work lands, this component stays the same
 * and the `paint` implementation swaps.
 */
const HIGHLIGHT_COLORS = [
  { key: "yellow", label: "Yellow", token: "var(--color-highlight-yellow)" },
  { key: "green", label: "Green", token: "var(--color-highlight-green)" },
  { key: "blue", label: "Blue", token: "var(--color-highlight-blue)" },
  { key: "pink", label: "Pink", token: "var(--color-highlight-pink)" },
] as const;

interface ToolbarPos {
  top: number;
  left: number;
  text: string;
}

function readSelection(): ToolbarPos | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  // Only show the toolbar inside ProseMirror — the source-mode editor
  // uses CodeMirror which has its own selection UX.
  const anchor = range.commonAncestorContainer as HTMLElement;
  const inEditor =
    anchor.nodeType === 1
      ? (anchor as Element).closest(".ProseMirror")
      : anchor.parentElement?.closest(".ProseMirror");
  if (!inEditor) return null;
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return {
    top: rect.top,
    left: rect.left + rect.width / 2,
    text: sel.toString(),
  };
}

export function HighlightToolbar() {
  const [pos, setPos] = useState<ToolbarPos | null>(null);
  const [commentOpen, setCommentOpen] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const toolbarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onSelectionChange = () => {
      // Clicks inside the toolbar itself shouldn't clear the selection.
      const activeEl = document.activeElement;
      if (toolbarRef.current && activeEl && toolbarRef.current.contains(activeEl)) return;
      const next = readSelection();
      setPos(next);
      if (!next) {
        setCommentOpen(false);
        setCommentDraft("");
      }
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  if (!pos) return null;

  const paint = (colorKey: string) => {
    // Visual-only for now: wrap the selection in a <mark> using the DOM.
    // This is a pragmatic stand-in until the ProseMirror schema gains a
    // proper `highlight` mark — the keyboard-driven styling flow in the
    // editor already handles bold/italic, so the slot is clear.
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const mark = document.createElement("mark");
    mark.className = `ir-hl ir-hl-${colorKey}`;
    mark.style.backgroundColor = `oklch(from var(--color-highlight-${colorKey}) l c h / 0.4)`;
    mark.style.color = "inherit";
    mark.style.borderRadius = "2px";
    mark.style.padding = "0 1px";
    try {
      range.surroundContents(mark);
      sel.removeAllRanges();
      setPos(null);
    } catch {
      // surroundContents throws if the range crosses block boundaries; in
      // that case we'd need a richer implementation — skip for now.
    }
  };

  const erase = () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    // Walk the range and unwrap any <mark class="ir-hl*"> nodes.
    const container = range.commonAncestorContainer as HTMLElement;
    const root = container.nodeType === 1 ? container : container.parentElement;
    root?.querySelectorAll("mark.ir-hl, mark[class*='ir-hl-']").forEach((node) => {
      const parent = node.parentNode;
      if (!parent) return;
      while (node.firstChild) parent.insertBefore(node.firstChild, node);
      parent.removeChild(node);
    });
    sel.removeAllRanges();
    setPos(null);
  };

  const askAi = () => {
    const text = pos.text.trim();
    if (!text) return;
    const label = text.length > 60 ? `${text.slice(0, 57)}…` : text;
    useAIPanelStore.getState().addContext({
      kind: "highlight",
      label,
      body: text,
    });
    if (!useAppStore.getState().aiPanelOpen) {
      useAppStore.getState().toggleAIPanel();
    }
    window.getSelection()?.removeAllRanges();
    setPos(null);
  };

  const saveComment = () => {
    const text = commentDraft.trim();
    if (!text) {
      setCommentOpen(false);
      return;
    }
    // Phase 4 will persist comments into a sidecar (.comments.json);
    // for now we pipe the comment plus the highlighted text into the AI
    // panel so the flow is usable end-to-end today.
    const highlight = pos.text.trim();
    const label = highlight.length > 60 ? `${highlight.slice(0, 57)}…` : highlight;
    useAIPanelStore.getState().addContext({
      kind: "highlight",
      label,
      body: `${highlight}\n\nComment: ${text}`,
    });
    setCommentOpen(false);
    setCommentDraft("");
    window.getSelection()?.removeAllRanges();
    setPos(null);
  };

  return (
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label="Text selection actions"
      className="fixed z-50 flex items-center gap-0.5 rounded-lg border border-border-strong bg-ironlore-slate px-1 py-1 shadow-xl"
      style={{
        top: pos.top - 44,
        left: pos.left,
        transform: "translateX(-50%)",
      }}
      onMouseDown={(e) => {
        // Don't let mousedown on the toolbar clear the selection.
        e.preventDefault();
      }}
    >
      {HIGHLIGHT_COLORS.map((c) => (
        <button
          key={c.key}
          type="button"
          aria-label={`Highlight ${c.label}`}
          title={`Highlight ${c.label}`}
          onClick={() => paint(c.key)}
          className="flex h-7 w-7 items-center justify-center rounded hover:bg-ironlore-slate-hover"
        >
          <span
            aria-hidden="true"
            className="h-4 w-4 rounded-full border border-border"
            style={{ backgroundColor: `oklch(from ${c.token} l c h / 0.6)` }}
          />
        </button>
      ))}
      <Sep />
      <ToolBtn
        onClick={erase}
        aria-label="Erase highlight"
        title="Erase highlight"
        icon={<Eraser className="h-3.5 w-3.5" />}
      />
      <ToolBtn
        onClick={() => setCommentOpen((v) => !v)}
        aria-label="Add comment"
        title="Add comment"
        active={commentOpen}
        icon={<MessageSquarePlus className="h-3.5 w-3.5" />}
      />
      <Sep />
      <button
        type="button"
        onClick={askAi}
        aria-label="Ask AI about this selection"
        title="Ask AI"
        className="flex h-7 items-center gap-1 rounded-md bg-ironlore-blue px-2 text-xs font-semibold text-white hover:bg-ironlore-blue-strong"
      >
        <Sparkles className="h-3.5 w-3.5" strokeWidth={2.25} />
        Ask AI
      </button>

      {commentOpen && (
        <div className="absolute left-0 top-full mt-1 w-64 rounded-lg border border-border-strong bg-ironlore-slate p-2 shadow-xl">
          <textarea
            autoFocus
            value={commentDraft}
            onChange={(e) => setCommentDraft(e.target.value)}
            placeholder="Add a comment…"
            className="h-16 w-full resize-none rounded border border-border bg-background p-1.5 text-xs text-primary placeholder:text-secondary focus:border-ironlore-blue focus:outline-none"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                saveComment();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setCommentOpen(false);
              }
            }}
          />
          <div className="mt-1 flex justify-end gap-1">
            <button
              type="button"
              onClick={() => setCommentOpen(false)}
              className="rounded px-2 py-0.5 text-[11px] text-secondary hover:bg-ironlore-slate-hover"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={saveComment}
              className="rounded bg-ironlore-blue px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-ironlore-blue-strong"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface ToolBtnProps {
  onClick: () => void;
  "aria-label": string;
  title: string;
  icon: React.ReactNode;
  active?: boolean;
}

function ToolBtn({ onClick, icon, active, ...rest }: ToolBtnProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center rounded ${
        active
          ? "bg-ironlore-blue/20 text-ironlore-blue"
          : "text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
      }`}
      {...rest}
    >
      {icon}
    </button>
  );
}

function Sep() {
  // biome-ignore lint/a11y/useSemanticElements: the divider is purely decorative chrome inside a toolbar
  return (
    <span role="separator" aria-orientation="vertical" className="mx-0.5 h-4 w-px bg-border" />
  );
}

// Highlighter icon import exposed for any later consumer that wants to
// render it without re-declaring lucide.
export { Highlighter };
