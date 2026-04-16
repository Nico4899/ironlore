import { DEFAULT_PROJECT_ID } from "@ironlore/core";
import { create } from "zustand";

// Spec: sidebar range 220–420, AI panel fixed 380 — see docs/09-ui-and-brand.md
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 420;
export const SIDEBAR_DEFAULT_WIDTH = 260;

const SIDEBAR_WIDTH_KEY = "ironlore.sidebarWidth";
const THEME_KEY = "ironlore.theme";

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function loadSidebarWidth(): number {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
    const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (!Number.isFinite(n)) return SIDEBAR_DEFAULT_WIDTH;
    return clamp(n, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function loadTheme(): "dark" | "light" {
  try {
    const raw = window.localStorage.getItem(THEME_KEY);
    if (raw === "dark" || raw === "light") return raw;
  } catch {
    // Storage denied — fall through to default.
  }
  return "dark";
}

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
  wsReconnecting: boolean;

  toggleSidebar: () => void;
  toggleAIPanel: () => void;
  toggleSearchDialog: () => void;
  toggleTerminal: () => void;
  setActivePath: (path: string | null) => void;
  closeTab: (path: string) => void;
  closeOtherTabs: (path: string) => void;
  closeAllTabs: () => void;
  setTheme: (theme: "dark" | "light") => void;
  toggleTheme: () => void;
  setSidebarWidth: (width: number) => void;
  setWsConnected: (connected: boolean) => void;
  setWsReconnecting: (reconnecting: boolean) => void;
}

function persistSidebarWidth(width: number): void {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  } catch {
    // Storage denied — width still lives in memory for the session.
  }
}

function persistTheme(theme: "dark" | "light"): void {
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage denied — theme still lives in memory for the session.
  }
}

export const useAppStore = create<AppStore>((set) => ({
  currentProjectId: DEFAULT_PROJECT_ID,
  sidebarWidth: loadSidebarWidth(),
  sidebarOpen: true,
  aiPanelOpen: false,
  searchDialogOpen: false,
  terminalOpen: false,
  activePath: null,
  openPaths: [],
  theme: loadTheme(),
  wsConnected: false,
  wsReconnecting: false,

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
  setTheme: (theme) => {
    persistTheme(theme);
    set({ theme });
  },
  toggleTheme: () =>
    set((s) => {
      const theme = s.theme === "dark" ? "light" : "dark";
      persistTheme(theme);
      return { theme };
    }),
  setSidebarWidth: (width) => {
    const clamped = clamp(width, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
    persistSidebarWidth(clamped);
    set({ sidebarWidth: clamped });
  },
  setWsConnected: (connected) => set({ wsConnected: connected }),
  setWsReconnecting: (reconnecting) => set({ wsReconnecting: reconnecting }),
}));
