import { LifeBuoy, X } from "lucide-react";
import { useEffect, useState } from "react";
import { wsClient } from "../lib/ws.js";
import { useAppStore } from "../stores/app.js";

interface RecoveryWarning {
  path: string;
  message: string;
}

/**
 * Banner shown when the server emits a `recovery:pending` WebSocket
 * event on startup — crash-recovery found WAL entries whose on-disk
 * state doesn't match either the pre- or post-write hash (see
 * docs/02-storage-and-sync.md §User-visible recovery surface).
 *
 * A pure console log is invisible to the person running Ironlore, so
 * this banner surfaces the affected paths and exposes a **Run lint**
 * action that opens the embedded terminal AND pre-fills
 * `ironlore lint --fix --check wal-integrity` (per the doc's link
 * target). The pre-fill is dispatched via a window CustomEvent the
 * Terminal component subscribes to — no direct DOM coupling.
 *
 * Dismissible per-session. A new `recovery:pending` event re-shows
 * the banner because it pushes a fresh warning list into state.
 */
export function RecoveryBanner() {
  const [warnings, setWarnings] = useState<RecoveryWarning[]>([]);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const unsubscribe = wsClient.onEvent((event) => {
      if (event.type !== "recovery:pending") return;
      const next: RecoveryWarning[] = event.paths.map((path, i) => ({
        path,
        message: event.messages[i] ?? "recovery pending",
      }));
      setWarnings(next);
      setDismissed(false);
    });
    return unsubscribe;
  }, []);

  if (dismissed || warnings.length === 0) return null;

  const headline =
    warnings.length === 1
      ? "1 file needs repair after a crash"
      : `${warnings.length} files need repair after a crash`;

  const openRepair = () => {
    // Open the terminal (if not already open) and pre-fill the lint
    // command the doc names. Terminal.tsx subscribes to the
    // `ironlore:terminal-command` window event.
    const store = useAppStore.getState();
    if (!store.terminalOpen) store.toggleTerminal();
    // Slight delay so the Terminal component has a chance to mount
    // and wire up the listener if it was previously closed.
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("ironlore:terminal-command", {
          detail: { command: "ironlore lint --fix --check wal-integrity" },
        }),
      );
    }, 50);
  };

  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex items-start gap-2 border-b border-signal-amber bg-signal-amber/10 px-4 py-2 text-xs text-signal-amber"
    >
      <LifeBuoy className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex-1">
        <p className="font-semibold">{headline}</p>
        <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-secondary">
          {warnings.slice(0, 5).map((w) => (
            <li key={w.path} className="truncate" title={`${w.path}: ${w.message}`}>
              {w.path}
            </li>
          ))}
          {warnings.length > 5 && (
            <li className="italic text-secondary">…and {warnings.length - 5} more</li>
          )}
        </ul>
      </div>
      <button
        type="button"
        onClick={openRepair}
        className="rounded border border-signal-amber px-2 py-0.5 font-medium hover:bg-signal-amber/20"
      >
        Run lint
      </button>
      <button
        type="button"
        aria-label="Dismiss recovery banner"
        onClick={() => setDismissed(true)}
        className="flex h-5 w-5 items-center justify-center rounded hover:bg-signal-amber/20"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
