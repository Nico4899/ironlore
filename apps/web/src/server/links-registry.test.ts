import { randomBytes } from "node:crypto";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSafe } from "@ironlore/core/server";
import { afterEach, describe, expect, it } from "vitest";
import { LinkMarkerMissingError, LinksRegistry } from "./links-registry.js";

function makeTmpProject(): string {
  const raw = join(tmpdir(), `ironlore-link-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(raw, "data"), { recursive: true });
  mkdirSync(join(raw, ".ironlore"), { recursive: true });
  return realpathSync(raw);
}

function makeExternalDir(withMarker: boolean): string {
  const raw = join(tmpdir(), `ironlore-ext-${randomBytes(4).toString("hex")}`);
  mkdirSync(raw, { recursive: true });
  if (withMarker) {
    writeFileSync(join(raw, ".ironlore-link.yaml"), "kind: linked-dir\n");
  }
  return realpathSync(raw);
}

describe("LinksRegistry", () => {
  const registries: LinksRegistry[] = [];

  function createRegistry(): { registry: LinksRegistry; projectDir: string } {
    const projectDir = makeTmpProject();
    const registry = new LinksRegistry(projectDir);
    registries.push(registry);
    return { registry, projectDir };
  }

  afterEach(() => {
    for (const r of registries) {
      r.close();
    }
    registries.length = 0;
  });

  // -------------------------------------------------------------------------
  // registerLink
  // -------------------------------------------------------------------------

  it("registers a linked directory with a valid marker file", () => {
    const { registry } = createRegistry();
    const extDir = makeExternalDir(true);

    const row = registry.registerLink("external/notes", extDir);

    expect(row.symlink_path).toBe("external/notes");
    expect(row.target_realpath).toBe(extDir);
    expect(row.created_by).toBe("user");
    expect(row.id).toBeGreaterThan(0);
  });

  it("rejects registration when marker file is missing", () => {
    const { registry } = createRegistry();
    const extDir = makeExternalDir(false);

    expect(() => registry.registerLink("external/bad", extDir)).toThrow(LinkMarkerMissingError);
  });

  it("rejects duplicate symlink_path registration", () => {
    const { registry } = createRegistry();
    const extDir = makeExternalDir(true);

    registry.registerLink("external/dup", extDir);
    expect(() => registry.registerLink("external/dup", extDir)).toThrow(/UNIQUE/);
  });

  // -------------------------------------------------------------------------
  // removeLink
  // -------------------------------------------------------------------------

  it("removes a registered link and returns true", () => {
    const { registry } = createRegistry();
    const extDir = makeExternalDir(true);
    registry.registerLink("external/remove-me", extDir);

    expect(registry.removeLink("external/remove-me")).toBe(true);
    expect(registry.list()).toHaveLength(0);
  });

  it("returns false when removing a non-existent link", () => {
    const { registry } = createRegistry();
    expect(registry.removeLink("nope")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // isRegistered
  // -------------------------------------------------------------------------

  it("returns true for a registered path with marker", () => {
    const { registry } = createRegistry();
    const extDir = makeExternalDir(true);
    registry.registerLink("external/ok", extDir);

    expect(registry.isRegistered(extDir)).toBe(true);
  });

  it("returns false for a registered path whose marker was deleted", () => {
    const { registry } = createRegistry();
    const extDir = makeExternalDir(true);
    registry.registerLink("external/stale", extDir);

    // Remove the marker file
    const { unlinkSync } = require("node:fs");
    unlinkSync(join(extDir, ".ironlore-link.yaml"));

    expect(registry.isRegistered(extDir)).toBe(false);
  });

  it("returns false for an unregistered path", () => {
    const { registry } = createRegistry();
    const extDir = makeExternalDir(true);
    expect(registry.isRegistered(extDir)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  it("lists all registered links in creation order", () => {
    const { registry } = createRegistry();
    const ext1 = makeExternalDir(true);
    const ext2 = makeExternalDir(true);

    registry.registerLink("external/a", ext1);
    registry.registerLink("external/b", ext2);

    const all = registry.list();
    expect(all).toHaveLength(2);
    expect(all[0]?.symlink_path).toBe("external/a");
    expect(all[1]?.symlink_path).toBe("external/b");
  });

  // -------------------------------------------------------------------------
  // validator() — integration with resolveSafe
  // -------------------------------------------------------------------------

  it("validator allows resolveSafe to follow a registered symlink", () => {
    const { registry, projectDir } = createRegistry();
    const extDir = makeExternalDir(true);
    const dataRoot = join(projectDir, "data");

    // Create a symlink inside data/ that points outside
    mkdirSync(join(dataRoot, "external"), { recursive: true });
    symlinkSync(extDir, join(dataRoot, "external", "linked"));

    // Register the link
    registry.registerLink("external/linked", extDir);

    // resolveSafe with validator should succeed
    const result = resolveSafe(dataRoot, "external/linked", registry.validator());
    expect(result).toBe(extDir);
  });

  it("resolveSafe rejects an unregistered symlink even with validator", () => {
    const { registry, projectDir } = createRegistry();
    const extDir = makeExternalDir(true);
    const dataRoot = join(projectDir, "data");

    // Create symlink but don't register it
    mkdirSync(join(dataRoot, "external"), { recursive: true });
    symlinkSync(extDir, join(dataRoot, "external", "sneaky"));

    expect(() => resolveSafe(dataRoot, "external/sneaky", registry.validator())).toThrow(
      "symlink escapes project root",
    );
  });

  it("resolveSafe rejects a hand-planted symlink without marker", () => {
    const { registry, projectDir } = createRegistry();
    const extDir = makeExternalDir(false); // no marker
    const dataRoot = join(projectDir, "data");

    mkdirSync(join(dataRoot, "external"), { recursive: true });
    symlinkSync(extDir, join(dataRoot, "external", "planted"));

    // Can't even register without marker, so validator will return false
    expect(() => resolveSafe(dataRoot, "external/planted", registry.validator())).toThrow(
      "symlink escapes project root",
    );
  });
});
