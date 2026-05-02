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
