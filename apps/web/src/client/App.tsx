import { LogOut } from "lucide-react";
import { useCallback, useEffect } from "react";
import { AIPanel } from "./components/AIPanel.js";
import { ChangePasswordPage } from "./components/ChangePasswordPage.js";
import { ContentArea } from "./components/ContentArea.js";
import { LoginPage } from "./components/LoginPage.js";
import { Sidebar } from "./components/Sidebar.js";
import { StatusBar } from "./components/StatusBar.js";
import { logout } from "./lib/api.js";
import { useAppStore } from "./stores/app.js";
import { useAuthStore } from "./stores/auth.js";

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
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const aiPanelOpen = useAppStore((s) => s.aiPanelOpen);

  const handleLogout = useCallback(async () => {
    await logout();
    useAuthStore.getState().clearSession();
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
        <nav className="flex items-center gap-2">
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

      {/* Main three-panel layout */}
      <div className="flex flex-1 overflow-hidden">
        {sidebarOpen && <Sidebar />}
        <ContentArea />
        {aiPanelOpen && <AIPanel />}
      </div>

      {/* Status bar */}
      <StatusBar />
    </div>
  );
}
