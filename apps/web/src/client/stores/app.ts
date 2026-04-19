import { DEFAULT_PROJECT_ID } from "@ironlore/core";
import { create } from "zustand";

// Spec: sidebar range 220–420, AI panel fixed 380 — see docs/09-ui-and-brand.md
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 420;
export const SIDEBAR_DEFAULT_WIDTH = 260;

const SIDEBAR_WIDTH_KEY = "ironlore.sidebarWidth";
const THEME_KEY = "ironlore.theme";
const DENSITY_KEY = "ironlore.density";
const ACCENT_HUE_KEY = "ironlore.accentHue";
const MOTION_KEY = "ironlore.motion";
const MOTIFS_KEY = "ironlore.motifs";

/**
 * Motion intensity. `full` runs all animations; `reduced` mirrors
 * `prefers-reduced-motion: reduce` (pulse fades instead of translates,
 * Reuleaux rotation stops); `none` disables everything. CSS gating
 * lives in globals.css via `html[data-motion="..."]` selectors.
 */
export type MotionSetting = "full" | "reduced" | "none";

/**
 * Five toggleable decorative motifs. Two (`provenance`, `agentPulse`)
 * have live CSS plumbing that hides them when turned off. The other
 * two are persisted state the UI exposes so the user can signal
 * intent — `blockrefPreview` gates a tooltip feature that doesn't
 * exist yet, and `reuleauxPips` would swap every Reuleaux SVG for a
 * plain dot which is a larger component refactor. Both will light up
 * in later PRs without a schema change.
 */
export interface MotifSettings {
  provenance: boolean;
  agentPulse: boolean;
  blockrefPreview: boolean;
  reuleauxPips: boolean;
}

export const DEFAULT_MOTIFS: MotifSettings = {
  provenance: true,
  agentPulse: true,
  blockrefPreview: true,
  reuleauxPips: true,
};

/**
 * Default OKLCh hue for Ironlore Blue — 258 is the seed; users can
 * shift it ±30° via the Appearance settings (Phase 5 tweaks panel).
 * Lightness + chroma stay pinned so the contrast check still holds.
 */
export const DEFAULT_ACCENT_HUE = 258;

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

function loadDensity(): "comfortable" | "compact" {
  try {
    const raw = window.localStorage.getItem(DENSITY_KEY);
    if (raw === "comfortable" || raw === "compact") return raw;
  } catch {
    /* storage denied */
  }
  return "comfortable";
}

function loadAccentHue(): number {
  try {
    const raw = window.localStorage.getItem(ACCENT_HUE_KEY);
    const n = raw ? Number.parseFloat(raw) : Number.NaN;
    if (Number.isFinite(n) && n >= 0 && n < 360) return n;
  } catch {
    /* storage denied */
  }
  return DEFAULT_ACCENT_HUE;
}

function loadMotion(): MotionSetting {
  try {
    const raw = window.localStorage.getItem(MOTION_KEY);
    if (raw === "full" || raw === "reduced" || raw === "none") return raw;
  } catch {
    /* storage denied */
  }
  return "full";
}

/**
 * Load motif toggles, tolerating partial / corrupt payloads. Any
 * missing key falls back to `DEFAULT_MOTIFS[key] === true` so a
 * later-added motif defaults to visible without a migration.
 */
function loadMotifs(): MotifSettings {
  try {
    const raw = window.localStorage.getItem(MOTIFS_KEY);
    if (!raw) return { ...DEFAULT_MOTIFS };
    const parsed = JSON.parse(raw) as Partial<Record<keyof MotifSettings, unknown>>;
    return {
      provenance: parsed.provenance !== false,
      agentPulse: parsed.agentPulse !== false,
      blockrefPreview: parsed.blockrefPreview !== false,
      reuleauxPips: parsed.reuleauxPips !== false,
    };
  } catch {
    return { ...DEFAULT_MOTIFS };
  }
}

