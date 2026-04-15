import { type RefObject, useEffect } from "react";

/**
 * Trap Tab / Shift+Tab focus inside a container and restore focus to
 * whatever was active before the container mounted when it unmounts.
 *
 * Required for WCAG 2.1 §2.4.3 (Focus Order) inside modal dialogs —
 * without it, a keyboard user can tab out of the dialog into the
 * obscured page underneath.
 *
 * Usage:
 *   const ref = useRef<HTMLDivElement>(null);
 *   useFocusTrap(ref, isOpen);
 *   return <div ref={ref} role="dialog" … />
 *
 * The hook is a no-op when `active` is false so it can live above the
 * conditional render in a component that sometimes shows a dialog and
 * sometimes doesn't.
 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused =
      (document.activeElement instanceof HTMLElement ? document.activeElement : null) ?? null;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const nodes = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (n) => !n.hasAttribute("inert") && n.offsetParent !== null,
      );
      if (nodes.length === 0) {
        e.preventDefault();
        return;
      }
      const first = nodes[0] as HTMLElement;
      const last = nodes[nodes.length - 1] as HTMLElement;
      const activeEl = document.activeElement as HTMLElement | null;

      if (e.shiftKey && activeEl === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      } else if (!container.contains(activeEl)) {
        // Focus somehow escaped — pull it back to the first element.
        e.preventDefault();
        first.focus();
      }
    };

    container.addEventListener("keydown", onKeyDown);

    return () => {
      container.removeEventListener("keydown", onKeyDown);
      // Restore focus to the trigger so keyboard users don't land at
      // the top of the document after closing.
      previouslyFocused?.focus?.();
    };
  }, [active, containerRef]);
}
