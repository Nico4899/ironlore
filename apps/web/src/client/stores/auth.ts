import { create } from "zustand";
import { fetchMe, setApiProject } from "../lib/api.js";

type AuthStatus = "loading" | "unauthenticated" | "authenticated" | "must-change-password";

interface AuthStore {
  status: AuthStatus;
  username: string | null;
  currentProjectId: string | null;

  checkSession: () => Promise<void>;
  setAuthenticated: (username: string, mustChangePassword: boolean) => void;
  setCurrentProjectId: (projectId: string) => void;
  clearSession: () => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
  status: "loading",
  username: null,
  currentProjectId: null,

  checkSession: async () => {
    try {
      const session = await fetchMe();
      if (!session) {
        set({ status: "unauthenticated", username: null, currentProjectId: null });
        return;
      }
      // Pin the api-client's base URL to whatever project the server
      //  thinks the session is on. Subsequent fetches route through it.
      setApiProject(session.currentProjectId);
      set({
        status: session.mustChangePassword ? "must-change-password" : "authenticated",
        username: session.username,
        currentProjectId: session.currentProjectId,
      });
    } catch {
      set({ status: "unauthenticated", username: null, currentProjectId: null });
    }
  },

  setAuthenticated: (username, mustChangePassword) => {
    set({
      status: mustChangePassword ? "must-change-password" : "authenticated",
      username,
    });
  },

  setCurrentProjectId: (projectId) => {
    setApiProject(projectId);
    set({ currentProjectId: projectId });
  },

  clearSession: () => {
    set({ status: "unauthenticated", username: null, currentProjectId: null });
  },
}));
