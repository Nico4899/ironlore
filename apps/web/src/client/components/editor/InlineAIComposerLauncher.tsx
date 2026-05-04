import { Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../../stores/app.js";
import { AIComposer, focusAIComposerTextarea } from "../AIComposer.js";

/**
 * `InlineAIComposerLauncher` — bottom-of-editor entry point to the AI
 * composer per docs/03-editor.md §Inline AI composer.
 *
 * Two states:
 *
 * - **Collapsed (default).** A 36 px sticky bar mirroring the
 *   sidebar's `NewPageRail` shape: Sparkles icon + "Ask AI" label
 *   + right-aligned `⌘L` chord chip. Clicking expands to the full
 *   composer.
 *
 * - **Expanded.** Renders [`<AIComposer>`](../AIComposer.tsx) directly.
 *   The textarea autofocuses; Esc collapses; an `×` in the top-right
 *   collapses without sending. After a successful send the launcher
 *   collapses back to the bar AND opens the AI panel via
 *   `setAiPanelOpen(true)` so the user sees the streaming reply land
 *   in the conversation surface (which has gone composer-less while
 *   a markdown file is open — see AIPanel.tsx).
 *
 * The global ⌘L (or Ctrl+L) keymap also expands the launcher and
 * focuses the textarea — same suppression rules as the sidebar's
 * ⌘N keymap (no fire when an INPUT/TEXTAREA/contentEditable is
 * focused so the chord doesn't steal a literal "L" keystroke).
 */
export function InlineAIComposerLauncher() {
  const [expanded, setExpanded] = useState(false);

  const collapse = useCallback(() => setExpanded(false), []);
  const expand = useCallback(() => {
    setExpanded(true);
    // Wait one microtask for the textarea to mount, then focus it.
    queueMicrotask(() => focusAIComposerTextarea());
  }, []);

  // ⌘L / Ctrl+L global keymap.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!shouldFireExpand(e, document.activeElement)) return;
      e.preventDefault();
      expand();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expand]);

  // Esc collapses while expanded (mirrors AIPanel composer's textarea
  //  focus model — Esc bails out of the composer, not the editor).
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Don't preventDefault — let the textarea's blur run too.
        collapse();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, collapse]);

  if (!expanded) {
    return <CollapsedLauncher onClick={expand} />;
  }

  return (
    <div
      className="relative shrink-0"
      style={{
        borderTop: "1px solid var(--il-border-soft)",
        background: "var(--il-bg-raised, var(--il-bg))",
      }}
    >
      <button
        type="button"
        onClick={collapse}
        aria-label="Collapse AI composer"
        title="Collapse (Esc)"
        className="absolute z-10 rounded text-tertiary hover:bg-ironlore-slate-hover hover:text-primary"
        style={{ top: 6, right: 6, padding: 2 }}
      >
        <X className="h-3.5 w-3.5" />
      </button>
      <AIComposer
        onAfterSubmit={() => {
          // Open the AI panel so the user sees the streaming reply
          //  land in the conversation surface, then collapse the
          //  launcher back to the bar.
          useAppStore.getState().setAiPanelOpen(true);
          collapse();
        }}
      />
    </div>
  );
}

function CollapsedLauncher({ onClick }: { onClick: () => void }) {
  const isMac = typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  const chord = isMac ? "⌘L" : "Ctrl+L";
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full shrink-0 items-center gap-2 px-3 outline-none transition-colors hover:bg-ironlore-slate-hover focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
      style={{
        height: 36,
        borderTop: "1px solid var(--il-border-soft)",
        background: "var(--il-slate)",
        color: "var(--il-text)",
        fontSize: 13.5,
        fontWeight: 500,
        textAlign: "left",
      }}
      title={`Ask AI (${chord})`}
    >
      <Sparkles
        className="h-4 w-4 shrink-0"
        style={{ color: "var(--il-blue)" }}
        aria-hidden="true"
      />
      <span className="flex-1 truncate">Ask AI</span>
      <span
        aria-hidden="true"
        className="font-mono"
        style={{
          fontSize: 11,
          color: "var(--il-text3)",
          letterSpacing: "0.04em",
        }}
      >
        {chord}
      </span>
    </button>
  );
}

/**
 * Predicate for the global ⌘L expand chord. Exported as a pure helper
 * so the same logic backs both the runtime listener and the unit
 * test — same pattern as the sidebar's ⌘N keymap predicate
 * (`sidebar-newpage-rail.test.ts`).
 *
 * Suppresses when the focus is inside a typing surface so the chord
 * doesn't steal a literal "L" keystroke from the editor / a textarea
 * / a search box.
 */
export function shouldFireExpand(
  e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; key: string },
  active: { tagName?: string; isContentEditable?: boolean } | null,
): boolean {
  if (!(e.metaKey || e.ctrlKey)) return false;
  if (e.shiftKey || e.altKey) return false;
  if (e.key.toLowerCase() !== "l") return false;
  const tag = active?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || active?.isContentEditable) return false;
  return true;
}
