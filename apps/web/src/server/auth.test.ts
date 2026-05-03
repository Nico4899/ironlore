import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTALL_JSON, SENSITIVE_FILE_MODE } from "@ironlore/core";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthApi, SessionStore } from "./auth.js";

describe("SessionStore", () => {
  let installRoot: string;
  let store: SessionStore;

  beforeEach(() => {
    installRoot = mkdtempSync(join(tmpdir(), "ironlore-auth-"));
    mkdirSync(installRoot, { recursive: true });
    store = new SessionStore(installRoot);
  });

  afterEach(() => {
    store.close();
    rmSync(installRoot, { recursive: true, force: true });
  });

  it("creates and retrieves a user", () => {
    const id = store.createUser("alice", "hash123", false);
    const user = store.getUser("alice");
    expect(user).toBeDefined();
    expect(user?.id).toBe(id);
    expect(user?.username).toBe("alice");
  });

  it("creates and retrieves a session", () => {
    const userId = store.createUser("bob", "hash456", false);
    const sessionId = store.createSession(userId, "main");
    const session = store.getSession(sessionId);
    expect(session).toBeDefined();
    expect(session?.user_id).toBe(userId);
    expect(session?.current_project_id).toBe("main");
    expect(session?.username).toBe("bob");
  });

  it("deletes a session", () => {
    const userId = store.createUser("charlie", "hash789", false);
    const sessionId = store.createSession(userId, "main");
    store.deleteSession(sessionId);
    const session = store.getSession(sessionId);
    expect(session).toBeUndefined();
  });

  it("updates session project", () => {
    const userId = store.createUser("dave", "hashABC", false);
    const sessionId = store.createSession(userId, "main");
    store.updateSessionProject(sessionId, "research");
    const session = store.getSession(sessionId);
    expect(session?.current_project_id).toBe("research");
  });

  it("updates password and clears must_change flag", () => {
    const userId = store.createUser("eve", "oldHash", true);
    const user = store.getUser("eve");
    expect(user?.must_change_password).toBe(1);

    store.updatePassword(userId, "newHash");
    const updated = store.getUser("eve");
    expect(updated?.password_hash).toBe("newHash");
    expect(updated?.must_change_password).toBe(0);
  });

  it("counts users", () => {
    expect(store.userCount()).toBe(0);
    store.createUser("user1", "h1", false);
    expect(store.userCount()).toBe(1);
    store.createUser("user2", "h2", false);
    expect(store.userCount()).toBe(2);
  });
});

