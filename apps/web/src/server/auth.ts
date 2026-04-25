import { verify as cryptoVerify, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTH_RATE_LIMIT,
  DEFAULT_PROJECT_ID,
  INSTALL_JSON,
  SENSITIVE_FILE_MODE,
} from "@ironlore/core";
import { hash, verify } from "@node-rs/argon2";
import Database from "better-sqlite3";
import type { Context, Next } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { reencryptVaults } from "./vault.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  must_change_password: number;
  created_at: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  current_project_id: string;
  expires_at: string;
  last_seen_at: string;
}

interface RateBucket {
  count: number;
  windowStart: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_COOKIE = "ironlore_session";
const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60; // 7 days
const RATE_WINDOW_MS = 60_000; // 1 minute

// ---------------------------------------------------------------------------
// SessionStore — SQLite-backed session management
// ---------------------------------------------------------------------------

export class SessionStore {
  private db: Database.Database;

  constructor(installRoot: string) {
    const dbPath = join(installRoot, "sessions.sqlite");
    this.db = new Database(dbPath);
    chmodSync(dbPath, SENSITIVE_FILE_MODE);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        current_project_id TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_ID}',
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  // -- User management --

  getUser(username: string): UserRow | undefined {
    return this.db.prepare("SELECT * FROM users WHERE username = ?").get(username) as
      | UserRow
      | undefined;
  }

  createUser(username: string, passwordHash: string, mustChange: boolean): string {
    const id = randomBytes(16).toString("hex");
    this.db
      .prepare(
        "INSERT INTO users (id, username, password_hash, must_change_password) VALUES (?, ?, ?, ?)",
      )
      .run(id, username, passwordHash, mustChange ? 1 : 0);
    return id;
  }

  updatePassword(userId: string, passwordHash: string): void {
    this.db
      .prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?")
      .run(passwordHash, userId);
  }

  userCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS cnt FROM users").get() as { cnt: number };
    return row.cnt;
  }

  // -- Session management --

  createSession(userId: string, projectId: string): string {
    const id = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_S * 1000).toISOString();
    this.db
      .prepare(
        "INSERT INTO sessions (id, user_id, current_project_id, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(id, userId, projectId, expiresAt);
    return id;
  }

  getSession(
    sessionId: string,
  ): (SessionRow & { username: string; must_change_password: number }) | undefined {
    return this.db
      .prepare(
        `SELECT s.*, u.username, u.must_change_password
         FROM sessions s JOIN users u ON s.user_id = u.id
         WHERE s.id = ? AND s.expires_at > datetime('now')`,
      )
      .get(sessionId) as
      | (SessionRow & { username: string; must_change_password: number })
      | undefined;
  }

  touchSession(sessionId: string): void {
    this.db
      .prepare("UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?")
      .run(sessionId);
  }

  deleteSession(sessionId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  }

  updateSessionProject(sessionId: string, projectId: string): void {
    this.db
      .prepare("UPDATE sessions SET current_project_id = ? WHERE id = ?")
      .run(projectId, sessionId);
  }