interface AppStore {
  currentProjectId: string;
  sidebarWidth: number;
  sidebarOpen: boolean;
  aiPanelOpen: boolean;
  searchDialogOpen: boolean;
  settingsOpen: boolean;
  terminalOpen: boolean;
  /** Cmd+P project switcher palette visibility (Phase 9 Item 2). */
  projectSwitcherOpen: boolean;
  /** Cross-project copy dialog source path, or null when closed (Phase 9 Item 4). */
  copyToProjectSrc: string | null;
  activePath: string | null;
  /**
   * Slug of the agent whose detail page is currently open, or null.
   * When non-null, the content area renders <AgentDetailPage /> instead
   * of the editor. Set via the activeAgent chip in the AI panel header
   * and cleared when the user selects any file path.
   */
  activeAgentSlug: string | null;
  /** Paths of files currently open as tabs, in tab order. */
  openPaths: string[];
  theme: "dark" | "light";
  /** Comfortable = body 13.5px / 12px rows; compact = body 12.5px / 6px rows. */
  density: "comfortable" | "compact";
  /**
   * Hue channel for Ironlore Blue, in degrees (0–360). User-shifted
   * accent while lightness + chroma stay pinned so the contrast
   * guarantees still hold. 258 is the seed value (canonical blue).
   */
  accentHue: number;
  /** Motion intensity — gates the keyframe animations in globals.css. */
  motion: MotionSetting;
  /** Decorative motif visibility toggles — see `MotifSettings` docs. */
  motifs: MotifSettings;
  wsConnected: boolean;
  wsReconnecting: boolean;
  provenance: { pagePath: string; blockId: string } | null;
  inboxOpen: boolean;
  /** Current folder path in the sidebar drill-down navigation. "" = root. */
  sidebarFolder: string;
  /** Active sidebar tab: home, search, explore. */
  sidebarTab: "home" | "search" | "explore";

