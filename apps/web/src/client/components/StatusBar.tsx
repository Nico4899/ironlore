import { useEffect, useState } from "react";
import { useAppStore } from "../stores/app.js";
import { useEditorStore } from "../stores/editor.js";

/**
 * Format "Saved <N>s ago" relative to the current clock. Updates on a
 * 10s tick so the label stays approximately fresh without spamming
 * renders; any finer granularity would be noise.
 */
function relativeSaved(lastSavedAt: number | null, now: number): string {
  if (lastSavedAt === null) return "";
  const seconds = Math.max(0, Math.floor((now - lastSavedAt) / 1000));
  if (seconds < 5) return "Saved just now";
  if (seconds < 60) return `Saved ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Saved ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Saved ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Saved ${days}d ago`;
}

export function StatusBar() {
  const activePath = useAppStore((s) => s.activePath);
  const wsConnected = useAppStore((s) => s.wsConnected);
  const editorStatus = useEditorStore((s) => s.status);
  const lastSavedAt = useEditorStore((s) => s.lastSavedAt);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  const savedLabel = relativeSaved(lastSavedAt, now);

  return (
    <footer className="flex h-6 items-center border-t border-border bg-ironlore-slate px-3 text-xs text-secondary">
      {activePath && (
        <button
          type="button"
          className="hover:text-primary"
          onClick={() => navigator.clipboard.writeText(activePath)}
          title="Copy file path"
        >
          {activePath}
        </button>
      )}
      <div className="flex-1" />
      <div className="flex items-center gap-3">
        <span role="status" aria-live="polite">
          {editorStatus === "dirty"
            ? "Unsaved"
            : editorStatus === "syncing"
              ? "Saving..."
              : editorStatus === "conflict"
                ? "Conflict"
                : savedLabel}
        </span>
        <span
          role="status"
          aria-live="polite"
          className={wsConnected ? "text-signal-green" : "text-signal-red"}
        >
          {wsConnected ? "Connected" : "Disconnected"}
        </span>
      </div>
    </footer>
  );
}
