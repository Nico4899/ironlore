import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSafe, ResolveSafeError } from "./resolve-safe.js";

function makeTmpRoot(): string {
  const dir = join(tmpdir(), `ironlore-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("resolveSafe", () => {
  const roots: string[] = [];

  function createRoot(): string {
    const root = makeTmpRoot();
    roots.push(root);
    return root;
  }

  afterEach(() => {
    // Cleanup handled by OS tmpdir
  });

  it("resolves a simple path within root", () => {
    const root = createRoot();
    writeFileSync(join(root, "test.md"), "hello");
    const result = resolveSafe(root, "test.md");
    expect(result).toBe(join(root, "test.md"));
  });

  it("resolves nested paths", () => {
    const root = createRoot();
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "sub", "page.md"), "hello");
    const result = resolveSafe(root, "sub/page.md");
    expect(result).toBe(join(root, "sub", "page.md"));
  });

  it("allows paths to non-existent files (for creation)", () => {
    const root = createRoot();
    const result = resolveSafe(root, "new-file.md");
    expect(result).toBe(join(root, "new-file.md"));
  });

  it("rejects ../  traversal", () => {
    const root = createRoot();
    expect(() => resolveSafe(root, "../etc/passwd")).toThrow(ResolveSafeError);
  });

  it("rejects absolute paths outside root", () => {
    const root = createRoot();
    expect(() => resolveSafe(root, "/etc/passwd")).toThrow(ResolveSafeError);
  });

  it("rejects ../../ deep traversal", () => {
    const root = createRoot();
    expect(() => resolveSafe(root, "sub/../../etc/passwd")).toThrow(ResolveSafeError);
  });

  it("rejects symlink escape", () => {
    const root = createRoot();
    const outsideDir = makeTmpRoot();
    writeFileSync(join(outsideDir, "secret.md"), "secret");
    symlinkSync(outsideDir, join(root, "escape"));

    expect(() => resolveSafe(root, "escape/secret.md")).toThrow(ResolveSafeError);
  });

  it("allows symlink within root", () => {
    const root = createRoot();
    mkdirSync(join(root, "real"), { recursive: true });
    writeFileSync(join(root, "real", "page.md"), "hello");
    symlinkSync(join(root, "real"), join(root, "link"));

    const result = resolveSafe(root, "link/page.md");
    expect(result).toBe(join(root, "real", "page.md"));
  });
});
