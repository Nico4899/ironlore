import { AIPanel } from "./components/AIPanel.js";
import { ContentArea } from "./components/ContentArea.js";
import { Sidebar } from "./components/Sidebar.js";
import { StatusBar } from "./components/StatusBar.js";
import { useAppStore } from "./stores/app.js";

export function App() {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const aiPanelOpen = useAppStore((s) => s.aiPanelOpen);

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
          >
            AI
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
