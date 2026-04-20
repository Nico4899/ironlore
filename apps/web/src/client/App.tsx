import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { AgentToastContainer } from "./components/AgentToast.js";
import { AIPanel } from "./components/AIPanel.js";
import { AIPanelRail } from "./components/AIPanelRail.js";
import { ChangePasswordPage } from "./components/ChangePasswordPage.js";
import { ContentArea } from "./components/ContentArea.js";
import { CopyToProjectDialog } from "./components/CopyToProjectDialog.js";
import { InboxPanel } from "./components/InboxPanel.js";
import { LoginPage } from "./components/LoginPage.js";
import { OfflineBanner } from "./components/OfflineBanner.js";
import { OnboardingWizard } from "./components/OnboardingWizard.js";
import { ProjectSwitcher } from "./components/ProjectSwitcher.js";
import { ProvenancePane } from "./components/ProvenancePane.js";
import { RecoveryBanner } from "./components/RecoveryBanner.js";
import { SearchDialog } from "./components/SearchDialog.js";
import { SettingsDialog } from "./components/SettingsDialog.js";
import { SidebarNew } from "./components/SidebarNew.js";
import { StatusBar } from "./components/StatusBar.js";
import { useResponsiveLayout } from "./hooks/useResponsiveLayout.js";
import { useThemeClass } from "./hooks/useThemeClass.js";
import { useWebSocket } from "./hooks/useWebSocket.js";
import { submitOnboarding } from "./lib/api.js";
import { useAppStore } from "./stores/app.js";
import { useAuthStore } from "./stores/auth.js";

const Terminal = lazy(() => import("./components/Terminal.js"));

const ONBOARDED_KEY = "ironlore.onboarded";

function readOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === "1";
  } catch {
    return false;
  }
}

function markOnboarded(): void {
  try {
    localStorage.setItem(ONBOARDED_KEY, "1");
  } catch {
    /* storage denied — non-fatal; user just re-sees the wizard next session */
  }
}

export function App() {
  const authStatus = useAuthStore((s) => s.status);
  // Onboarding gate sits above the app shell so the wizard can render
  //  full-bleed — sidebar / header / status bar never compete with it
  //  for attention. Per docs/09-ui-and-brand.md §Onboarding wizard,
  //  this is "the only Ironlore surface that doesn't use the
  //  three-panel shell."
  const [onboarded, setOnboarded] = useState<boolean>(readOnboarded);

  // Check session on mount
  useEffect(() => {
    useAuthStore.getState().checkSession();
  }, []);

  const handleOnboardingComplete = useCallback(
    async (answers: { role: string; company: string; goals: string }) => {
      try {
        await submitOnboarding({
          company_name: answers.company,
          company_description: answers.company,
          goals: answers.goals,
        });
      } catch {
        // Server-side template substitution is best-effort. A network
        //  failure here shouldn't trap the user in the wizard.
      }
      markOnboarded();
      setOnboarded(true);
    },
    [],
  );

  const handleOnboardingSkip = useCallback(() => {
    markOnboarded();
    setOnboarded(true);
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

  // Onboarding gate — full-bleed, no shell chrome.
  if (!onboarded) {
    return (
      <div className="flex h-screen flex-col bg-ironlore-slate text-primary">
        <OnboardingWizard onComplete={handleOnboardingComplete} onSkip={handleOnboardingSkip} />
      </div>
    );
  }

  return <AppShell />;
}

function AppShell() {
  useWebSocket();
  useResponsiveLayout();
  useThemeClass();

  const aiPanelOpen = useAppStore((s) => s.aiPanelOpen);
  const provenance = useAppStore((s) => s.provenance);
  const inboxOpen = useAppStore((s) => s.inboxOpen);
  const searchDialogOpen = useAppStore((s) => s.searchDialogOpen);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const terminalOpen = useAppStore((s) => s.terminalOpen);
  const projectSwitcherOpen = useAppStore((s) => s.projectSwitcherOpen);
  const copyToProjectSrc = useAppStore((s) => s.copyToProjectSrc);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Cmd+K / Ctrl+K — toggle search dialog
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        useAppStore.getState().toggleSearchDialog();
      }
      // Cmd+P / Ctrl+P — toggle project switcher
      //  (docs/08-projects-and-isolation.md §Project switcher UX).
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "p") {
        e.preventDefault();
        useAppStore.getState().toggleProjectSwitcher();
      }
      // Ctrl+` — toggle terminal
      if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        useAppStore.getState().toggleTerminal();
      }
      // Cmd+Shift+A / Ctrl+Shift+A — toggle AI panel
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        useAppStore.getState().toggleAIPanel();
      }
      // Cmd+B / Ctrl+B — toggle sidebar
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        useAppStore.getState().toggleSidebar();
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

      {/* Shell body — sidebar on the left (carries logo, project,
       *  tabs, search, profile — the Header was retired in the sidebar
       *  consolidation per docs/09-ui-and-brand.md §Sidebar revision). */}
      <div className="flex min-h-0 flex-1">
        <SidebarNew />

        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Banners */}
          <OfflineBanner />
          <RecoveryBanner />

          {/* Content + panels */}
          <div className="flex flex-1 overflow-hidden">
            <ContentArea />
            {inboxOpen && <InboxPanel onClose={() => useAppStore.getState().toggleInbox()} />}
            {aiPanelOpen ? <AIPanel /> : <AIPanelRail />}
            {provenance && (
              <ProvenancePane
                pagePath={provenance.pagePath}
                blockId={provenance.blockId}
                onClose={() => useAppStore.getState().closeProvenance()}
              />
            )}
          </div>

          {/* Terminal panel (Ctrl+`) */}
          {terminalOpen && (
            <Suspense fallback={<div className="h-64 border-t border-border" />}>
              <Terminal />
            </Suspense>
          )}
        </div>
      </div>

      {/* Status bar — path · branch · saved · agents · WS. Spans the
       *  full window width at the bottom. */}
      <StatusBar />

      {/* Search dialog (Cmd+K) */}
      {searchDialogOpen && <SearchDialog />}

      {/* Project switcher (Cmd+P) */}
      {projectSwitcherOpen && <ProjectSwitcher />}

      {/* Cross-project copy dialog */}
      {copyToProjectSrc && (
        <CopyToProjectDialog
          srcPath={copyToProjectSrc}
          onClose={() => useAppStore.getState().closeCopyToProject()}
        />
      )}

      {/* Settings dialog */}
      {settingsOpen && <SettingsDialog />}

      {/* Agent completion/failure toasts */}
      <AgentToastContainer />
    </div>
  );
}
