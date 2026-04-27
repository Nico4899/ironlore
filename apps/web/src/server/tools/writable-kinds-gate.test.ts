import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolCallContext } from "./types.js";
import { assertWritableKind, WritableKindsViolation } from "./writable-kinds-gate.js";

/**
 * `writable_kinds` runtime gate — closes the long-documented gap
 * where the rule was in `kb.replace_block`'s docstring but never
 * enforced. Tests cover the three permissive cases (no persona, no
 * scope, null page kind) and the deny path for both YAML styles
 * personas use in seeded fixtures.
 */

function makeTmpDataRoot(): string {
  const dir = join(tmpdir(), `writable-kinds-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function ctx(dataRoot: string, agentSlug: string): ToolCallContext {
  return {
    projectId: "main",
    agentSlug,
    jobId: "test",
    emitEvent: () => undefined,
    dataRoot,
    fetch: globalThis.fetch,
  };
}

function writePersona(dataRoot: string, slug: string, frontmatter: string): void {
  const dir = join(dataRoot, ".agents", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "persona.md"),
    `---\nslug: ${slug}\n${frontmatter}\n---\n\nbody\n`,
    "utf-8",
  );
}

describe("assertWritableKind — permissive paths", () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = makeTmpDataRoot();
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it("permits when the persona file is missing (test fixtures, fresh installs)", () => {
    expect(() => assertWritableKind(ctx(dataRoot, "ghost"), "source")).not.toThrow();
  });

  it("permits when the persona has no scope.writable_kinds field (legacy / unscoped)", () => {
    writePersona(dataRoot, "permissive", "active: true");
    expect(() => assertWritableKind(ctx(dataRoot, "permissive"), "source")).not.toThrow();
  });

  it("treats a null page kind as 'page' (un-classified pages stay editable)", () => {
    writePersona(dataRoot, "scoped", "scope:\n  writable_kinds: [page, wiki]");
    // Null kind → effective kind 'page' → in writable_kinds → allowed.
    expect(() => assertWritableKind(ctx(dataRoot, "scoped"), null)).not.toThrow();
  });

  it("permits when the agentSlug is empty (e.g. anonymous tool callers)", () => {
    expect(() => assertWritableKind(ctx(dataRoot, ""), "source")).not.toThrow();
  });
});

describe("assertWritableKind — deny path", () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = makeTmpDataRoot();
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it("throws WritableKindsViolation when the page kind isn't in scope (flow YAML)", () => {
    writePersona(dataRoot, "gardener", "scope:\n  writable_kinds: [page, wiki]");
    expect(() => assertWritableKind(ctx(dataRoot, "gardener"), "source")).toThrow(
      WritableKindsViolation,
    );
  });

  it("throws WritableKindsViolation for block-style YAML scope", () => {
    writePersona(dataRoot, "gardener-block", "scope:\n  writable_kinds:\n    - page\n    - wiki");
    expect(() => assertWritableKind(ctx(dataRoot, "gardener-block"), "source")).toThrow(
      WritableKindsViolation,
    );
  });

  it("the violation carries 403 status + agent + page-kind for clean error reporting", () => {
    writePersona(dataRoot, "ed", "scope:\n  writable_kinds: [page]");
    try {
      assertWritableKind(ctx(dataRoot, "ed"), "source");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WritableKindsViolation);
      const v = err as WritableKindsViolation;
      expect(v.status).toBe(403);
      expect(v.agentSlug).toBe("ed");
      expect(v.pageKind).toBe("source");
      expect(v.message).toContain("kind:source");
      expect(v.message).toContain("ed");
    }
  });

  it("permits when the page kind IS in writable_kinds", () => {
    writePersona(dataRoot, "gardener", "scope:\n  writable_kinds: [page, wiki]");
    expect(() => assertWritableKind(ctx(dataRoot, "gardener"), "wiki")).not.toThrow();
    expect(() => assertWritableKind(ctx(dataRoot, "gardener"), "page")).not.toThrow();
  });

  it("throws when writable_kinds is explicitly empty (deny-all)", () => {
    writePersona(dataRoot, "readonly", "scope:\n  writable_kinds: []");
    expect(() => assertWritableKind(ctx(dataRoot, "readonly"), "page")).toThrow(
      WritableKindsViolation,
    );
  });

  it("ignores unknown kinds in writable_kinds (defensive against typos)", () => {
    // `garbage` isn't a valid kind; the parser drops it. With only a
    // bogus entry, the effective scope is empty → deny all.
    writePersona(dataRoot, "typo", "scope:\n  writable_kinds: [garbage]");
    expect(() => assertWritableKind(ctx(dataRoot, "typo"), "page")).toThrow(WritableKindsViolation);
  });
});
