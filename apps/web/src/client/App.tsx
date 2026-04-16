import { lazy, Suspense, useEffect } from "react";
import { AgentToastContainer } from "./components/AgentToast.js";
import { AIPanel } from "./components/AIPanel.js";
import { AIPanelRail } from "./components/AIPanelRail.js";
import { ChangePasswordPage } from "./components/ChangePasswordPage.js";
import { ContentArea } from "./components/ContentArea.js";
import { Header } from "./components/Header.js";
import { LoginPage } from "./components/LoginPage.js";
import { OfflineBanner } from "./components/OfflineBanner.js";
import { RecoveryBanner } from "./components/RecoveryBanner.js";
import { SearchDialog } from "./components/SearchDialog.js";
import { Sidebar } from "./components/Sidebar.js";
import { StatusBar } from "./components/StatusBar.js";
import { useResponsiveLayout } from "./hooks/useResponsiveLayout.js";
import { useThemeClass } from "./hooks/useThemeClass.js";
import { useWebSocket } from "./hooks/useWebSocket.js";
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
  useThemeClass();

  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const aiPanelOpen = useAppStore((s) => s.aiPanelOpen);
  const searchDialogOpen = useAppStore((s) => s.searchDialogOpen);
  const terminalOpen = useAppStore((s) => s.terminalOpen);

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

      <Header />

      {/* Offline banner (shown after grace period; auto-clears on reconnect) */}
      <OfflineBanner />

      {/* Recovery banner (surfaces crash-recovery warnings from the server) */}
      <RecoveryBanner />

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

      {/* Agent completion/failure toasts */}
      <AgentToastContainer />
    </div>
  );
}
