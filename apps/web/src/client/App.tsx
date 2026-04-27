import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { AgentToastContainer } from "./components/AgentToast.js";
import { AIPanel } from "./components/AIPanel.js";
import { AIPanelRail } from "./components/AIPanelRail.js";
import { AppHeader } from "./components/AppHeader.js";
import { ChangePasswordPage } from "./components/ChangePasswordPage.js";
import { ContentArea } from "./components/ContentArea.js";
import { CopyToProjectDialog } from "./components/CopyToProjectDialog.js";
import { LinkDialogContainer } from "./components/LinkDialog.js";
import { LintFindingsBanner } from "./components/LintFindingsBanner.js";
import { LoginPage } from "./components/LoginPage.js";
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
    async (state: {
      selectedScopes: string[];
      acceptedAgents: string[];
      seedChoice: string | null;
    }) => {
      try {
        // The new onboarding flow captures category choices instead
        //  of free text. We still call the server's template
        //  substitution endpoint so library personas get populated —
        //  we just pass the scope labels through `goals` and leave
        //  `company_*` blank (the endpoint treats missing values as
        //  no-ops). A network failure here shouldn't trap the user.
        await submitOnboarding({
          company_name: "",
          company_description: "",
          goals: state.selectedScopes.join(", "),
        });
      } catch {
        /* best-effort */
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
  const searchDialogOpen = useAppStore((s) => s.searchDialogOpen);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const terminalOpen = useAppStore((s) => s.terminalOpen);
  const devMode = useAppStore((s) => s.devMode);
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
      // Ctrl+` — toggle terminal. Dev-mode gated so the shortcut
      //  is inert for non-technical users (matches Settings →
      //  General → Developer mode). The preventDefault only fires
      //  when the shortcut is active; otherwise the keystroke
      //  passes through.
      if (e.ctrlKey && e.key === "`") {
        if (!useAppStore.getState().devMode) return;
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
      // Cmd+I / Ctrl+I — open inbox (Home §04 Quick actions).
      //  Any ongoing text editor likely swallows ⌘I for italic; we
      //  only preventDefault when the target isn't an input surface.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "i") {
        const t = e.target as HTMLElement | null;
        const tag = t?.tagName;
        const inEditor = tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable === true;
        if (!inEditor) {
          e.preventDefault();
          useAppStore.getState().openSidebarTab("inbox");
        }
      }
      // Cmd+N / Ctrl+N — new page (Home §04 Quick actions). Create
      //  an untitled markdown at root + focus it. Skipped when
      //  focus is inside a text field so the browser's native
      //  new-window binding still works from a non-app surface.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "n") {
        const t = e.target as HTMLElement | null;
        const tag = t?.tagName;
        const inEditor = tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable === true;
        if (!inEditor) {
          e.preventDefault();
          void (async () => {
            const { createPage } = await import("./lib/api.js");
            const name = `untitled-${Date.now().toString(36).slice(-5)}.md`;
            try {
              await createPage(name, "# Untitled\n\n");
              useAppStore.getState().setActivePath(name);
            } catch {
              /* non-fatal — file watcher will pick up any partial write */
            }
          })();
        }
      }
      // Cmd+Shift+R / Ctrl+Shift+R — run an agent (Home §04 Quick
      //  actions). Opens the first idle installed agent's detail
      //  page. Best-effort: many browsers bind ⌘⇧R to hard-reload,
      //  so the button on Home is the durable path.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "r" || e.key === "R")) {
        const t = e.target as HTMLElement | null;
        const tag = t?.tagName;
        const inEditor = tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable === true;
        if (!inEditor) {
          e.preventDefault();
          void (async () => {
            const { fetchAgents, fetchAgentRuns } = await import("./lib/api.js");
            try {
              const agents = await fetchAgents();
              if (agents.length === 0) return;
              // Find the first agent that isn't currently running.
              const runs = await Promise.all(
                agents.map((a) =>
                  fetchAgentRuns(a.slug, 1).catch(
                    () => [] as Awaited<ReturnType<typeof fetchAgentRuns>>,
                  ),
                ),
              );
              const idleIdx = agents.findIndex((_, i) => runs[i]?.[0]?.status !== "running");
              const target = idleIdx >= 0 ? agents[idleIdx] : agents[0];
              if (target) useAppStore.getState().setActiveAgentSlug(target.slug);
            } catch {
              /* silently no-op if the agents endpoint is unavailable */
            }
          })();
        }
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

      {/* Top app header — logo + breadcrumb + theme / search /
       *  inbox / profile cluster. Lives above the sidebar so the
       *  right cluster (⌘K, inbox, profile) is always above the
       *  fold regardless of which surface is active. */}
      <AppHeader />

      {/* Shell body — sidebar on the left, content + panels on the right. */}
      <div className="flex min-h-0 flex-1">
        <SidebarNew />

        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Banners — OfflineBanner retired (WS health is visible in
           *  the StatusBar's pip; an intrusive banner on top of the
           *  content area was redundant and noisy). */}
          <RecoveryBanner />
          <LintFindingsBanner />

          {/* Content + panels */}
          <div className="flex flex-1 overflow-hidden">
            <ContentArea />
            {aiPanelOpen ? <AIPanel /> : <AIPanelRail />}
            {provenance && (
              <ProvenancePane
                pagePath={provenance.pagePath}
                blockId={provenance.blockId}
                onClose={() => useAppStore.getState().closeProvenance()}
              />
            )}
          </div>

          {/* Terminal panel (Ctrl+`). Dev-mode gated — even if
           *  `terminalOpen` persisted true across a session, the
           *  panel stays hidden until the user flips Settings →
           *  General → Developer mode to On. */}
          {terminalOpen && devMode && (
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

      {/* Inline link-insertion dialog (replaces window.prompt) */}
      <LinkDialogContainer />

      {/* Agent completion/failure toasts */}
      <AgentToastContainer />
    </div>
  );
}
