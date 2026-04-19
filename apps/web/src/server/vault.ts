import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { hashRaw } from "@node-rs/argon2";

// `Algorithm` from @node-rs/argon2 is a `const enum`, which TypeScript's
//  isolatedModules flag forbids reaching across modules. Mirror the
//  numeric value (Argon2id = 2) locally instead.
const ARGON2ID = 2;

/**
 * Per-project API-key vault. Each project's keys live in
 * `projects/<id>/.ironlore/api-keys.enc` encrypted with AES-256-GCM
 * under a key derived from the admin password via Argon2id. On
 * password change the vault is re-encrypted inline (see
 * `reencryptVaults`), and the prior ciphertext is retained as
 * `.enc.bak` for one restart cycle so a mid-rewrite crash is
 * recoverable.
 *
 * Per docs/05-jobs-and-security.md §Secrets + §Vault re-encryption.
 *
 * Design notes:
 *  · AES-256-GCM chosen for authenticated encryption — prevents
 *    ciphertext tampering from producing silent decryption failures
 *    on the next boot.
 *  · Format: JSON `{ version, nonce, ciphertext, tag }` with all
 *    three byte fields base64-encoded. Versioned so future rotations
 *    (larger key, different cipher) can migrate cleanly.
 *  · The derived vault key is held in memory only as long as the
 *    decrypted vault is held; callers that cache provider keys
 *    should zero their cache on `reencryptVaults` (spec §Cache
 *    scrubbing). The `VaultKey` class provides `dispose()` to zero
 *    the buffer deterministically.
 */

// ─── Argon2id parameters (spec §Vault re-encryption) ─────────────
/** 19 MiB — balance between cracking resistance and startup time. */
const ARGON2_MEMORY_KB = 19 * 1024;
const ARGON2_ITERATIONS = 2;
const ARGON2_PARALLELISM = 1;
/** AES-256 wants 32 bytes of key material. */
const VAULT_KEY_LEN = 32;

// ─── AES-256-GCM parameters ──────────────────────────────────────
/** 12-byte nonce is the NIST-recommended GCM size. */
const GCM_NONCE_LEN = 12;
const VAULT_FILENAME = "api-keys.enc";
const VAULT_BACKUP_SUFFIX = ".bak";
const VAULT_TMP_SUFFIX = ".tmp";
/** Envelope version — bump on breaking format change. */
const VAULT_VERSION = 1;

export interface VaultEnvelope {
  v: number;
  nonce: string; // base64
  ct: string; // base64
  tag: string; // base64
}

export type VaultContents = Record<string, string>;

export class VaultError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

/**
 * A derived vault key. Keep the raw bytes isolated so callers can
 * zero them on re-encrypt without touching every byte they touched.
 */
export class VaultKey {
  private bytes: Buffer | null;

  constructor(bytes: Buffer) {
    if (bytes.byteLength !== VAULT_KEY_LEN) {
      throw new VaultError("invalid_key_length", `Vault key must be ${VAULT_KEY_LEN} bytes`);
    }
    this.bytes = bytes;
  }

  /** Borrow the raw bytes for a single cipher operation. */
  use<T>(fn: (bytes: Buffer) => T): T {
    if (!this.bytes) throw new VaultError("key_disposed", "Vault key was already disposed");
    return fn(this.bytes);
  }

  /** Zero the key buffer — call after a password change. */
  dispose(): void {
    if (this.bytes) {
      this.bytes.fill(0);
      this.bytes = null;
    }
  }
}

/**
 * Derive a vault key from the admin password + the per-install salt
 * (same salt file auth.ts uses for password hashing). Argon2id is
 * deliberately slow; callers should derive once and reuse via
 * `VaultKey` for the lifetime of the current password.
 */
export async function deriveVaultKey(password: string, salt: Buffer): Promise<VaultKey> {
  const raw = await hashRaw(password, {
    salt,
    memoryCost: ARGON2_MEMORY_KB,
    timeCost: ARGON2_ITERATIONS,
    parallelism: ARGON2_PARALLELISM,
    algorithm: ARGON2ID,
    outputLen: VAULT_KEY_LEN,
  });
  return new VaultKey(Buffer.from(raw));
}

/**
 * Encrypt a vault object under the given derived key. Returns the
 * serialized envelope (JSON string) ready to write to disk.
 */
export function encryptVault(contents: VaultContents, key: VaultKey): string {
  const nonce = randomBytes(GCM_NONCE_LEN);
  const plaintext = Buffer.from(JSON.stringify(contents), "utf-8");
  const { ciphertext, tag } = key.use((bytes) => {
    const cipher = createCipheriv("aes-256-gcm", bytes, nonce);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { ciphertext: ct, tag: cipher.getAuthTag() };
  });
  const envelope: VaultEnvelope = {
    v: VAULT_VERSION,
    nonce: nonce.toString("base64"),
    ct: ciphertext.toString("base64"),
    tag: tag.toString("base64"),
  };
  return JSON.stringify(envelope);
}

/**
 * Decrypt an envelope back to a vault object. Throws
 * `VaultError("decrypt_failed")` on bad tag — authentication failure
 * means either the password changed or the file was tampered with.
 */