describe("Auth API", () => {
  let installRoot: string;
  let store: SessionStore;

  beforeEach(() => {
    installRoot = mkdtempSync(join(tmpdir(), "ironlore-authapi-"));
    mkdirSync(installRoot, { recursive: true });

    // Write install record
    const record = {
      admin_username: "admin",
      initial_password: "TestPassword123456789012",
      created_at: new Date().toISOString(),
    };
    writeFileSync(join(installRoot, INSTALL_JSON), JSON.stringify(record), {
      mode: SENSITIVE_FILE_MODE,
    });

    store = new SessionStore(installRoot);
  });

  afterEach(() => {
    store.close();
    rmSync(installRoot, { recursive: true, force: true });
  });

  it("logs in with bootstrap credentials and creates admin user", async () => {
    const { api } = createAuthApi(installRoot, store);
    const res = await api.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "admin",
        password: "TestPassword123456789012",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.username).toBe("admin");
    expect(body.mustChangePassword).toBe(true);

    // Admin user should now exist in the store
    const user = store.getUser("admin");
    expect(user).toBeDefined();
  });

  it("rejects invalid credentials", async () => {
    const { api } = createAuthApi(installRoot, store);
    const res = await api.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "admin",
        password: "wrong",
      }),
    });

    expect(res.status).toBe(401);
  });

  it("returns authenticated status via /me with valid session", async () => {
    const { api } = createAuthApi(installRoot, store);

    // Login first
    const loginRes = await api.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "admin",
        password: "TestPassword123456789012",
      }),
    });
    expect(loginRes.status).toBe(200);

    // Extract session cookie
    const setCookieHeader = loginRes.headers.get("set-cookie") ?? "";
    const cookieMatch = /ironlore_session=([^;]+)/.exec(setCookieHeader);
    expect(cookieMatch).toBeTruthy();
    const cookie = cookieMatch?.[1];

    // Check /me
    const meRes = await api.request("/me", {
      headers: { Cookie: `ironlore_session=${cookie}` },
    });
    expect(meRes.status).toBe(200);
    const meBody = await meRes.json();
    expect(meBody.authenticated).toBe(true);
    expect(meBody.username).toBe("admin");
  });

  it("returns 401 for /me without session", async () => {
    const { api } = createAuthApi(installRoot, store);
    const res = await api.request("/me");
    expect(res.status).toBe(401);
  });

  it("logs out and invalidates session", async () => {
    const { api } = createAuthApi(installRoot, store);

    // Login
    const loginRes = await api.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "admin",
        password: "TestPassword123456789012",
      }),
    });
    const setCookieHeader = loginRes.headers.get("set-cookie") ?? "";
    const cookieMatch = /ironlore_session=([^;]+)/.exec(setCookieHeader);
    const cookie = cookieMatch?.[1];

    // Logout
    const logoutRes = await api.request("/logout", {
      method: "POST",
      headers: { Cookie: `ironlore_session=${cookie}` },
    });
    expect(logoutRes.status).toBe(200);

    // /me should fail now
    const meRes = await api.request("/me", {
      headers: { Cookie: `ironlore_session=${cookie}` },
    });
    expect(meRes.status).toBe(401);
  });
});

// Bug 8 regression — auth middleware silently ignored
// `?project=<typo>` and the user landed on the previous project
// with no signal. Now sets X-Ironlore-Invalid-Project so a SPA
// (or DevTools) can surface the typo.

