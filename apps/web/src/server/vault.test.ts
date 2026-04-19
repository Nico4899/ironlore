import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearVaultBackups,
  decryptVault,
  deriveVaultKey,
  encryptVault,
  readVault,
  reencryptVaults,
  VaultError,
  vaultBackupPath,
  vaultExists,
  vaultPath,
  writeVault,
} from "./vault.js";

/**
 * Vault module — round-trip, password-change re-encryption, rollback.
 *
 * Covers docs/05-jobs-and-security.md §Vault re-encryption:
 *  · Argon2id derivation is deterministic for a (password, salt) pair
 *  · AES-256-GCM round-trip round-trips bytes exactly
 *  · Wrong key fails authentication cleanly (no silent return)
 *  · writeVault retains the prior ciphertext as `.enc.bak`
 *  · reencryptVaults rewrites every project file and preserves rollbacks
 *  · clearVaultBackups removes them after a successful restart
 */

function makeTmp(): { projectDir: string; cleanup: () => void } {
  const projectDir = join(tmpdir(), `vault-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(projectDir, ".ironlore"), { recursive: true });
  const cleanup = () => {
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
  return { projectDir, cleanup };
}

describe("deriveVaultKey", () => {
  it("produces identical bytes for the same (password, salt)", async () => {
    const salt = randomBytes(16);
    const k1 = await deriveVaultKey("correct-horse-battery-staple", salt);
    const k2 = await deriveVaultKey("correct-horse-battery-staple", salt);
    const equal = k1.use((a) => k2.use((b) => a.equals(b)));
    expect(equal).toBe(true);
    k1.dispose();
    k2.dispose();
  });

  it("produces different bytes for different passwords with the same salt", async () => {
    const salt = randomBytes(16);
    const k1 = await deriveVaultKey("password-one", salt);
    const k2 = await deriveVaultKey("password-two", salt);
    const equal = k1.use((a) => k2.use((b) => a.equals(b)));
    expect(equal).toBe(false);
    k1.dispose();
    k2.dispose();
  });

  it("produces different bytes for different salts with the same password", async () => {
    const k1 = await deriveVaultKey("same-password", randomBytes(16));
    const k2 = await deriveVaultKey("same-password", randomBytes(16));
    const equal = k1.use((a) => k2.use((b) => a.equals(b)));
    expect(equal).toBe(false);
    k1.dispose();
    k2.dispose();
  });
});

describe("VaultKey", () => {
  it("throws after dispose()", async () => {
    const key = await deriveVaultKey("x", randomBytes(16));
    key.dispose();
    expect(() => key.use(() => 0)).toThrow(VaultError);
  });

  it("dispose() is idempotent", async () => {
    const key = await deriveVaultKey("x", randomBytes(16));
    key.dispose();
    expect(() => key.dispose()).not.toThrow();
  });
});

describe("encryptVault / decryptVault", () => {
  it("round-trips contents losslessly", async () => {
    const key = await deriveVaultKey("pw", randomBytes(16));
    const contents = { anthropic: "sk-ant-abc", openai: "sk-def" };
    const envelope = encryptVault(contents, key);
    expect(decryptVault(envelope, key)).toEqual(contents);
    key.dispose();
  });

  it("produces a fresh nonce per call (two envelopes of the same plaintext differ)", async () => {
    const key = await deriveVaultKey("pw", randomBytes(16));
    const e1 = encryptVault({ a: "b" }, key);
    const e2 = encryptVault({ a: "b" }, key);
    expect(e1).not.toBe(e2);
    key.dispose();
  });

  it("fails with decrypt_failed when the wrong key is used", async () => {
    const salt = randomBytes(16);
    const good = await deriveVaultKey("right-pw", salt);
    const bad = await deriveVaultKey("wrong-pw", salt);
    const envelope = encryptVault({ a: "b" }, good);
    expect(() => decryptVault(envelope, bad)).toThrow(
      expect.objectContaining({ code: "decrypt_failed" }),
    );
    good.dispose();
    bad.dispose();
  });

  it("fails with corrupt_envelope on bad JSON", async () => {
    const key = await deriveVaultKey("pw", randomBytes(16));
    expect(() => decryptVault("{not json", key)).toThrow(
      expect.objectContaining({ code: "corrupt_envelope" }),
    );
    key.dispose();
  });

  it("fails with unknown_version when envelope v differs", async () => {
    const key = await deriveVaultKey("pw", randomBytes(16));
    const envelope = JSON.parse(encryptVault({ a: "b" }, key));
    envelope.v = 999;
    expect(() => decryptVault(JSON.stringify(envelope), key)).toThrow(
      expect.objectContaining({ code: "unknown_version" }),
    );
    key.dispose();
  });

  it("fails with decrypt_failed when the auth tag was tampered with", async () => {
    const key = await deriveVaultKey("pw", randomBytes(16));
    const envelope = JSON.parse(encryptVault({ a: "b" }, key));
    // Flip one bit of the tag.
    const tag = Buffer.from(envelope.tag, "base64");
    tag[0] = (tag[0] ?? 0) ^ 0x01;
    envelope.tag = tag.toString("base64");
    expect(() => decryptVault(JSON.stringify(envelope), key)).toThrow(
      expect.objectContaining({ code: "decrypt_failed" }),
    );
    key.dispose();
  });
});

describe("writeVault / readVault", () => {
  let ctx: ReturnType<typeof makeTmp>;
  beforeEach(() => {
    ctx = makeTmp();
  });
  afterEach(() => ctx.cleanup());

  it("readVault returns {} when the file does not exist", async () => {
    const key = await deriveVaultKey("pw", randomBytes(16));
    expect(readVault(ctx.projectDir, key)).toEqual({});
    key.dispose();
  });

  it("writes and reads back the same contents", async () => {
    const key = await deriveVaultKey("pw", randomBytes(16));
    const contents = { anthropic: "sk-xyz" };
    writeVault(ctx.projectDir, contents, key);
    expect(vaultExists(ctx.projectDir)).toBe(true);
    expect(readVault(ctx.projectDir, key)).toEqual(contents);
    key.dispose();
  });

  it("retains prior ciphertext as .enc.bak on overwrite", async () => {
    const key = await deriveVaultKey("pw", randomBytes(16));
    writeVault(ctx.projectDir, { a: "v1" }, key);
    const firstCipher = readFileSync(vaultPath(ctx.projectDir), "utf-8");
    writeVault(ctx.projectDir, { a: "v2" }, key);
    expect(existsSync(vaultBackupPath(ctx.projectDir))).toBe(true);
    const backup = readFileSync(vaultBackupPath(ctx.projectDir), "utf-8");
    expect(backup).toBe(firstCipher);
    key.dispose();
  });

  it("writes the vault with mode 0600", async () => {
    const key = await deriveVaultKey("pw", randomBytes(16));
    writeVault(ctx.projectDir, { a: "v" }, key);
    const { statSync } = await import("node:fs");
    const stat = statSync(vaultPath(ctx.projectDir));
    // Mask off non-permission bits.
    expect(stat.mode & 0o777).toBe(0o600);
    key.dispose();
  });
});

describe("reencryptVaults", () => {
  function makeProjects(n: number): { projectDirs: string[]; cleanup: () => void } {
    const dirs: string[] = [];
    for (let i = 0; i < n; i++) {
      const t = makeTmp();
      dirs.push(t.projectDir);
    }
    const cleanup = () => {
      for (const d of dirs) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    };
    return { projectDirs: dirs, cleanup };
  }

  it("rewrites each project's vault under the new key and preserves contents", async () => {
    const salt = randomBytes(16);
    const { projectDirs, cleanup } = makeProjects(3);

    // Seed each project with a distinct vault under the old password.
    const oldKey = await deriveVaultKey("old-pw", salt);
    for (const [i, dir] of projectDirs.entries()) {
      writeVault(dir, { anthropic: `sk-${i}` }, oldKey);
    }
    oldKey.dispose();

    const summary = await reencryptVaults({
      projectDirs,
      oldPassword: "old-pw",
      newPassword: "new-pw",
      salt,
    });
    expect(summary.rewritten).toHaveLength(3);
    expect(summary.skipped).toHaveLength(0);
    expect(summary.failures).toHaveLength(0);

    // Each vault now decrypts under the new key with the right contents.
    const newKey = await deriveVaultKey("new-pw", salt);
    for (const [i, dir] of projectDirs.entries()) {
      expect(readVault(dir, newKey)).toEqual({ anthropic: `sk-${i}` });
    }
    newKey.dispose();

    cleanup();
  });

  it("skips projects that don't have a vault yet", async () => {
    const salt = randomBytes(16);
    const { projectDirs, cleanup } = makeProjects(2);

    const [dirA, dirB] = projectDirs as [string, string];
    const oldKey = await deriveVaultKey("old-pw", salt);
    writeVault(dirA, { a: "x" }, oldKey);
    oldKey.dispose();
    // dirB has no vault file.

    const summary = await reencryptVaults({
      projectDirs,
      oldPassword: "old-pw",
      newPassword: "new-pw",
      salt,
    });
    expect(summary.rewritten).toEqual([dirA]);
    expect(summary.skipped).toEqual([dirB]);
    expect(summary.failures).toHaveLength(0);

    cleanup();
  });

  it("records failures per-project without aborting the loop", async () => {
    const salt = randomBytes(16);
    const { projectDirs, cleanup } = makeProjects(2);
    const [dirA, dirB] = projectDirs as [string, string];

    const oldKey = await deriveVaultKey("right-old-pw", salt);
    writeVault(dirA, { a: "x" }, oldKey);
    oldKey.dispose();

    // Seed project[1] with a vault encrypted under a different password
    //  so the "old-pw" we pass to reencryptVaults fails to decrypt it.
    const strangerKey = await deriveVaultKey("stranger-pw", salt);
    writeVault(dirB, { a: "y" }, strangerKey);
    strangerKey.dispose();

    const summary = await reencryptVaults({
      projectDirs,
      oldPassword: "right-old-pw",
      newPassword: "new-pw",
      salt,
    });
    expect(summary.rewritten).toEqual([dirA]);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.projectDir).toBe(dirB);

    cleanup();
  });

  it("leaves a recoverable .enc.bak on every rewritten project", async () => {
    const salt = randomBytes(16);
    const { projectDirs, cleanup } = makeProjects(2);

    const oldKey = await deriveVaultKey("old-pw", salt);
    for (const d of projectDirs) {
      writeVault(d, { a: "x" }, oldKey);
    }
    oldKey.dispose();

    await reencryptVaults({
      projectDirs,
      oldPassword: "old-pw",
      newPassword: "new-pw",
      salt,
    });

    // Each .enc.bak should still decrypt under the OLD key — that's the
    //  rollback guarantee.
    const oldKey2 = await deriveVaultKey("old-pw", salt);
    for (const d of projectDirs) {
      const backup = readFileSync(vaultBackupPath(d), "utf-8");
      expect(decryptVault(backup, oldKey2)).toEqual({ a: "x" });
    }
    oldKey2.dispose();

    cleanup();
  });
});

describe("clearVaultBackups", () => {
  it("removes .enc.bak files and reports the count", () => {
    const t1 = makeTmp();
    const t2 = makeTmp();

    // Simulate rollback files from a prior re-encrypt.
    writeFileSync(vaultBackupPath(t1.projectDir), "cipher-1");
    writeFileSync(vaultBackupPath(t2.projectDir), "cipher-2");

    const removed = clearVaultBackups([t1.projectDir, t2.projectDir]);
    expect(removed).toBe(2);
    expect(existsSync(vaultBackupPath(t1.projectDir))).toBe(false);
    expect(existsSync(vaultBackupPath(t2.projectDir))).toBe(false);

    t1.cleanup();
    t2.cleanup();
  });

  it("is a no-op when no backups exist", () => {
    const t = makeTmp();
    expect(clearVaultBackups([t.projectDir])).toBe(0);
    t.cleanup();
  });
});
