import { WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { wsClient } from "../lib/ws.js";
import { useAppStore } from "../stores/app.js";

/**
 * Amber banner shown across the top of the app when the WebSocket drops.
 *
 * The status-bar indicator is still there for steady-state signal, but a
 * disconnected client silently misses tree updates and (once Phase 4 lands)
 * agent events — a 9px word in the corner is too quiet. This banner
 * surfaces the state at a glance and offers a one-click reconnect so users
 * don't have to reload the page.
 *
 * A short grace period (1.5s) avoids flicker on normal reconnect cycles;
 * the banner only shows if the socket stays down past the grace.
 */
const GRACE_MS = 1500;

export function DisconnectedBanner() {
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
      role="alert"
      aria-live="assertive"
      className="flex items-center gap-2 border-b border-signal-amber bg-signal-amber/10 px-4 py-1.5 text-xs text-signal-amber"
    >
      <WifiOff className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1">
        Disconnected from server. Tree updates and agent events are paused.
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
