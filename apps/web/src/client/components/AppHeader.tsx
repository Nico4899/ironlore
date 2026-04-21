import { Moon, Search as SearchIcon, Sun } from "lucide-react";
import { useWorkspaceActivity } from "../hooks/useWorkspaceActivity.js";
import { useAppStore } from "../stores/app.js";
import { useAuthStore } from "../stores/auth.js";
import { Logo } from "./Logo.js";
import { Key, Reuleaux } from "./primitives/index.js";

/**
 * Top-of-window application header — per the spec screenshot.
 *
 * Layout, left → right:
 *   · Logo + `ironlore` wordmark
 *   · Mono breadcrumb `<project> / <section>` — the last segment is
 *     `--il-text`, prior segments `--il-text3`, matches §Header grammar
 *     in docs/09-ui-and-brand.md.
 *   · Flex spacer
 *   · Theme toggle (Sun / Moon)
 *   · Search chip — labelled `SEARCH · ⌘K`, opens the command palette
 *   · Inbox chip — amber `· INBOX · N`, only rendered when inbox > 0
 *   · Profile avatar — initial of `username`, opens Settings → General
 *
 * The sidebar's prior bottom-rail home for Search / Settings / Theme
 * is being migrated here; this header is the new canonical location
 * for those controls. An AgentPulse 1 px gradient runs across the
 * bottom hairline whenever any agent is working, per the JSX spec's
 * "building heartbeat."
 */

