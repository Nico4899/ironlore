import { useEffect, useState } from "react";
import { useAppStore } from "../stores/app.js";
import { useEditorStore } from "../stores/editor.js";
import { Reuleaux, StatusPip } from "./primitives/index.js";

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
  const wsReconnecting = useAppStore((s) => s.wsReconnecting);
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
        <EditorStatusPill status={editorStatus} savedLabel={savedLabel} />
        <ConnectionPill connected={wsConnected} reconnecting={wsReconnecting} />
      </div>
    </footer>
  );
}

/**
 * Editor save-state pill. An icon sits beside the text so the meaning
 * survives color-blindness, greyscale, and silent screen readers.
 */
function EditorStatusPill({
  status,
  savedLabel,
}: {
  status: "clean" | "dirty" | "syncing" | "conflict";
  savedLabel: string;
}) {
  if (status === "dirty") {
    return (
      <span role="status" aria-live="polite" className="flex items-center gap-1 text-secondary">
        <Reuleaux size={7} color="var(--il-amber)" aria-label="Unsaved changes" />
        Unsaved
      </span>
    );
  }
  if (status === "syncing") {
    return (
      <span role="status" aria-live="polite" className="flex items-center gap-1 text-secondary">
        <Reuleaux size={7} color="var(--il-blue)" spin aria-label="Saving" />
        Saving…
      </span>
    );
  }
  if (status === "conflict") {
    return (
      <span
        role="status"
        aria-live="assertive"
        className="flex items-center gap-1 text-signal-amber"
      >
        <Reuleaux size={7} color="var(--il-amber)" aria-label="Conflict" />
        Conflict
      </span>
    );
  }
  // clean
  return (
    <span role="status" aria-live="off" className="text-secondary">
      {savedLabel}
    </span>
  );
}

/**
 * WebSocket connection pill. Per docs/09-ui-and-brand.md §Status bar,
 * the indicator is a Reuleaux pip — green when connected, red when
 * not — with a mono uppercase label beside it. No Wifi / WifiOff
 * Lucide icon; state is load-bearing and needs the one shape the
 * product uses for state.
 */
function ConnectionPill({
  connected,
  reconnecting,
}: {
  connected: boolean;
  reconnecting: boolean;
}) {
  const label = connected ? "LIVE" : reconnecting ? "RECONNECTING" : "OFFLINE";
  const state = connected ? "healthy" : reconnecting ? "running" : "error";
  const color = connected
    ? "text-signal-green"
    : reconnecting
      ? "text-signal-amber"
      : "text-signal-red";

  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={label}
      className={`flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider ${color}`}
    >
      <StatusPip state={state} size={9} aria-label={label} />
      {label}
    </span>
  );
}
