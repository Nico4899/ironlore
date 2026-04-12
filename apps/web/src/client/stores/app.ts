import { DEFAULT_PROJECT_ID } from "@ironlore/core";
import { create } from "zustand";

interface AppStore {
  currentProjectId: string;
  sidebarWidth: number;
  sidebarOpen: boolean;
  aiPanelOpen: boolean;
  activePath: string | null;
  theme: "dark" | "light";
  wsConnected: boolean;

  toggleSidebar: () => void;
  toggleAIPanel: () => void;
  setActivePath: (path: string | null) => void;
  setTheme: (theme: "dark" | "light") => void;
  setSidebarWidth: (width: number) => void;
  setWsConnected: (connected: boolean) => void;
}

export const useAppStore = create<AppStore>((set) => ({
  currentProjectId: DEFAULT_PROJECT_ID,
  sidebarWidth: 260,
  sidebarOpen: true,
  aiPanelOpen: false,
  activePath: null,
  theme: "dark",
  wsConnected: false,

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleAIPanel: () => set((s) => ({ aiPanelOpen: !s.aiPanelOpen })),
  setActivePath: (path) => set({ activePath: path }),
  setTheme: (theme) => set({ theme }),
  setSidebarWidth: (width) => set({ sidebarWidth: width }),
  setWsConnected: (connected) => set({ wsConnected: connected }),
}));