  toggleSidebar: () => void;
  toggleAIPanel: () => void;
  toggleSearchDialog: () => void;
  toggleSettings: () => void;
  toggleTerminal: () => void;
  toggleProjectSwitcher: () => void;
  openCopyToProject: (srcPath: string) => void;
  closeCopyToProject: () => void;
  setActivePath: (path: string | null) => void;
  /** Open an agent's detail page. Passing null clears it. */
  setActiveAgentSlug: (slug: string | null) => void;
  closeTab: (path: string) => void;
  closeOtherTabs: (path: string) => void;
  closeAllTabs: () => void;
  setTheme: (theme: "dark" | "light") => void;
  toggleTheme: () => void;
  setDensity: (density: "comfortable" | "compact") => void;
  toggleDensity: () => void;
  setAccentHue: (hue: number) => void;
  setMotion: (motion: MotionSetting) => void;
  /**
   * Toggle one motif key. Using per-key setter (vs. a whole-object
   * setter) means the Settings UI re-renders minimally and
   * individual toggles are easy to wire into `onChange`.
   */
  setMotif: <K extends keyof MotifSettings>(key: K, value: MotifSettings[K]) => void;
  setSidebarWidth: (width: number) => void;
  setWsConnected: (connected: boolean) => void;
  setWsReconnecting: (reconnecting: boolean) => void;
  openProvenance: (pagePath: string, blockId: string) => void;
  closeProvenance: () => void;
  toggleInbox: () => void;
  setSidebarFolder: (folder: string) => void;
  setSidebarTab: (tab: "home" | "search" | "explore") => void;
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

function persistDensity(density: "comfortable" | "compact"): void {
  try {
    window.localStorage.setItem(DENSITY_KEY, density);
  } catch {
    /* storage denied */
  }
}

function persistAccentHue(hue: number): void {
  try {
    window.localStorage.setItem(ACCENT_HUE_KEY, String(hue));
  } catch {
    /* storage denied */
  }
}

function persistMotion(motion: MotionSetting): void {
  try {
    window.localStorage.setItem(MOTION_KEY, motion);
  } catch {
    /* storage denied */
  }
}

function persistMotifs(motifs: MotifSettings): void {
  try {
    window.localStorage.setItem(MOTIFS_KEY, JSON.stringify(motifs));
  } catch {
    /* storage denied */
  }
}

export const useAppStore = create<AppStore>((set) => ({
  currentProjectId: DEFAULT_PROJECT_ID,
  sidebarWidth: loadSidebarWidth(),
  sidebarOpen: true,
  aiPanelOpen: false,
  searchDialogOpen: false,
  settingsOpen: false,
  terminalOpen: false,
  projectSwitcherOpen: false,
  copyToProjectSrc: null,
  activePath: null,
  activeAgentSlug: null,
  openPaths: [],
  theme: loadTheme(),
  density: loadDensity(),
  accentHue: loadAccentHue(),
  motion: loadMotion(),
  motifs: loadMotifs(),
  wsConnected: false,
  wsReconnecting: false,
  provenance: null,
  inboxOpen: false,
  sidebarFolder: "",
  sidebarTab: "home",

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleAIPanel: () => set((s) => ({ aiPanelOpen: !s.aiPanelOpen })),
  toggleSearchDialog: () => set((s) => ({ searchDialogOpen: !s.searchDialogOpen })),
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),
  toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),
  toggleProjectSwitcher: () => set((s) => ({ projectSwitcherOpen: !s.projectSwitcherOpen })),
  openCopyToProject: (srcPath) => set({ copyToProjectSrc: srcPath }),
  closeCopyToProject: () => set({ copyToProjectSrc: null }),
  // Opening an agent detail page and opening a file are mutually
  // exclusive surfaces in the content area — toggling one clears the
  // other so the user never sees a half-rendered mash-up.
  setActiveAgentSlug: (slug) =>
    set((s) => ({ activeAgentSlug: slug, activePath: slug ? null : s.activePath })),
  setActivePath: (path) =>
    set((s) => {
      let openPaths = s.openPaths;
      if (path && !openPaths.includes(path)) {
        openPaths = [...openPaths, path];
        // Enforce 10-tab limit — close oldest when exceeded
        if (openPaths.length > 10) {
          openPaths = openPaths.slice(openPaths.length - 10);
        }
      }
      return { activePath: path, openPaths, activeAgentSlug: path ? null : s.activeAgentSlug };
    }),
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
  setDensity: (density) => {
    persistDensity(density);
    set({ density });
  },
  toggleDensity: () =>
    set((s) => {
      const density = s.density === "comfortable" ? "compact" : "comfortable";
      persistDensity(density);
      return { density };
    }),
  setAccentHue: (hue) => {
    // Wrap into [0, 360) so a user who types 400 still lands on a valid hue.
    const wrapped = ((hue % 360) + 360) % 360;
    persistAccentHue(wrapped);
    set({ accentHue: wrapped });
  },
  setMotion: (motion) => {
    persistMotion(motion);
    set({ motion });
  },
  setMotif: (key, value) =>
    set((s) => {
      const next: MotifSettings = { ...s.motifs, [key]: value };
      persistMotifs(next);
      return { motifs: next };
    }),
  setSidebarWidth: (width) => {
    const clamped = clamp(width, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
    persistSidebarWidth(clamped);
    set({ sidebarWidth: clamped });
  },
  setWsConnected: (connected) => set({ wsConnected: connected }),
  setWsReconnecting: (reconnecting) => set({ wsReconnecting: reconnecting }),
  openProvenance: (pagePath, blockId) => set({ provenance: { pagePath, blockId } }),
  closeProvenance: () => set({ provenance: null }),
  toggleInbox: () => set((s) => ({ inboxOpen: !s.inboxOpen })),
  setSidebarFolder: (folder) => set({ sidebarFolder: folder }),
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
}));
