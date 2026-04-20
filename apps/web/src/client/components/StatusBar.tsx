import { useEffect, useState } from "react";
import { useWorkspaceActivity } from "../hooks/useWorkspaceActivity.js";
import { useAppStore } from "../stores/app.js";
import { useAuthStore } from "../stores/auth.js";
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
  const currentProjectId = useAuthStore((s) => s.currentProjectId);
  const activity = useWorkspaceActivity();

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  const savedLabel = relativeSaved(lastSavedAt, now);
  // Location cell: prefer the active file path; fall back to the
  //  current project id so the cell is never empty (an empty left
  //  cluster reads as "nothing loaded" and is unhelpful).
  const locationLabel = activePath ?? (currentProjectId ? `~/${currentProjectId}` : "");

  return (
    <footer
      className="flex h-5.5 shrink-0 items-center gap-3 border-t px-3"
      style={{
        background: "var(--il-slate)",
        borderColor: "var(--il-border-soft)",
        fontFamily: "var(--font-mono)",
        fontSize: 10.5,
        letterSpacing: "0.02em",
        color: "var(--il-text3)",
      }}
    >
      {locationLabel && (
        <button
          type="button"
          onClick={() => void navigator.clipboard.writeText(locationLabel)}
          className="truncate outline-none hover:text-primary focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
          style={{ color: "var(--il-text2)" }}
          title="Copy"
        >
          {locationLabel}
        </button>
      )}
      <BranchLabel />
      <div className="flex-1" />
      <div className="flex items-center gap-3">
        {activity.runningCount > 0 && (
          <button
            type="button"
            onClick={() => useAppStore.getState().toggleInbox()}
            className="flex items-center gap-1.5 outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
            style={{ color: "var(--il-blue)" }}
            aria-label={`${activity.runningCount} agents running — open inbox`}
            title={`${activity.runningCount} agents running`}
          >
            <Reuleaux size={7} color="var(--il-blue)" spin />
            <span className="uppercase" style={{ letterSpacing: "0.04em" }}>
              {activity.runningCount} {activity.runningCount === 1 ? "agent" : "agents"}
            </span>
          </button>
        )}
        <EditorStatusPill status={editorStatus} savedLabel={savedLabel} />
        <ConnectionPill connected={wsConnected} reconnecting={wsReconnecting} />
      </div>
    </footer>
  );
}

/**
 * Branch label — `⎇ main` in mono. Static today because the user
 * doesn't switch branches in Ironlore (agents do, via inbox staging).
 * If the product surfaces HEAD detection later, this becomes a live
 * read from the git worker.
 */
function BranchLabel() {
  return (
    <span className="flex items-center gap-1">
      <span aria-hidden="true" style={{ color: "var(--il-text4)" }}>
        ·
      </span>
      <span style={{ color: "var(--il-text3)" }}>⎇ main</span>
    </span>
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
      className={`flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-wider ${color}`}
    >
      <StatusPip state={state} size={9} aria-label={label} />
      {label}
    </span>
  );
}
