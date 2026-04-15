import { DEFAULT_PROJECT_ID } from "@ironlore/core";
import { create } from "zustand";

interface AppStore {
  currentProjectId: string;
  sidebarWidth: number;
  sidebarOpen: boolean;
  aiPanelOpen: boolean;
  searchDialogOpen: boolean;
  terminalOpen: boolean;
  activePath: string | null;
  /** Paths of files currently open as tabs, in tab order. */
  openPaths: string[];
  theme: "dark" | "light";
  wsConnected: boolean;

  toggleSidebar: () => void;
  toggleAIPanel: () => void;
  toggleSearchDialog: () => void;
  toggleTerminal: () => void;
  setActivePath: (path: string | null) => void;
  closeTab: (path: string) => void;
  closeOtherTabs: (path: string) => void;
  closeAllTabs: () => void;
  setTheme: (theme: "dark" | "light") => void;
  setSidebarWidth: (width: number) => void;
  setWsConnected: (connected: boolean) => void;
}

export const useAppStore = create<AppStore>((set) => ({
  currentProjectId: DEFAULT_PROJECT_ID,
  sidebarWidth: 260,
  sidebarOpen: true,
  aiPanelOpen: false,
  searchDialogOpen: false,
  terminalOpen: false,
  activePath: null,
  openPaths: [],
  theme: "dark",
  wsConnected: false,

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleAIPanel: () => set((s) => ({ aiPanelOpen: !s.aiPanelOpen })),
  toggleSearchDialog: () => set((s) => ({ searchDialogOpen: !s.searchDialogOpen })),
  toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),
  setActivePath: (path) =>
    set((s) => ({
      activePath: path,
      openPaths: path && !s.openPaths.includes(path) ? [...s.openPaths, path] : s.openPaths,
    })),
  closeTab: (path) =>
    set((s) => {
      const openPaths = s.openPaths.filter((p) => p !== path);
      // If closing the active tab, fall back to the neighbor to its left.
      let activePath = s.activePath;
      if (s.activePath === path) {
        const idx = s.openPaths.indexOf(path);
        activePath = openPaths[idx - 1] ?? openPaths[0] ?? null;
      }
      return { openPaths, activePath };
    }),
  closeOtherTabs: (path) =>
    set((s) => ({
      openPaths: s.openPaths.includes(path) ? [path] : s.openPaths,
      activePath: s.openPaths.includes(path) ? path : s.activePath,
    })),
  closeAllTabs: () => set({ openPaths: [], activePath: null }),
  setTheme: (theme) => set({ theme }),
  setSidebarWidth: (width) => set({ sidebarWidth: width }),
  setWsConnected: (connected) => set({ wsConnected: connected }),
}));