export function AppHeader() {
  const username = useAuthStore((s) => s.username);
  const currentProjectId = useAuthStore((s) => s.currentProjectId);
  const theme = useAppStore((s) => s.theme);
  const activeAgentSlug = useAppStore((s) => s.activeAgentSlug);
  const sidebarTab = useAppStore((s) => s.sidebarTab);
  const activePath = useAppStore((s) => s.activePath);
  const settingsOpen = useAppStore((s) => s.settingsOpen);

  const activity = useWorkspaceActivity();
  const inboxCount = activity.inboxCount;

  // Breadcrumb composition — matches the spec image's
  //  `team-platform / home` grammar. The second segment is derived
  //  from the active surface: editor path / agent slug / inbox /
  //  settings / home.
  const trailing = deriveTrailingCrumb({
    activePath,
    activeAgentSlug,
    sidebarTab,
    settingsOpen,
  });

  const avatarInitial = (username ?? "").charAt(0).toUpperCase();

  const openProfileSettings = () => {
    useAppStore.getState().toggleSettings("general");
  };

  return (
    <header
      className="flex shrink-0 items-center gap-3"
      style={{
        height: 44,
        padding: "0 16px",
        background: "var(--il-bg)",
        borderBottom: "1px solid var(--il-border-soft)",
        position: "relative",
      }}
    >
      {/* Heartbeat — 1 px animated gradient at the bottom edge while
       *  any agent is streaming, per screen-home.jsx AppHeader. */}
      {activity.runningCount > 0 && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            bottom: -1,
            left: 0,
            right: 0,
            height: 1,
            background: "linear-gradient(90deg, transparent, var(--il-blue) 50%, transparent)",
            animation: "ilHeaderPulse 4s ease-in-out infinite",
            opacity: 0.8,
            pointerEvents: "none",
          }}
        />
      )}

      <div className="flex items-center gap-2">
        <Logo size={20} />
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 14,
            fontWeight: 500,
            letterSpacing: "-0.02em",
            color: "var(--il-text)",
          }}
        >
          ironlore
        </span>
      </div>

      <span aria-hidden="true" style={{ width: 1, height: 16, background: "var(--il-border)" }} />

      <nav
        className="flex items-center gap-2 font-mono truncate"
        style={{ fontSize: 11.5, letterSpacing: "0.01em", color: "var(--il-text3)" }}
        aria-label="Breadcrumb"
      >
        {currentProjectId && (
          <>
            <span>{currentProjectId}</span>
            {trailing && (
              <>
                <span style={{ color: "var(--il-text4)" }}>/</span>
                <span style={{ color: "var(--il-text)" }}>{trailing}</span>
              </>
            )}
          </>
        )}
      </nav>

      <span className="flex-1" />

      {/* Theme toggle */}
      <HeaderIconButton
        icon={theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
        ariaLabel={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        title={theme === "dark" ? "Light mode" : "Dark mode"}
        onClick={() => useAppStore.getState().toggleTheme()}
      />

      {/* Search chip — mono `SEARCH · ⌘K`. Matches the canvas grammar
       *  the sidebar previously used; re-rendered here so the action
       *  is always above the fold regardless of which surface the
       *  user is on. */}
      <button
        type="button"
        onClick={() => useAppStore.getState().toggleSearchDialog()}
        className="flex items-center gap-2 outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
        style={{
          padding: "4px 8px 4px 10px",
          borderRadius: 4,
          background: "var(--il-slate)",
          border: "1px solid var(--il-border-soft)",
          cursor: "pointer",
        }}
        aria-label="Search (⌘K)"
        title="Search"
      >
        <SearchIcon className="h-3 w-3" style={{ color: "var(--il-text3)" }} />
        <span
          className="font-mono uppercase"
          style={{ fontSize: 10.5, letterSpacing: "0.06em", color: "var(--il-text3)" }}
        >
          Search
        </span>
        <Key>⌘K</Key>
      </button>

      {/* Inbox chip — only when there's actually something pending.
       *  The amber pip + count is the "N runs await" signal; clicking
       *  routes the content area to the full-screen Inbox surface
       *  (see ContentArea's `sidebarTab === "inbox"` branch). */}
      {inboxCount > 0 && (
        <button
          type="button"
          onClick={() => useAppStore.getState().setSidebarTab("inbox")}
          className="inline-flex items-center gap-2 font-mono uppercase outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
          style={{
            padding: "3px 10px",
            borderRadius: 4,
            background: "color-mix(in oklch, var(--il-amber) 15%, transparent)",
            border: "1px solid color-mix(in oklch, var(--il-amber) 40%, transparent)",
            fontSize: 10.5,
            letterSpacing: "0.06em",
            color: "var(--il-amber)",
            cursor: "pointer",
          }}
          aria-label={`Open inbox (${inboxCount} pending)`}
          title="Open inbox"
        >
          <Reuleaux size={8} color="var(--il-amber)" />
          <span>inbox · {inboxCount}</span>
        </button>
      )}

      {/* Profile avatar — initial of the authenticated username.
       *  Clicking opens Settings pinned to the General tab, per the
       *  spec ("profile icon opens settings in the general tab"). */}
      <button
        type="button"
        onClick={openProfileSettings}
        className="flex items-center justify-center outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
        style={{
          width: 26,
          height: 26,
          borderRadius: "50%",
          background: "var(--il-slate-elev)",
          border: "1px solid var(--il-border)",
          color: "var(--il-text2)",
          fontFamily: "var(--font-mono)",
          fontSize: 10.5,
          letterSpacing: "0.04em",
          cursor: "pointer",
        }}
        aria-label="Profile & settings"
        title={username ?? "Profile"}
      >
        {avatarInitial || "·"}
      </button>
    </header>
  );
}

interface HeaderIconButtonProps {
  icon: React.ReactNode;
  ariaLabel: string;
  title: string;
  onClick: () => void;
}

function HeaderIconButton({ icon, ariaLabel, title, onClick }: HeaderIconButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={title}
      className="flex items-center justify-center outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
      style={{
        width: 28,
        height: 28,
        borderRadius: 4,
        background: "transparent",
        border: "1px solid transparent",
        color: "var(--il-text2)",
        cursor: "pointer",
      }}
    >
      {icon}
    </button>
  );
}

/**
 * Derive the breadcrumb's trailing segment for the header. We read
 * the workspace state in priority order so the label reflects the
 * user's current focus:
 *   settings > agent-detail > inbox > editor-path > "home"
 */
function deriveTrailingCrumb({
  activePath,
  activeAgentSlug,
  sidebarTab,
  settingsOpen,
}: {
  activePath: string | null;
  activeAgentSlug: string | null;
  sidebarTab: "files" | "inbox";
  settingsOpen: boolean;
}): string {
  if (settingsOpen) return "settings";
  if (activeAgentSlug) return `agents / ${activeAgentSlug}`;
  if (sidebarTab === "inbox") return "inbox";
  if (activePath) return activePath;
  return "home";
}
