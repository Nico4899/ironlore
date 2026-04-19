import { FileText, FolderPlus, Inbox, Search, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useWorkspaceActivity } from "../hooks/useWorkspaceActivity.js";
import {
  type AgentHistogramResponse,
  fetchAgentHistogram,
  fetchRecentEdits,
  type RecentEdit,
} from "../lib/api.js";
import { useAppStore } from "../stores/app.js";
import { AgentPulse, Key, Meta, Reuleaux, SectionLabel, Venn } from "./primitives/index.js";

/**
 * HomePanel — the canvas-grammar landing surface that replaces the
 * bare "Welcome to Ironlore" centered block.
 *
 * Per docs/09-ui-and-brand.md §Home grammar:
 *   · Mono overline with date + live-agent hint
 *   · Inter/display greeting (no fake persona — we don't know the user)
 *   · SectionLabel 01 Recent pages — real data from `fetchRecentEdits`
 *   · SectionLabel 02 Quick actions — keyboard-jumpable shortcuts
 *   · Dim Venn watermark behind the hero when the workspace is empty,
 *     so the canvas reads as a deliberate rest state rather than blank
 *
 * The grid sits in the default content area; callers render this any
 * time `activePath` is null on the Home tab.
 */
export function HomePanel() {
  const [recent, setRecent] = useState<RecentEdit[] | null>(null);

  useEffect(() => {
    fetchRecentEdits(8)
      .then(setRecent)
      .catch(() => setRecent([]));
  }, []);

  const greeting = useGreeting();
  const today = useTodayLabel();
  const activity = useWorkspaceActivity();
  const isEmpty = recent !== null && recent.length === 0;
  const hasActivity = activity.runningCount > 0 || activity.inboxCount > 0;

  return (
    <div className="relative flex flex-1 flex-col overflow-y-auto">
      {/* Venn watermark for the empty workspace — sits behind content so
       *  it reads as contemplative rest, not decoration. */}
      {isEmpty && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute"
          style={{ top: "12%", right: "8%", opacity: 0.35 }}
        >
          <Venn
            size={220}
            color="var(--il-text4)"
            lineWidth={0.5}
            ringOpacity={0.6}
            fillOpacity={0.35}
          />
        </div>
      )}

      <div className="relative z-10 mx-auto w-full max-w-4xl px-8 py-10">
        {/* Hero — mono overline + Inter greeting */}
        <div
          className="flex items-center gap-2 font-mono uppercase"
          style={{
            fontSize: 10.5,
            letterSpacing: "0.08em",
            color: "var(--il-text3)",
            marginBottom: 10,
          }}
        >
          <Reuleaux
            size={8}
            color={activity.runningCount > 0 ? "var(--il-blue)" : "var(--il-text3)"}
            spin={activity.runningCount > 0}
          />
          <span>{today}</span>
          {hasActivity && (
            <>
              <span style={{ color: "var(--il-text4)" }}>/</span>
              <span>
                {activity.runningCount > 0 && (
                  <>
                    <span style={{ color: "var(--il-text)" }}>{activity.runningCount}</span>{" "}
                    {activity.runningCount === 1 ? "agent" : "agents"} working
                  </>
                )}
                {activity.runningCount > 0 && activity.inboxCount > 0 && ", "}
                {activity.inboxCount > 0 && (
                  <>
                    <span style={{ color: "var(--il-text)" }}>{activity.inboxCount}</span>{" "}
                    in inbox
                  </>
                )}
              </span>
            </>
          )}
        </div>
        <h1
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 26,
            fontWeight: 600,
            letterSpacing: "-0.02em",
            color: "var(--il-text)",
            margin: 0,
          }}
        >
          {greeting}
        </h1>
        <p
          style={{
            marginTop: 6,
            fontSize: 14,
            color: "var(--il-text2)",
            maxWidth: 560,
            lineHeight: 1.5,
          }}
        >
          {isEmpty
            ? "No pages yet. Create one from the sidebar, drop files to upload, or let an agent seed the workspace."
            : "Pick up where you left off, or jump to a command."}
        </p>

        {/* Recent pages */}
        <div style={{ marginTop: 28 }}>
          <SectionLabel index={1} title="Recent pages" meta="LAST 7 DAYS" />
          {recent === null ? (
            <div className="py-6 text-center text-xs text-secondary">Loading…</div>
          ) : recent.length === 0 ? (
            <div
              className="rounded border py-8 text-center"
              style={{
                borderColor: "var(--il-border-soft)",
                borderStyle: "dashed",
                color: "var(--il-text3)",
                fontSize: 12.5,
              }}
            >
              Nothing here yet.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {recent.map((p) => (
                <RecentCard key={p.path} entry={p} />
              ))}
            </div>
          )}
        </div>

        {/* Quick actions */}
        <div style={{ marginTop: 28 }}>
          <SectionLabel index={2} title="Quick actions" meta="KEYBOARD" />
          <div className="grid gap-1.5">
            <QuickAction
              icon={<FileText className="h-3.5 w-3.5" />}
              label="New page"
              hint="Open the sidebar and use the + button."
            />
            <QuickAction
              icon={<FolderPlus className="h-3.5 w-3.5" />}
              label="New folder"
              hint="Sidebar · New folder"
            />
            <QuickAction
              icon={<Search className="h-3.5 w-3.5" />}
              label="Search everything"
              shortcut="⌘K"
              onClick={() => useAppStore.getState().toggleSearchDialog()}
            />
            <QuickAction
              icon={<Sparkles className="h-3.5 w-3.5" />}
              label="Toggle AI panel"
              shortcut="⌘⇧A"
              onClick={() => useAppStore.getState().toggleAIPanel()}
            />
            <QuickAction
              icon={<Inbox className="h-3.5 w-3.5" />}
              label="Agent inbox"
              hint="Pending agent runs"
              onClick={() => useAppStore.getState().toggleInbox()}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function RecentCard({ entry }: { entry: RecentEdit }) {
  const { path } = entry;
  const name = path.split("/").pop() ?? path;
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const when = useRelativeTime(entry.updatedAt);
  return (
    <button
      type="button"
      onClick={() => useAppStore.getState().setActivePath(path)}
      className="text-left outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
      style={{
        padding: "12px 14px",
        background: "var(--il-slate)",
        border: "1px solid var(--il-border-soft)",
        borderRadius: 3,
        cursor: "pointer",
      }}
    >
      {folder && (
        <div
          className="font-mono uppercase"
          style={{
            fontSize: 10,
            color: "var(--il-text4)",
            letterSpacing: "0.04em",
            marginBottom: 4,
          }}
        >
          {folder}/
        </div>
      )}
      <div
        className="truncate"
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 13.5,
          fontWeight: 500,
          color: "var(--il-text)",
        }}
      >
        {name}
      </div>
      <div className="mt-2 flex items-baseline gap-3">
        <Meta k="edited" v={when} />
        {entry.author && entry.author !== "you" && (
          <Meta k="by" v={entry.author} color="var(--il-blue)" />
        )}
      </div>
    </button>
  );
}

