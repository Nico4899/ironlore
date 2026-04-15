import { ChevronRight, LogOut, Moon, Search, Sun } from "lucide-react";
import { useCallback } from "react";
import { logout } from "../lib/api.js";
import { useAppStore } from "../stores/app.js";
import { useAuthStore } from "../stores/auth.js";
import { Logo } from "./Logo.js";

/**
 * Header / toolbar — left: logo + wordmark (links to home). Center:
 * breadcrumb of the current active path. Right: search trigger,
 * theme toggle, AI panel toggle, logout.
 *
 * Minimal by design per docs/09-ui-and-brand.md §Header / toolbar.
 */
export function Header() {
  const activePath = useAppStore((s) => s.activePath);
  const theme = useAppStore((s) => s.theme);

  const handleLogout = useCallback(async () => {
    await logout();
    useAuthStore.getState().clearSession();
  }, []);

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
      <a
        href="/"
        className="flex items-center gap-2 text-primary"
        aria-label="Ironlore home"
        onClick={(e) => {
          // Home resets the active path; skip the real navigation so the
          // SPA doesn't do a full reload.
          e.preventDefault();
          useAppStore.getState().setActivePath(null);
        }}
      >
        <Logo size={20} />
        <span className="text-sm lowercase" style={{ fontWeight: 500, letterSpacing: "-0.02em" }}>
          ironlore
        </span>
      </a>

      {activePath && <Breadcrumb path={activePath} />}

      <div className="flex-1" />

      <nav aria-label="Application controls" className="flex items-center gap-1">
        <button
          type="button"
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
          onClick={() => useAppStore.getState().toggleSearchDialog()}
          aria-label="Search pages"
          title="Search (⌘K)"
        >
          <Search className="h-3.5 w-3.5" />
          <kbd className="hidden text-xs md:inline">⌘K</kbd>
        </button>
        <button
          type="button"
          className="rounded p-1.5 text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
          onClick={() => useAppStore.getState().toggleTheme()}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          className="rounded px-2 py-1 text-xs text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
          onClick={() => useAppStore.getState().toggleAIPanel()}
          aria-label="Toggle AI panel"
          title="AI panel (⌘⇧A)"
        >
          AI
        </button>
        <button
          type="button"
          className="rounded p-1.5 text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
          onClick={handleLogout}
          aria-label="Log out"
        >
          <LogOut className="h-3.5 w-3.5" />
        </button>
      </nav>
    </header>
  );
}

function Breadcrumb({ path }: { path: string }) {
  const segments = path.split("/").filter(Boolean);
  return (
    <nav aria-label="Current page path" className="flex min-w-0 items-center gap-1 text-xs">
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional by nature
          <span key={i} className="flex items-center gap-1 truncate">
            {i > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-secondary" />}
            <span
              className={isLast ? "truncate font-medium text-primary" : "truncate text-secondary"}
            >
              {seg}
            </span>
          </span>
        );
      })}
    </nav>
  );
}