  /** Remove all expired sessions. */
  pruneExpired(): number {
    const result = this.db
      .prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')")
      .run();
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Password hashing (Argon2id via @node-rs/argon2)
// ---------------------------------------------------------------------------

/**
 * Load or create the per-instance password salt.
 * Stored at `<installRoot>/password.salt` with mode 0600.
 *
 * Exported so the CLI's `user add` command can hash new-user
 * passwords against the same salt the running server uses — they
 * read the same file and produce the same hash format.
 */
export function loadSalt(installRoot: string): Buffer {
  const saltPath = join(installRoot, "password.salt");
  if (existsSync(saltPath)) {
    return Buffer.from(readFileSync(saltPath, "utf-8").trim(), "hex");
  }
  const salt = randomBytes(16);
  writeFileSync(saltPath, salt.toString("hex"), { mode: SENSITIVE_FILE_MODE });
  return salt;
}

export async function hashPassword(password: string, salt: Buffer): Promise<string> {
  return hash(password, { salt });
}

async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}

// ---------------------------------------------------------------------------
// Ed25519 session signing
// ---------------------------------------------------------------------------

interface SigningKeys {
  privateKey: string;
  publicKey: string;
}

/**
 * Generate ephemeral Ed25519 key pair for session cookie signing.
 * Generated fresh on every startup — sessions survive process restart
 * because they live in SQLite, but the cookie signature is only valid
 * for the current process lifetime.
 */
function generateSigningKeys(): SigningKeys {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return { privateKey, publicKey };
}

function signSessionId(sessionId: string, privateKey: string): string {
  const sig = sign(null, Buffer.from(sessionId), privateKey);
  return `${sessionId}.${sig.toString("base64url")}`;
}

function verifySessionCookie(cookie: string, publicKey: string): string | null {
  const dotIdx = cookie.lastIndexOf(".");
  if (dotIdx === -1) return null;
  const sessionId = cookie.slice(0, dotIdx);
  const sig = cookie.slice(dotIdx + 1);
  try {
    const valid = cryptoVerify(
      null,
      Buffer.from(sessionId),
      publicKey,
      Buffer.from(sig, "base64url"),
    );
    if (valid) return sessionId;
  } catch {
    // Invalid signature format
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rate limiter (in-memory token bucket by IP + username)
// ---------------------------------------------------------------------------

const rateBuckets = new Map<string, RateBucket>();

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key);

  if (!bucket || now - bucket.windowStart > RATE_WINDOW_MS) {
    rateBuckets.set(key, { count: 1, windowStart: now });
    return false;
  }

  bucket.count++;
  if (bucket.count > AUTH_RATE_LIMIT) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Auth API factory
// ---------------------------------------------------------------------------

export interface CreateAuthApiOptions {
  /**
   * Returns the list of project directories whose vaults should be
   * re-encrypted when the admin password changes. The caller owns the
   * multi-project discovery policy (today: just DEFAULT_PROJECT_ID,
   * post-Phase-5: scan the projects/ root). Called fresh per password
   * change so new projects are picked up without a server restart.
   */
  getProjectDirs?: () => string[];

  /**
   * Returns true when the given projectId exists and the current
   * install is permitted to route requests to it. Consulted by
   * `PUT /session/project` and by the auth middleware when the
   * `?project=<id>` query param is present on a request.
   *
   * Omitting this option turns project validation into a no-op — any
   * string is accepted. The default index.ts wiring always provides
   * it, backed by the `ProjectRegistry`.
   */
  isProjectValid?: (projectId: string) => boolean;
}

export function createAuthApi(
  installRoot: string,
  store: SessionStore,
  options: CreateAuthApiOptions = {},
): {
  api: Hono;
  middleware: (c: Context, next: Next) => Promise<Response | undefined>;
  signingKeys: SigningKeys;
  validateCookie: (cookie: string) => string | null;
} {
  const api = new Hono();
  const salt = loadSalt(installRoot);
  const signingKeys = generateSigningKeys();

  // -- Bootstrap: ensure admin user exists from install record --
  if (store.userCount() === 0) {
    const installJsonPath = join(installRoot, INSTALL_JSON);
    if (existsSync(installJsonPath)) {
      // We need to create the admin user asynchronously, but we can't
      // await in this sync context. We'll defer to the login flow:
      // on first login with the initial password, the user is created.
    }
  }

  // ----------------------------------------------------------------
  // GET /api/auth/first-run-hint
  //
  // Returns `{ hint: "terminal" }` while `.ironlore-install.json` is
  // still on disk — i.e. the initial admin password has not yet been
  // consumed via the first login + password change. Returns
  // `{ hint: null }` afterwards. The endpoint deliberately never
  // exposes the password itself; it just tells the UI *where* the
  // password was printed so a fresh user doesn't stare at a blank
  // login form with no hint it was emitted to stdout.
  //
  // Public — this runs before authentication by design.
  // ----------------------------------------------------------------
  api.get("/first-run-hint", (c) => {
    const installJsonPath = join(installRoot, INSTALL_JSON);
    const hint = existsSync(installJsonPath) ? "terminal" : null;
    return c.json({ hint });
  });

  // ----------------------------------------------------------------
  // POST /api/auth/login
  // ----------------------------------------------------------------
  api.post("/login", async (c) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "127.0.0.1";
    const body = await c.req.json<{ username: string; password: string }>();
    const { username, password } = body;

    if (!username || !password) {
      return c.json({ error: "Username and password required" }, 400);
    }

    // Rate limit check
    const rateKey = `${ip}:${username}`;
    if (isRateLimited(rateKey)) {
      return c.json({ error: "Too many login attempts. Please wait before trying again." }, 429);
    }

    let user = store.getUser(username);

    // First-login bootstrap: create admin user from install record
    if (!user && username === "admin") {
      const installJsonPath = join(installRoot, INSTALL_JSON);
      if (existsSync(installJsonPath)) {
        try {
          const record = JSON.parse(readFileSync(installJsonPath, "utf-8"));
          if (record.initial_password === password) {
            const passwordHash = await hashPassword(password, salt);
            store.createUser("admin", passwordHash, true);
            user = store.getUser("admin");
          }
        } catch {
          // Corrupted install record — fall through to invalid credentials
        }
      }
    }

    if (!user) {
      return c.json({ error: "Invalid credentials. Please try again." }, 401);
    }

    // Verify password
    const valid = await verifyPassword(user.password_hash, password);
    if (!valid) {
      return c.json({ error: "Invalid credentials. Please try again." }, 401);
    }

    // Create session
    const sessionId = store.createSession(user.id, DEFAULT_PROJECT_ID);
    const signed = signSessionId(sessionId, signingKeys.privateKey);

    setCookie(c, SESSION_COOKIE, signed, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: SESSION_MAX_AGE_S,
      path: "/",
    });

    return c.json({
      username: user.username,
      mustChangePassword: user.must_change_password === 1,
    });
  });