describe("Auth middleware — invalid project query", () => {
  let installRoot: string;
  let store: SessionStore;

  beforeEach(() => {
    installRoot = mkdtempSync(join(tmpdir(), "ironlore-mw-"));
    mkdirSync(installRoot, { recursive: true });
    writeFileSync(
      join(installRoot, INSTALL_JSON),
      JSON.stringify({
        admin_username: "admin",
        initial_password: "TestPassword123456789012",
        created_at: new Date().toISOString(),
      }),
      { mode: SENSITIVE_FILE_MODE },
    );
    store = new SessionStore(installRoot);
  });

  afterEach(() => {
    store.close();
    rmSync(installRoot, { recursive: true, force: true });
  });

  /** Helper: spin up a tiny Hono app with the auth middleware mounted
   *  on `/api/projects/*` (matching the production layout) and an
   *  echo handler. Returns the app + a logged-in cookie. */
  async function setupApp(opts: { isProjectValid?: (id: string) => boolean }) {
    const { api, middleware } = createAuthApi(installRoot, store, opts);

    // Login via the auth API to get a real session cookie.
    const loginRes = await api.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "admin",
        password: "TestPassword123456789012",
      }),
    });
    const setCookie = loginRes.headers.get("set-cookie") ?? "";
    const cookie = (/ironlore_session=([^;]+)/.exec(setCookie) ?? [])[1] ?? "";

    // The bootstrap admin sits behind a must-change-password gate.
    // Settle the password change so the middleware lets `/api/projects/*`
    // requests through (otherwise every test below 403s).
    await api.request("/change-password", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `ironlore_session=${cookie}`,
      },
      body: JSON.stringify({
        currentPassword: "TestPassword123456789012",
        newPassword: "NewLongPassword987654321!",
      }),
    });

    // Build the test app — middleware then a trivial echo route.
    const app = new Hono();
    app.use("/api/projects/*", middleware);
    app.get("/api/projects/main/echo", (c) => c.json({ ok: true }));

    return { app, cookie };
  }

  it("sets X-Ironlore-Invalid-Project when ?project=<unknown> is requested", async () => {
    const { app, cookie } = await setupApp({
      isProjectValid: (id) => id === "main" || id === "my-research",
    });

    const res = await app.request("/api/projects/main/echo?project=research", {
      headers: { Cookie: `ironlore_session=${cookie}` },
    });
    expect(res.status).toBe(200); // request still succeeds (graceful fallback)
    expect(res.headers.get("X-Ironlore-Invalid-Project")).toBe("research");
  });

  it("does NOT set the header when the project ID is valid", async () => {
    const { app, cookie } = await setupApp({
      isProjectValid: (id) => id === "main" || id === "my-research",
    });

    const res = await app.request("/api/projects/main/echo?project=my-research", {
      headers: { Cookie: `ironlore_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Ironlore-Invalid-Project")).toBeNull();
  });

  it("does NOT set the header when no ?project= query is present", async () => {
    const { app, cookie } = await setupApp({
      isProjectValid: (id) => id === "main",
    });

    const res = await app.request("/api/projects/main/echo", {
      headers: { Cookie: `ironlore_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Ironlore-Invalid-Project")).toBeNull();
  });
});

// Switcher-bug regression — `/api/auth/me?project=<id>` must apply
// the drive-by switch the same way the protected-routes middleware
// does. Without this, the SPA's first call after the switcher's
// reload returns the *previous* `current_project_id` and pins the
// session to it, silently ignoring the user's pick.
describe("/me — drive-by project switch", () => {
  let installRoot: string;
  let store: SessionStore;

  beforeEach(() => {
    installRoot = mkdtempSync(join(tmpdir(), "ironlore-me-switch-"));
    mkdirSync(installRoot, { recursive: true });
    writeFileSync(
      join(installRoot, INSTALL_JSON),
      JSON.stringify({
        admin_username: "admin",
        initial_password: "TestPassword123456789012",
        created_at: new Date().toISOString(),
      }),
      { mode: SENSITIVE_FILE_MODE },
    );
    store = new SessionStore(installRoot);
  });

  afterEach(() => {
    store.close();
    rmSync(installRoot, { recursive: true, force: true });
  });

  async function loginCookie(api: Hono): Promise<string> {
    const loginRes = await api.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "admin",
        password: "TestPassword123456789012",
      }),
    });
    const setCookie = loginRes.headers.get("set-cookie") ?? "";
    return (/ironlore_session=([^;]+)/.exec(setCookie) ?? [])[1] ?? "";
  }

  it("applies the switch and returns the new currentProjectId when ?project= is valid", async () => {
    const { api } = createAuthApi(installRoot, store, {
      isProjectValid: (id) => id === "main" || id === "research",
    });
    const cookie = await loginCookie(api);

    const res = await api.request("/me?project=research", {
      headers: { Cookie: `ironlore_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authenticated: boolean; currentProjectId: string };
    expect(body.authenticated).toBe(true);
    expect(body.currentProjectId).toBe("research");

    // A subsequent bare /me call must keep the persisted switch.
    const res2 = await api.request("/me", {
      headers: { Cookie: `ironlore_session=${cookie}` },
    });
    const body2 = (await res2.json()) as { currentProjectId: string };
    expect(body2.currentProjectId).toBe("research");
  });

  it("keeps the old project and sets X-Ironlore-Invalid-Project for an unknown ?project=", async () => {
    const { api } = createAuthApi(installRoot, store, {
      isProjectValid: (id) => id === "main",
    });
    const cookie = await loginCookie(api);

    const res = await api.request("/me?project=ghost", {
      headers: { Cookie: `ironlore_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Ironlore-Invalid-Project")).toBe("ghost");
    const body = (await res.json()) as { currentProjectId: string };
    expect(body.currentProjectId).toBe("main");
  });
});
