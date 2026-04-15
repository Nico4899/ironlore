import { Sparkles } from "lucide-react";
import { useAppStore } from "../stores/app.js";

/**
 * Collapsed AI-panel rail shown on the right edge of the app when the
 * full panel is closed. A single `Sparkles` button expands the panel,
 * mirroring the header "AI" toggle but making the affordance visible
 * at all times — the previous design hid the panel entirely and
 * required users to know about the toolbar button or Cmd+Shift+A.
 */
export function AIPanelRail() {
  return (
    <aside
      aria-label="AI panel (collapsed)"
      className="flex w-8 shrink-0 flex-col items-center border-l border-border bg-ironlore-slate py-2"
    >
      <button
        type="button"
        onClick={() => useAppStore.getState().toggleAIPanel()}
        aria-label="Open AI panel"
        title="Open AI panel (Cmd+Shift+A)"
        className="flex h-8 w-8 items-center justify-center rounded text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
      >
        <Sparkles className="h-4 w-4" />
      </button>
    </aside>
  );
}
