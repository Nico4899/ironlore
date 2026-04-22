import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Install-global key-store for LLM provider credentials.
 *
 * Persisted to `<installRoot>/.ironlore/providers.json` with POSIX
 * mode 0600. Values are stored **in plaintext** — the spec's
 * encrypted vault (per-project `api-keys.enc`, Argon2id-derived
 * key) needs session-scoped plumbing that's out of scope for this
 * chunk. The file is install-local + user-readable-only, so the
 * threat model here is "casual access on the same machine" rather
 * than "cold-storage theft".
 *
 * Follow-up: route reads + writes through `vault.ts`, caching the
 * Argon2id-derived key alongside the session after login so we
 * don't have to prompt for the admin password on every key
 * operation. Documented in docs/01-deployment.md §follow-ups (TBD).
 */

const KEY_STORE_FILENAME = "providers.json";

/**
 * Shape of the keys file. The JSON envelope leaves room for
 * per-provider extensions (endpoints, default models) without
 * migrating the file shape — extra keys on each entry are
 * preserved on write.
 */
interface KeyStoreShape {
  version: 1;
  providers: Record<string, { apiKey?: string; endpoint?: string; defaultModel?: string }>;
}

function storePath(installRoot: string): string {
  return join(installRoot, ".ironlore", KEY_STORE_FILENAME);
}

function emptyStore(): KeyStoreShape {
  return { version: 1, providers: {} };
}

/**
 * Read the key-store. Missing file → empty store (not an error).
 * Corrupt JSON → empty store + a one-line console warning so the
 * user knows they've lost the file; we don't throw because that
 * would brick provider-independent routes on a minor issue.
 */
export function readKeyStore(installRoot: string): KeyStoreShape {
  const path = storePath(installRoot);
  if (!existsSync(path)) return emptyStore();
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<KeyStoreShape>;
    if (parsed && typeof parsed === "object" && parsed.version === 1 && parsed.providers) {
      return { version: 1, providers: parsed.providers };
    }
    console.warn(`providers.json: unexpected shape, ignoring (${path})`);
    return emptyStore();
  } catch (err) {
    console.warn(
      `providers.json: failed to parse, ignoring (${err instanceof Error ? err.message : err})`,
    );
    return emptyStore();
  }
}

/**
 * Write the key-store atomically. Creates `.ironlore/` if needed
 * and always sets mode 0600 on the output.
 */
export function writeKeyStore(installRoot: string, store: KeyStoreShape): void {
  const dir = join(installRoot, ".ironlore");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = storePath(installRoot);
  // Write through a tmp file + rename for atomicity.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  // `rename` on POSIX is atomic within the same filesystem, which
  //  makes this writer safe against a torn half-file if the server
  //  crashes mid-write.
  renameSync(tmp, path);
}

/**
 * Upsert a single provider's key. `apiKey === ""` clears the key
 * (remove-from-store); the provider entry itself stays so any
 * `endpoint` / `defaultModel` overrides survive.
 */
export function setProviderKey(installRoot: string, name: string, apiKey: string): void {
  const store = readKeyStore(installRoot);
  const existing = store.providers[name] ?? {};
  if (!apiKey) {
    delete existing.apiKey;
  } else {
    existing.apiKey = apiKey;
  }
  store.providers[name] = existing;
  writeKeyStore(installRoot, store);
}

/** Read a provider's configured key, or `null` when none is set. */
export function getProviderKey(installRoot: string, name: string): string | null {
  const store = readKeyStore(installRoot);
  return store.providers[name]?.apiKey ?? null;
}

/** Quick predicate: does this provider have a stored key? */
export function hasProviderKey(installRoot: string, name: string): boolean {
  return getProviderKey(installRoot, name) !== null;
}
