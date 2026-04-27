import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SENSITIVE_FILE_MODE } from "@ironlore/core";
import { hash } from "@node-rs/argon2";
import Database from "better-sqlite3";

/**
 * `ironlore user add <username>` — provision a second user on a
 * multi-user install. The provisioned password is printed to stdout
 * once and never persisted in plaintext; the user is forced to
 * change it on first login (the same `must_change_password` flag
 * the bootstrap admin uses).
 *
 * docs/08-projects-and-isolation.md §Multi-user mode and per-page
 * ACLs is the spec source of truth for this command. Inlining the
 * Argon2id call rather than depending on `@ironlore/web` keeps the
 * CLI's dependency footprint minimal — `password.salt` is the
 * shared interface between server and CLI.
 */

interface UserAddOptions {
  /** Install root; defaults to `process.cwd()`. */
  installRoot?: string;
  /** Override the random initial password (for tests). */
  initialPassword?: string;
}

/**
 * Load (or, if missing, write) the per-instance password salt.
 * Mirrors `loadSalt` in [`apps/web/src/server/auth.ts`](../../../apps/web/src/server/auth.ts) — same file,
 * same format. Both processes (server + CLI) share `password.salt`
 * so a hash produced by either side validates against the other.
 */
function loadSalt(installRoot: string): Buffer {
  const saltPath = join(installRoot, "password.salt");
  if (existsSync(saltPath)) {
    return Buffer.from(readFileSync(saltPath, "utf-8").trim(), "hex");
  }
  const salt = randomBytes(16);
  writeFileSync(saltPath, salt.toString("hex"), { mode: SENSITIVE_FILE_MODE });
  return salt;
}

function generateInitialPassword(): string {
  // 32 random bytes → 48-char base64url, trimmed to 24. Matches the
  // bootstrap admin password generator in `bootstrap.ts`.
  return randomBytes(32).toString("base64url").slice(0, 24);
}

export async function userAdd(
  username: string,
  opts: UserAddOptions = {},
): Promise<{ id: string; initialPassword: string }> {
  if (!username || /[^a-z0-9._-]/i.test(username)) {
    throw new Error(
      `Invalid username '${username}'. Use only [a-zA-Z0-9._-]; spaces and special chars are not allowed.`,
    );
  }

  const installRoot = resolve(opts.installRoot ?? process.cwd());
  const sessionsPath = join(installRoot, "sessions.sqlite");
  if (!existsSync(sessionsPath)) {
    throw new Error(
      `sessions.sqlite not found at ${sessionsPath}. Run the server once before adding users.`,
    );
  }

  const salt = loadSalt(installRoot);
  const initialPassword = opts.initialPassword ?? generateInitialPassword();
  const passwordHash = await hash(initialPassword, { salt });

  const db = new Database(sessionsPath);
  chmodSync(sessionsPath, SENSITIVE_FILE_MODE);
  db.pragma("journal_mode = WAL");

  // Conflict-aware INSERT — `username` is UNIQUE in the schema; a
  // second invocation with the same username should report a clean
  // error rather than a SQLite constraint violation.
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
    | { id: string }
    | undefined;
  if (existing) {
    db.close();
    throw new Error(`User '${username}' already exists (id ${existing.id}).`);
  }

  const id = randomBytes(16).toString("hex");
  db.prepare(
    "INSERT INTO users (id, username, password_hash, must_change_password) VALUES (?, ?, ?, ?)",
  ).run(id, username, passwordHash, 1);
  db.close();

  // CLI surface: announce the new user + provisioned password the
  // same shape `bootstrap.ts` uses for the admin user. The caller
  // copies the password to a secure channel.
  console.log("─".repeat(60));
  console.log(`  Ironlore — user provisioned`);
  console.log("─".repeat(60));
  console.log(`  Username: ${username}`);
  console.log(`  Initial password: ${initialPassword}`);
  console.log("─".repeat(60));
  console.log("  Save this password now — it will not be shown again.");
  console.log("  The user will be asked to change it on first login.");
  console.log("─".repeat(60));

  return { id, initialPassword };
}
