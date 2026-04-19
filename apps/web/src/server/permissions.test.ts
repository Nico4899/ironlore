import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPermissions } from "./permissions.js";

/**
 * checkPermissions() test suite.
 *
 * Verifies the server refuses to start when sensitive files have
 * permissions broader than 0600.
 */

function makeInstallRoot(): string {
  const dir = join(tmpdir(), `perms-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "projects", "main", ".ironlore"), { recursive: true });
  return dir;
}

describe("checkPermissions", () => {
  // POSIX modes are not meaningful on Windows, so skip there.
  if (process.platform === "win32") {
    it("is a no-op on Windows", () => {
      expect(checkPermissions("/anything")).toEqual([]);
    });
    return;
  }

  it("returns no violations when all sensitive files have mode 0600", () => {
    const root = makeInstallRoot();
    for (const file of ["ipc.token", ".ironlore-install.json", "password.salt"]) {
      const path = join(root, file);
      writeFileSync(path, "data", { mode: 0o600 });
    }
    const violations = checkPermissions(root);
    expect(violations).toEqual([]);
  });

  it("returns no violations when files don't exist yet (first run)", () => {
    const root = makeInstallRoot();
    const violations = checkPermissions(root);
    expect(violations).toEqual([]);
  });

  it("flags ipc.token with mode 0644", () => {
    const root = makeInstallRoot();
    const path = join(root, "ipc.token");
    writeFileSync(path, "token");
    chmodSync(path, 0o644);
    const violations = checkPermissions(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("ipc.token");
    expect(violations[0]).toContain("0644");
    expect(violations[0]).toContain("chmod 600");
  });

  it("flags multiple violations", () => {
    const root = makeInstallRoot();
    for (const file of ["ipc.token", "password.salt"]) {
      const path = join(root, file);
      writeFileSync(path, "data");
      chmodSync(path, 0o666);
    }
    const violations = checkPermissions(root);
    expect(violations).toHaveLength(2);
  });

  it("flags world-readable file (0644) as too broad", () => {
    const root = makeInstallRoot();
    const path = join(root, "sessions.sqlite");
    writeFileSync(path, "data");
    chmodSync(path, 0o644);
    const violations = checkPermissions(root);
    expect(violations.some((v) => v.includes("sessions.sqlite"))).toBe(true);
  });

  it("flags per-project api-keys.enc with wrong mode", () => {
    const root = makeInstallRoot();
    const path = join(root, "projects", "main", ".ironlore", "api-keys.enc");
    writeFileSync(path, "encrypted");
    chmodSync(path, 0o644);
    const violations = checkPermissions(root);
    expect(violations.some((v) => v.includes("api-keys.enc"))).toBe(true);
  });
});
