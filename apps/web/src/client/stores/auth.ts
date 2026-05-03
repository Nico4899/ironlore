import { create } from "zustand";
import { ApiError, fetchMe, setApiProject } from "../lib/api.js";

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

      // The switcher reloads with `?project=<id>` to drive the switch.
      //  Now that the session has applied it, strip the param from the
      //  address bar so a casual Cmd+R doesn't keep replaying the
      //  switch (and so users sharing screenshots don't see a stale
      //  drive-by query in the URL).
      try {
        const browserUrl = new URL(window.location.href);
        if (browserUrl.searchParams.has("project")) {
          browserUrl.searchParams.delete("project");
          window.history.replaceState(null, "", browserUrl.toString());
        }
      } catch {
        /* SSR / non-browser context — skip */
      }
    } catch (err) {
      // Transient failures (rate-limit, network blip) must NOT boot
      //  the user to the login screen — a 429 on `/me` after a few
      //  quick Cmd+R reloads is not evidence of an invalid session.
      //  Only treat a definitive "not authenticated" response (401,
      //  handled by `fetchMe` returning null) as grounds to clear.
      if (err instanceof ApiError && (err.status === 429 || err.status >= 500)) {
        // Leave the current state alone — next `checkSession` will
        //  retry. We intentionally don't flip `status` back to
        //  `loading` here either, since that would re-render the
        //  loading splash during a transient hiccup.
        return;
      }
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
