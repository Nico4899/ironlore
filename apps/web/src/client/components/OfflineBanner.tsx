import { WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { wsClient } from "../lib/ws.js";
import { useAppStore } from "../stores/app.js";

/**
 * Offline banner — rendered when the WebSocket drops and the client
 * stays disconnected past a short grace window. Matches the "Offline
 * banner" spec in docs/09-ui-and-brand.md §System banners: Signal-Amber
 * background, non-dismissible (no `×` button), auto-clears on reconnect.
 *
 * The grace window (1.5s) avoids flicker during normal reconnect cycles
 * — the banner only surfaces if the socket stays down.
 *
 * Editing is not force-disabled from here. The editor keeps dirty
 * buffers in memory and auto-save retries on reconnect; the block-level
 * merge UI handles any conflict that lands after a long offline window.
 */
const GRACE_MS = 1500;

export function OfflineBanner() {
  const connected = useAppStore((s) => s.wsConnected);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (connected) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), GRACE_MS);
    return () => clearTimeout(timer);
  }, [connected]);

  if (!visible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 border-b border-signal-amber bg-signal-amber/10 px-4 py-1.5 text-xs text-signal-amber"
    >
      <WifiOff className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1">
        Offline — tree updates and agent events are paused. Edits will sync when the connection
        returns.
      </span>
      <button
        type="button"
        onClick={() => wsClient.connect()}
        className="rounded border border-signal-amber px-2 py-0.5 font-medium hover:bg-signal-amber/20"
      >
        Reconnect
      </button>
    </div>
  );
}
