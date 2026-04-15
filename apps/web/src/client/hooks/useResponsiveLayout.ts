import { useEffect } from "react";
import { useAppStore } from "../stores/app.js";

/**
 * Breakpoints per docs/09-ui-and-brand.md §Responsive behavior:
 *
 * - `< 1024px` — sidebar auto-collapses to icon rail, AI panel closes.
 *   We auto-close the panel and collapse the sidebar only **when crossing
 *   the breakpoint**, not every render, so users who reopen the sidebar
 *   at a narrow viewport stay where they want.
 * - `< 768px` — content area fills the viewport. Read-only mode is the
 *   wider product goal; for now we just keep the sidebar closed.
 *
 * The hook attaches one resize listener and sets the relevant store
 * fields. SSR-safe: short-circuits when `window` is undefined.
 */
const SIDEBAR_COLLAPSE_WIDTH = 1024;

export function useResponsiveLayout(): void {
  useEffect(() => {
    if (typeof window === "undefined") return;

    let prevNarrow = window.innerWidth < SIDEBAR_COLLAPSE_WIDTH;
    // Apply the initial state on mount so a narrow first paint collapses too.
    if (prevNarrow) {
      const s = useAppStore.getState();
      if (s.sidebarOpen) useAppStore.setState({ sidebarOpen: false });
      if (s.aiPanelOpen) useAppStore.setState({ aiPanelOpen: false });
    }

    const onResize = () => {
      const narrow = window.innerWidth < SIDEBAR_COLLAPSE_WIDTH;
      if (narrow === prevNarrow) return;
      prevNarrow = narrow;
      if (narrow) {
        useAppStore.setState({ sidebarOpen: false, aiPanelOpen: false });
      }
    };

    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
}