interface QuickActionProps {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  hint?: string;
  onClick?: () => void;
}

function QuickAction({ icon, label, shortcut, hint, onClick }: QuickActionProps) {
  const interactive = typeof onClick === "function";
  const Wrap = interactive ? "button" : "div";
  return (
    <Wrap
      type={interactive ? "button" : undefined}
      onClick={onClick}
      className="flex items-center gap-3 text-left outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
      style={{
        padding: "9px 12px",
        background: "var(--il-slate)",
        border: "1px solid var(--il-border-soft)",
        borderRadius: 3,
        cursor: interactive ? "pointer" : "default",
      }}
    >
      <span style={{ color: "var(--il-text2)" }}>{icon}</span>
      <span style={{ flex: 1, fontSize: 13, color: "var(--il-text)" }}>{label}</span>
      {hint && !shortcut && (
        <span
          className="font-mono uppercase"
          style={{
            fontSize: 10,
            letterSpacing: "0.04em",
            color: "var(--il-text3)",
          }}
        >
          {hint}
        </span>
      )}
      {shortcut && <Key>{shortcut}</Key>}
    </Wrap>
  );
}

// ───────────── helpers ─────────────

function useGreeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Still up?";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function useTodayLabel(): string {
  const d = new Date();
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/**
 * Render a relative timestamp ("2m ago", "1h ago", "3d ago"). Returns
 * the raw date when it's older than 7 days so the surface doesn't drown
 * the user in "97d ago"-style noise.
 */
function useRelativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const diffMs = Date.now() - then;
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
