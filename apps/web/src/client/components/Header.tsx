import { ChevronRight, Search } from "lucide-react";
import { useCallback } from "react";
import { useWorkspaceActivity } from "../hooks/useWorkspaceActivity.js";
import { useAppStore } from "../stores/app.js";
import { useAuthStore } from "../stores/auth.js";
import { Logo } from "./Logo.js";
import { Key, Reuleaux } from "./primitives/index.js";

/**
 * AppHeader — window-wide top bar (docs/09-ui-and-brand.md
 * §Header / toolbar and shell.jsx).
 *
 * Deliberately minimal. Most chrome (terminal, theme, settings,
 * logout, project switcher) lives in the sidebar's bottom rail —
 * surfacing them twice would just clutter the header. What lives
 * here is the *product* navigation surface:
 *
 *  · Left: logo + "ironlore" wordmark (click → home) + breadcrumb
 *    prefixed by the current project id.
 *  · Right: ⌘K search chip, an Inbox pill that renders **only** when
 *    inboxCount > 0 (amber pulse, click → open inbox), and a user
 *    avatar derived from the session username.
 *  · A 1 px agent-pulse gradient sweeps the bottom hairline while at
 *    least one agent is running — matching §Agent pulse "the header
 *    bottom rule".
 */
export function Header() {
  const activePath = useAppStore((s) => s.activePath);
  const currentProjectId = useAuthStore((s) => s.currentProjectId);
  const username = useAuthStore((s) => s.username);

  const activity = useWorkspaceActivity();
  const streaming = activity.runningCount > 0;
  const inboxCount = activity.inboxCount;

  const goHome = useCallback(() => {
    useAppStore.getState().setActivePath(null);
    useAppStore.getState().setActiveAgentSlug(null);
  }, []);

  return (
    <header
      className="relative flex h-11 shrink-0 items-center gap-3 border-b border-border px-4"
      style={{ background: "var(--il-bg)" }}
    >
      {/* Logo + wordmark — returns the user to Home. */}
      <button
        type="button"
        onClick={goHome}
        className="flex items-center gap-2 rounded outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
        aria-label="Ironlore home"
      >
        <Logo size={20} />
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontWeight: 500,
            fontSize: 14,
            letterSpacing: "-0.02em",
            color: "var(--il-text)",
          }}
        >
          ironlore
        </span>
      </button>

      <span aria-hidden="true" className="h-4 w-px" style={{ background: "var(--il-border)" }} />

      <Breadcrumb projectId={currentProjectId} path={activePath} />

      <span className="flex-1" />

      {/* ⌘K search chip — the primary discoverability affordance for
       *  search. Clicking opens the dialog; ⌘K also works. */}
      <button
        type="button"
        onClick={() => useAppStore.getState().toggleSearchDialog()}
        className="flex items-center gap-2 rounded-sm px-2 py-0.75 text-xs outline-none hover:bg-ironlore-slate-hover focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
        style={{
          background: "var(--il-slate)",
          border: "1px solid var(--il-border-soft)",
        }}
        aria-label="Search (⌘K)"
        title="Search (⌘K)"
      >
        <Search className="h-3.5 w-3.5" style={{ color: "var(--il-text3)" }} />
        <span
          className="font-mono uppercase"
          style={{ fontSize: 10.5, letterSpacing: "0.04em", color: "var(--il-text3)" }}
        >
          search
        </span>
        <Key>⌘K</Key>
      </button>

      {/* Inbox pill — amber, conditional. Hides when there's nothing
       *  pending, so its presence carries signal (pending review). */}
      {inboxCount > 0 && (
        <button
          type="button"
          onClick={() => useAppStore.getState().toggleInbox()}
          className="flex items-center gap-1.5 rounded-[3px] px-2 py-0.75 outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
          style={{
            background: "color-mix(in oklch, var(--il-amber) 15%, transparent)",
            border: "1px solid color-mix(in oklch, var(--il-amber) 40%, transparent)",
            color: "var(--il-amber)",
          }}
          aria-label={`Agent inbox (${inboxCount} pending)`}
          title={`Agent inbox (${inboxCount} pending)`}
        >
          <Reuleaux size={8} color="var(--il-amber)" />
          <span className="font-mono uppercase" style={{ fontSize: 10.5, letterSpacing: "0.04em" }}>
            inbox · {inboxCount}
          </span>
        </button>
      )}

      {/* User avatar — initial(s) of the session username. Tap to
       *  jump to Settings (there's no user-profile surface yet;
       *  Settings is the closest personal-scope surface). */}
      <UserAvatar username={username} />

      {/* Agent-pulse 1px gradient at the bottom rule while any agent
       *  is streaming. Matches §Agent pulse "the header bottom rule"
       *  clause. Positioned absolutely so it doesn't shift layout. */}
      {streaming && (
        <span
          aria-hidden="true"
          className="il-header-pulse"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: -1,
            height: 1,
            background: "linear-gradient(90deg, transparent, var(--il-blue) 50%, transparent)",
            opacity: 0.8,
            pointerEvents: "none",
          }}
        />
      )}
    </header>
  );
}

function Breadcrumb({ projectId, path }: { projectId: string | null; path: string | null }) {
  const segments = path ? path.split("/").filter(Boolean) : [];
  const nothing = !projectId && segments.length === 0;
  if (nothing) return null;
  return (
    <nav
      aria-label="Current location"
      className="flex min-w-0 items-center gap-1"
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 11.5,
        letterSpacing: "0.01em",
        color: "var(--il-text3)",
      }}
    >
      {projectId && (
        <span
          className="truncate"
          style={{ color: segments.length === 0 ? "var(--il-text)" : "var(--il-text3)" }}
        >
          {projectId}
        </span>
      )}
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
          <span key={i} className="flex items-center gap-1 truncate">
            <ChevronRight className="h-3 w-3 shrink-0" style={{ color: "var(--il-text4)" }} />
            <span
              className="truncate"
              style={{
                color: isLast ? "var(--il-text)" : "var(--il-text3)",
                fontWeight: isLast ? 500 : 400,
              }}
            >
              {seg}
            </span>
          </span>
        );
      })}
    </nav>
  );
}

/**
 * User avatar — a 22×22 slate chip with the uppercase initials of the
 * current session's username. Click opens Settings. No dropdown yet;
 * the sidebar bottom rail carries Log out, so a menu would be
 * redundant chrome.
 */
function UserAvatar({ username }: { username: string | null }) {
  const initials = deriveInitials(username);
  return (
    <button
      type="button"
      onClick={() => useAppStore.getState().toggleSettings()}
      className="flex items-center justify-center rounded-full outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
      style={{
        width: 22,
        height: 22,
        background: "var(--il-slate-elev)",
        border: "1px solid var(--il-border)",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        color: "var(--il-text2)",
      }}
      aria-label={`Account — ${username ?? "you"} (open settings)`}
      title={username ? `Signed in as ${username}` : "Signed in"}
    >
      {initials}
    </button>
  );
}

function deriveInitials(username: string | null): string {
  if (!username) return "·";
  const trimmed = username.trim();
  if (!trimmed) return "·";
  const parts = trimmed.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0]?.[0] ?? "";
    const last = parts[parts.length - 1]?.[0] ?? "";
    return `${first}${last}`.toLowerCase();
  }
  return trimmed.slice(0, 2).toLowerCase();
}