  // ----------------------------------------------------------------
  // POST /api/auth/logout
  // ----------------------------------------------------------------
  api.post("/logout", async (c) => {
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie) {
      const sessionId = verifySessionCookie(cookie, signingKeys.publicKey);
      if (sessionId) {
        store.deleteSession(sessionId);
      }
    }
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // ----------------------------------------------------------------
  // POST /api/auth/change-password
  // ----------------------------------------------------------------
  api.post("/change-password", async (c) => {
    const cookie = getCookie(c, SESSION_COOKIE);
    if (!cookie) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    const sessionId = verifySessionCookie(cookie, signingKeys.publicKey);
    if (!sessionId) {
      return c.json({ error: "Invalid session" }, 401);
    }

    const session = store.getSession(sessionId);
    if (!session) {
      return c.json({ error: "Session expired" }, 401);
    }

    const body = await c.req.json<{
      currentPassword: string;
      newPassword: string;
    }>();

    if (!body.currentPassword || !body.newPassword) {
      return c.json({ error: "Current and new passwords required" }, 400);
    }

    if (body.newPassword.length < 12) {
      return c.json({ error: "New password must be at least 12 characters" }, 400);
    }

    // Look up the user and verify current password
    const user = store.getUser(session.username);
    if (!user) {
      return c.json({ error: "User not found" }, 401);
    }

    const valid = await verifyPassword(user.password_hash, body.currentPassword);
    if (!valid) {
      return c.json({ error: "Current password is incorrect" }, 401);
    }

    // Re-encrypt every project's API-key vault under the new password
    //  BEFORE we flip the stored hash. If this step fails we want the
    //  admin's current password to still work — so they can retry or
    //  restart and boot against the `.enc.bak` rollback files that
    //  writeVault retained.
    //
    //  Spec: docs/05-jobs-and-security.md §Vault re-encryption.
    const projectDirs = options.getProjectDirs?.() ?? [];
    let vaultSummary: Awaited<ReturnType<typeof reencryptVaults>> | undefined;
    if (projectDirs.length > 0) {
      try {
        vaultSummary = await reencryptVaults({
          projectDirs,
          oldPassword: body.currentPassword,
          newPassword: body.newPassword,
          salt,
        });
        if (vaultSummary.failures.length > 0) {
          return c.json(
            {
              error: "Vault re-encryption failed for one or more projects",
              failures: vaultSummary.failures,
            },
            500,
          );
        }
      } catch (err) {
        return c.json(
          {
            error: "Vault re-encryption failed",
            detail: err instanceof Error ? err.message : String(err),
          },
          500,
        );
      }
    }

    // Hash and store new password
    const newHash = await hashPassword(body.newPassword, salt);
    store.updatePassword(user.id, newHash);

    // Delete the install record on first password change
    if (user.must_change_password === 1) {
      const installJsonPath = join(installRoot, INSTALL_JSON);
      try {
        const { unlinkSync } = await import("node:fs");
        if (existsSync(installJsonPath)) {
          unlinkSync(installJsonPath);
        }
      } catch {
        // Non-fatal — the record is consumed even if we can't delete the file
      }
    }

    return c.json({
      ok: true,
      vault: vaultSummary
        ? {
            rewritten: vaultSummary.rewritten.length,
            skipped: vaultSummary.skipped.length,
          }
        : undefined,
    });
  });

  // ----------------------------------------------------------------
  // GET /api/auth/me
  // ----------------------------------------------------------------
  api.get("/me", (c) => {
    const cookie = getCookie(c, SESSION_COOKIE);
    if (!cookie) {
      return c.json({ authenticated: false }, 401);
    }

    const sessionId = verifySessionCookie(cookie, signingKeys.publicKey);
    if (!sessionId) {
      return c.json({ authenticated: false }, 401);
    }

    const session = store.getSession(sessionId);
    if (!session) {
      return c.json({ authenticated: false }, 401);
    }

    store.touchSession(sessionId);

    return c.json({
      authenticated: true,
      username: session.username,
      currentProjectId: session.current_project_id,
      mustChangePassword: session.must_change_password === 1,
    });
  });

  // ----------------------------------------------------------------
  // PUT /api/session/project — switch current project
  // ----------------------------------------------------------------
  api.put("/session/project", async (c) => {
    const cookie = getCookie(c, SESSION_COOKIE);
    if (!cookie) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    const sessionId = verifySessionCookie(cookie, signingKeys.publicKey);
    if (!sessionId) {
      return c.json({ error: "Invalid session" }, 401);
    }

    const session = store.getSession(sessionId);
    if (!session) {
      return c.json({ error: "Session expired" }, 401);
    }

    const body = await c.req.json<{ projectId: string }>();
    if (!body.projectId) {
      return c.json({ error: "projectId required" }, 400);
    }

    if (options.isProjectValid && !options.isProjectValid(body.projectId)) {
      return c.json({ error: `Unknown project '${body.projectId}'` }, 404);
    }

    store.updateSessionProject(sessionId, body.projectId);
    return c.json({ ok: true, currentProjectId: body.projectId });
  });

  // ----------------------------------------------------------------
  // Auth middleware — validates session cookie on protected routes
  // ----------------------------------------------------------------
  const middleware = async (c: Context, next: Next): Promise<Response | undefined> => {
    const cookie = getCookie(c, SESSION_COOKIE);
    if (!cookie) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const sessionId = verifySessionCookie(cookie, signingKeys.publicKey);
    if (!sessionId) {
      return c.json({ error: "Invalid session" }, 401);
    }

    const session = store.getSession(sessionId);
    if (!session) {
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
      return c.json({ error: "Session expired" }, 401);
    }

    // Block all non-password-change routes if password change is required
    if (session.must_change_password === 1) {
      const path = new URL(c.req.url).pathname;
      if (!path.endsWith("/auth/change-password") && !path.endsWith("/auth/me")) {
        return c.json({ error: "Password change required", mustChangePassword: true }, 403);
      }
    }

    // Accept `?project=<id>` as a drive-by project switch (the
    //  project switcher reloads the page with this query param per
    //  docs/08-projects-and-isolation.md §Project switcher UX). We
    //  validate the id before persisting so a malformed query can't
    //  poison the session.
    let currentProjectId = session.current_project_id;
    const requestedProject = new URL(c.req.url).searchParams.get("project");
    if (
      requestedProject &&
      requestedProject !== currentProjectId &&
      (!options.isProjectValid || options.isProjectValid(requestedProject))
    ) {
      store.updateSessionProject(sessionId, requestedProject);
      currentProjectId = requestedProject;
    }

    store.touchSession(sessionId);
    c.set("userId", session.user_id);
    c.set("username", session.username);
    c.set("currentProjectId", currentProjectId);

    await next();
  };

  /**
   * Validate a session cookie string. Returns the session ID if valid, null otherwise.
   * Exported for use by the WebSocket upgrade handler.
   */
  const validateCookie = (cookie: string): string | null => {
    return verifySessionCookie(cookie, signingKeys.publicKey);
  };

  return { api, middleware, signingKeys, validateCookie };
}
