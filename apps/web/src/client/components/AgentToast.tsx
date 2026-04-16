import { CheckCircle, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../stores/app.js";

interface Toast {
  id: string;
  agentSlug: string;
  status: "done" | "failed";
  timestamp: number;
}

const TOAST_DURATION_MS = 8_000;

/**
 * Module-level push function. The container registers a callback
 * on mount; callers use `pushAgentToast()` from anywhere.
 */
let pushFn: ((agentSlug: string, status: "done" | "failed") => void) | null = null;

/** Push a notification toast for an agent job completion/failure. */
export function pushAgentToast(agentSlug: string, status: "done" | "failed"): void {
  pushFn?.(agentSlug, status);
}

/**
 * Agent notification toasts.
 *
 * Fires on `job.done` / `job.failed` events for agent-owned jobs.
 * Slide-in bottom-right, 8-second auto-dismiss, click navigates to
 * the run. Ascending chime on success, descending on failure.
 *
 * See docs/05-jobs-and-security.md §Notifications.
 */
export function AgentToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Register the module-level push function so external callers can fire toasts.
  useEffect(() => {
    pushFn = (agentSlug: string, status: "done" | "failed") => {
      const id = `${Date.now()}-${Math.random()}`;
      setToasts((prev) => [...prev, { id, agentSlug, status, timestamp: Date.now() }]);
      playNotificationSound(status === "done");
    };
    return () => {
      pushFn = null;
    };
  }, []);

  // Auto-dismiss after TOAST_DURATION_MS.
  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((t) => setTimeout(() => dismiss(t.id), TOAST_DURATION_MS));
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [toasts, dismiss]);

  return (
    <div aria-live="polite" className="fixed bottom-16 right-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="alert"
          className={`flex items-center gap-2 rounded-lg border px-4 py-2.5 text-xs shadow-lg backdrop-blur ${
            t.status === "done"
              ? "border-signal-green/30 bg-signal-green/10 text-signal-green"
              : "border-signal-red/30 bg-signal-red/10 text-signal-red"
          }`}
          onClick={() => {
            useAppStore.getState().toggleAIPanel();
            dismiss(t.id);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              useAppStore.getState().toggleAIPanel();
              dismiss(t.id);
            }
          }}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: toast is clickable to navigate
          tabIndex={0}
        >
          {t.status === "done" ? (
            <CheckCircle className="h-4 w-4 shrink-0" />
          ) : (
            <XCircle className="h-4 w-4 shrink-0" />
          )}
          <span className="font-medium">
            {t.agentSlug} {t.status === "done" ? "finished" : "failed"}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Tiny Web Audio synth for agent notifications.
 * Ascending chime on success, descending on failure.
 * 15% volume, one setting to turn off.
 */
export function playNotificationSound(success: boolean): void {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.value = 0.15;
    osc.type = "sine";

    if (success) {
      // Ascending: C5 → E5
      osc.frequency.setValueAtTime(523, ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(659, ctx.currentTime + 0.15);
    } else {
      // Descending: E5 → C5
      osc.frequency.setValueAtTime(659, ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(523, ctx.currentTime + 0.15);
    }

    gain.gain.setValueAtTime(0.15, ctx.currentTime + 0.12);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.2);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.2);
  } catch {
    // Audio not available — skip silently.
  }
}
