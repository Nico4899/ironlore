import { LogOut } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect } from "react";
import { AIPanel } from "./components/AIPanel.js";
import { AIPanelRail } from "./components/AIPanelRail.js";
import { ChangePasswordPage } from "./components/ChangePasswordPage.js";
import { ContentArea } from "./components/ContentArea.js";
import { DisconnectedBanner } from "./components/DisconnectedBanner.js";
import { LoginPage } from "./components/LoginPage.js";
import { SearchDialog } from "./components/SearchDialog.js";
import { Sidebar } from "./components/Sidebar.js";
import { StatusBar } from "./components/StatusBar.js";
import { useResponsiveLayout } from "./hooks/useResponsiveLayout.js";
import { useWebSocket } from "./hooks/useWebSocket.js";
import { logout } from "./lib/api.js";
import { useAppStore } from "./stores/app.js";
import { useAuthStore } from "./stores/auth.js";

const Terminal = lazy(() => import("./components/Terminal.js"));

export function App() {
  const authStatus = useAuthStore((s) => s.status);

  // Check session on mount
  useEffect(() => {
    useAuthStore.getState().checkSession();
  }, []);

  // Auth gate
  if (authStatus === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-ironlore-slate">
        <span className="text-lg font-medium tracking-tight text-primary">ironlore</span>
      </div>
    );
  }
  if (authStatus === "unauthenticated") {
    return <LoginPage />;
  }
  if (authStatus === "must-change-password") {
    return <ChangePasswordPage />;
  }

  return <AppShell />;
}

function AppShell() {
  useWebSocket();
  useResponsiveLayout();

  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const aiPanelOpen = useAppStore((s) => s.aiPanelOpen);
  const searchDialogOpen = useAppStore((s) => s.searchDialogOpen);
  const terminalOpen = useAppStore((s) => s.terminalOpen);

  const handleLogout = useCallback(async () => {
    await logout();
    useAuthStore.getState().clearSession();
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Cmd+K / Ctrl+K — toggle search dialog
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        useAppStore.getState().toggleSearchDialog();
      }
      // Ctrl+` — toggle terminal
      if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        useAppStore.getState().toggleTerminal();
      }
      // Cmd+Shift+A / Ctrl+Shift+A — toggle AI panel (per docs/09-ui-and-brand.md)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        useAppStore.getState().toggleAIPanel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className="flex h-screen flex-col bg-ironlore-slate text-primary">
      {/* Skip navigation (a11y) */}
      <a href="#main-content" className="skip-nav">
        Skip to content
      </a>

      {/* Header */}
      <header className="flex h-12 items-center border-b border-border px-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium tracking-tight">ironlore</span>
        </div>
        <div className="flex-1" />
        <nav aria-label="Application controls" className="flex items-center gap-2">
          <button
            type="button"
            className="rounded px-2 py-1 text-xs text-secondary hover:bg-ironlore-slate-hover"
            onClick={() => useAppStore.getState().toggleAIPanel()}
            aria-label="Toggle AI panel"
          >
            AI
          </button>
          <button
            type="button"
            className="rounded p-1 text-secondary hover:bg-ironlore-slate-hover"
            onClick={handleLogout}
            aria-label="Log out"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </nav>
      </header>

      {/* WebSocket disconnected banner (shown after grace period) */}
      <DisconnectedBanner />

      {/* Main three-panel layout */}
      <div className="flex flex-1 overflow-hidden">
        {sidebarOpen && <Sidebar />}
        <ContentArea />
        {aiPanelOpen ? <AIPanel /> : <AIPanelRail />}
      </div>

      {/* Terminal panel (Ctrl+`) */}
      {terminalOpen && (
        <Suspense fallback={<div className="h-64 border-t border-border" />}>
          <Terminal />
        </Suspense>
      )}

      {/* Status bar */}
      <StatusBar />

      {/* Search dialog (Cmd+K) */}
      {searchDialogOpen && <SearchDialog />}
    </div>
  );
}