export function decryptVault(serialized: string, key: VaultKey): VaultContents {
  let envelope: VaultEnvelope;
  try {
    envelope = JSON.parse(serialized) as VaultEnvelope;
  } catch (err) {
    throw new VaultError("corrupt_envelope", `Vault JSON parse failed: ${(err as Error).message}`);
  }
  if (envelope.v !== VAULT_VERSION) {
    throw new VaultError(
      "unknown_version",
      `Vault envelope version ${envelope.v} not supported (expected ${VAULT_VERSION})`,
    );
  }
  const nonce = Buffer.from(envelope.nonce, "base64");
  const ciphertext = Buffer.from(envelope.ct, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  if (nonce.byteLength !== GCM_NONCE_LEN) {
    throw new VaultError("corrupt_nonce", `Vault nonce length mismatch: ${nonce.byteLength}`);
  }

  return key.use((bytes) => {
    const decipher = createDecipheriv("aes-256-gcm", bytes, nonce);
    decipher.setAuthTag(tag);
    try {
      const pt = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(pt.toString("utf-8")) as VaultContents;
    } catch (err) {
      throw new VaultError("decrypt_failed", `Vault decrypt failed: ${(err as Error).message}`);
    }
  });
}

// ─── file I/O ────────────────────────────────────────────────────

/**
 * Path the vault lives at for a given project directory.
 * `projects/<id>/.ironlore/api-keys.enc`.
 */
export function vaultPath(projectDir: string): string {
  return join(projectDir, ".ironlore", VAULT_FILENAME);
}

/** Path of the rollback backup retained across one restart cycle. */
export function vaultBackupPath(projectDir: string): string {
  return `${vaultPath(projectDir)}${VAULT_BACKUP_SUFFIX}`;
}

/**
 * Read the vault from disk and decrypt. Returns `{}` cleanly when no
 * vault exists yet (first boot, pre-keys install). Callers that need
 * to distinguish missing-vault from empty-vault can call
 * `vaultExists` first.
 */
export function readVault(projectDir: string, key: VaultKey): VaultContents {
  const path = vaultPath(projectDir);
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf-8");
  return decryptVault(raw, key);
}

export function vaultExists(projectDir: string): boolean {
  return existsSync(vaultPath(projectDir));
}

/**
 * Encrypt `contents` and write to disk atomically. Any existing
 * vault is retained as `.enc.bak` first so a mid-write crash doesn't
 * destroy the prior ciphertext.
 *
 * File mode 0600 (owner-only) per spec §File permissions.
 */
export function writeVault(projectDir: string, contents: VaultContents, key: VaultKey): void {
  const path = vaultPath(projectDir);
  const backup = vaultBackupPath(projectDir);
  const tmp = `${path}${VAULT_TMP_SUFFIX}`;

  mkdirSync(dirname(path), { recursive: true });
  const serialized = encryptVault(contents, key);

  // Retain current file as .bak before overwriting — spec §Rollback
  //  guarantee. We use renameSync (atomic on POSIX) rather than copy
  //  so the ciphertext can't be partially written.
  if (existsSync(path)) {
    try {
      if (existsSync(backup)) rmSync(backup, { force: true });
      renameSync(path, backup);
    } catch {
      /* non-fatal — proceed to write new cipher, old file was lost */
    }
  }

  writeFileSync(tmp, serialized, { mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Re-encrypt every project's vault under a new derived key. Runs
 * inline with the password-change request. Each project's file is
 * rewritten atomically via `writeVault`; the prior ciphertext
 * becomes `.enc.bak`. On failure mid-loop we report which project
 * failed but don't attempt an automatic rollback — the user can
 * restart the server and boot against `.enc.bak` (which still
 * decrypts under the old key) if they kept it.
 *
 * Returns a summary describing the action taken.
 */
export async function reencryptVaults(params: {
  projectDirs: string[];
  oldPassword: string;
  newPassword: string;
  salt: Buffer;
}): Promise<{
  rewritten: string[];
  skipped: string[];
  failures: Array<{ projectDir: string; error: string }>;
}> {
  const oldKey = await deriveVaultKey(params.oldPassword, params.salt);
  let newKey: VaultKey | null = null;
  try {
    newKey = await deriveVaultKey(params.newPassword, params.salt);
  } catch (err) {
    oldKey.dispose();
    throw err;
  }

  const rewritten: string[] = [];
  const skipped: string[] = [];
  const failures: Array<{ projectDir: string; error: string }> = [];

  for (const projectDir of params.projectDirs) {
    if (!vaultExists(projectDir)) {
      skipped.push(projectDir);
      continue;
    }
    try {
      const contents = readVault(projectDir, oldKey);
      writeVault(projectDir, contents, newKey);
      rewritten.push(projectDir);
    } catch (err) {
      failures.push({
        projectDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  oldKey.dispose();
  newKey.dispose();
  return { rewritten, skipped, failures };
}

/**
 * Clear any `.enc.bak` rollback files that survived a prior restart.
 * Spec §Rollback guarantee says the backup is retained for "one
 * restart cycle" — we call this once at the end of successful boot
 * so the next reboot starts clean.
 */
export function clearVaultBackups(projectDirs: string[]): number {
  let removed = 0;
  for (const projectDir of projectDirs) {
    const backup = vaultBackupPath(projectDir);
    if (existsSync(backup)) {
      try {
        rmSync(backup, { force: true });
        removed++;
      } catch {
        /* best-effort */
      }
    }
  }
  return removed;
}

/**
 * Constant-time comparison for byte buffers. Used by tests that
 * assert two envelopes came from the same plaintext (rare, since
 * AES-GCM with random nonces won't match) but exported for any call
 * site that needs a safe equality check.
 */
export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}
