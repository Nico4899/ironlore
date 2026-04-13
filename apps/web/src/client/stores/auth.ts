import { create } from "zustand";
import { fetchMe } from "../lib/api.js";

type AuthStatus = "loading" | "unauthenticated" | "authenticated" | "must-change-password";

interface AuthStore {
  status: AuthStatus;
  username: string | null;

  checkSession: () => Promise<void>;
  setAuthenticated: (username: string, mustChangePassword: boolean) => void;
  clearSession: () => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
  status: "loading",
  username: null,

  checkSession: async () => {
    try {
      const session = await fetchMe();
      if (!session) {
        set({ status: "unauthenticated", username: null });
        return;
      }
      set({
        status: session.mustChangePassword ? "must-change-password" : "authenticated",
        username: session.username,
      });
    } catch {
      set({ status: "unauthenticated", username: null });
    }
  },

  setAuthenticated: (username, mustChangePassword) => {
    set({
      status: mustChangePassword ? "must-change-password" : "authenticated",
      username,
    });
  },

  clearSession: () => {
    set({ status: "unauthenticated", username: null });
  },
}));
