import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isDefaultAcl, loadEffectiveAcl } from "../acl.js";
import { StorageWriter } from "../storage-writer.js";
import { checkToolAcl, checkToolAclForCreate, filterReadableForTool } from "./acl-gate.js";
import type { ToolCallContext } from "./types.js";

/**
 * Tool ACL gate tests — Phase-9 multi-user.
 *
 * Three contracts to pin:
 *   1. Single-user runs (`ctx.acl` absent) permit everything.
 *   2. Multi-user runs honour the page's ACL with ancestor `index.md`
 *      inheritance.
 *   3. `kb.search` / `kb.global_search` filter results by read ACL.
 *
 * Uses a real `StorageWriter` against a temp dir so the gate's
 * `writer.read` path exercises the same code the production tools see.
 */

function makeTmpProject(): string {
  const dir = join(tmpdir(), `acl-gate-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, ".ironlore", "wal"), { recursive: true });
  mkdirSync(join(dir, ".ironlore", "locks"), { recursive: true });
  return dir;
}

function writePage(dataDir: string, relPath: string, body: string): void {
  const abs = join(dataDir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf-8");
}

function buildCtx(acl?: { userId: string; username: string }): ToolCallContext {
  return {
    projectId: "main",
    agentSlug: "test",
    jobId: "j-1",
    emitEvent: () => {},
    dataRoot: "",
    fetch: () => Promise.resolve(new Response()),
    ...(acl ? { acl } : {}),
  };
}

describe("checkToolAcl — single-user (no ctx.acl)", () => {
  let projectDir: string;
  let writer: StorageWriter;

  beforeEach(() => {
    projectDir = makeTmpProject();
    writer = new StorageWriter(projectDir);
  });

  afterEach(() => {
    writer.close();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("permits read on a page even when its ACL would deny", () => {
    writePage(
      join(projectDir, "data"),
      "secret.md",
      `---\nowner: alice\nacl:\n  read: [alice]\n  write: [alice]\n---\n\n# Secret\n`,
    );
    const result = checkToolAcl(buildCtx(), writer, "secret.md", "read");
    expect(result.ok).toBe(true);
  });

  it("permits write the same way", () => {
    writePage(
      join(projectDir, "data"),
      "page.md",
      `---\nowner: alice\nacl:\n  write: [alice]\n---\n\n# Page\n`,
    );
    const result = checkToolAcl(buildCtx(), writer, "page.md", "write");
    expect(result.ok).toBe(true);
  });
});

describe("checkToolAcl — multi-user", () => {
  let projectDir: string;
  let writer: StorageWriter;
  const alice = { userId: "alice-id", username: "alice" };
  const bob = { userId: "bob-id", username: "bob" };

  beforeEach(() => {
    projectDir = makeTmpProject();
    writer = new StorageWriter(projectDir);
  });

  afterEach(() => {
    writer.close();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("permits a page on the read allow-list", () => {
    writePage(
      join(projectDir, "data"),
      "shared.md",
      `---\nowner: alice-id\nacl:\n  read: [alice, bob]\n---\n\n# Shared\n`,
    );
    expect(checkToolAcl(buildCtx(alice), writer, "shared.md", "read").ok).toBe(true);
    expect(checkToolAcl(buildCtx(bob), writer, "shared.md", "read").ok).toBe(true);
  });

  it("denies a user not on the read allow-list with a 403 envelope", () => {
    writePage(
      join(projectDir, "data"),
      "secret.md",
      `---\nowner: alice-id\nacl:\n  read: [alice]\n---\n\n# Secret\n`,
    );
    const result = checkToolAcl(buildCtx(bob), writer, "secret.md", "read");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.envelope.status).toBe(403);
      expect(result.envelope.op).toBe("read");
      expect(result.envelope.error).toContain("bob");
    }
  });

  it("write-default = owner-only — non-owner is denied", () => {
    // No `acl:` block → write defaults to owner-only.
    writePage(join(projectDir, "data"), "alice-page.md", `---\nowner: alice-id\n---\n\n# Page\n`);
    expect(checkToolAcl(buildCtx(alice), writer, "alice-page.md", "write").ok).toBe(true);
    expect(checkToolAcl(buildCtx(bob), writer, "alice-page.md", "write").ok).toBe(false);
  });

  it("ENOENT permits — the calling tool surfaces its own 404", () => {
    const result = checkToolAcl(buildCtx(alice), writer, "missing.md", "read");
    expect(result.ok).toBe(true);
  });

  it("inherits ACL from an ancestor index.md when the target has no ACL", () => {
    // /team/index.md restricts to alice; /team/notes.md has no ACL.
    writePage(
      join(projectDir, "data"),
      "team/index.md",
      `---\nowner: alice-id\nacl:\n  read: [alice]\n---\n\n# Team Index\n`,
    );
    writePage(join(projectDir, "data"), "team/notes.md", "# Notes\n\nNo frontmatter ACL.\n");

    expect(checkToolAcl(buildCtx(alice), writer, "team/notes.md", "read").ok).toBe(true);
    expect(checkToolAcl(buildCtx(bob), writer, "team/notes.md", "read").ok).toBe(false);
  });

  it("a page's own ACL wins over an ancestor index.md", () => {
    writePage(
      join(projectDir, "data"),
      "team/index.md",
      `---\nowner: alice-id\nacl:\n  read: [alice]\n---\n\n# Team\n`,
    );
    // Page declares its own ACL — bob is allowed even though the
    //  ancestor would deny.
    writePage(
      join(projectDir, "data"),
      "team/public.md",
      `---\nowner: alice-id\nacl:\n  read: [everyone]\n---\n\n# Public\n`,
    );
    expect(checkToolAcl(buildCtx(bob), writer, "team/public.md", "read").ok).toBe(true);
  });

  it("walks past one ancestor without ACL to find the next one that has one", () => {
    // /team/index.md — no ACL
    writePage(join(projectDir, "data"), "team/index.md", "# Team\n");
    // /team/private/index.md — restricts to alice
    writePage(
      join(projectDir, "data"),
      "team/private/index.md",
      `---\nowner: alice-id\nacl:\n  read: [alice]\n---\n\n# Private\n`,
    );
    // /team/private/note.md — no ACL → inherits from /team/private/index.md
    writePage(join(projectDir, "data"), "team/private/note.md", "# Note\n");

    expect(checkToolAcl(buildCtx(alice), writer, "team/private/note.md", "read").ok).toBe(true);
    expect(checkToolAcl(buildCtx(bob), writer, "team/private/note.md", "read").ok).toBe(false);
  });
});

describe("checkToolAclForCreate", () => {
  let projectDir: string;
  let writer: StorageWriter;
  const alice = { userId: "alice-id", username: "alice" };
  const bob = { userId: "bob-id", username: "bob" };

  beforeEach(() => {
    projectDir = makeTmpProject();
    writer = new StorageWriter(projectDir);
  });

  afterEach(() => {
    writer.close();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("permits create when no ancestor declares an ACL", () => {
    expect(checkToolAclForCreate(buildCtx(alice), writer, "wiki").ok).toBe(true);
    expect(checkToolAclForCreate(buildCtx(bob), writer, "wiki").ok).toBe(true);
  });

  it("permits the user on the ancestor write list", () => {
    writePage(
      join(projectDir, "data"),
      "team/index.md",
      `---\nowner: alice-id\nacl:\n  write: [alice]\n---\n\n# Team\n`,
    );
    expect(checkToolAclForCreate(buildCtx(alice), writer, "team").ok).toBe(true);
  });

  it("denies a user not on the ancestor write list with a 403 envelope", () => {
    writePage(
      join(projectDir, "data"),
      "team/index.md",
      `---\nowner: alice-id\nacl:\n  write: [alice]\n---\n\n# Team\n`,
    );
    const result = checkToolAclForCreate(buildCtx(bob), writer, "team");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.envelope.status).toBe(403);
      expect(result.envelope.error).toContain("create");
    }
  });

  it("permits in single-user mode regardless of ancestor", () => {
    writePage(
      join(projectDir, "data"),
      "team/index.md",
      `---\nowner: alice-id\nacl:\n  write: [alice]\n---\n\n# Team\n`,
    );
    expect(checkToolAclForCreate(buildCtx(), writer, "team").ok).toBe(true);
  });
});

describe("filterReadableForTool", () => {
  let projectDir: string;
  let writer: StorageWriter;
  const alice = { userId: "alice-id", username: "alice" };
  const bob = { userId: "bob-id", username: "bob" };

  beforeEach(() => {
    projectDir = makeTmpProject();
    writer = new StorageWriter(projectDir);
    writePage(join(projectDir, "data"), "public.md", "# Public\n");
    writePage(
      join(projectDir, "data"),
      "alice-only.md",
      `---\nowner: alice-id\nacl:\n  read: [alice]\n---\n\n# Alice's\n`,
    );
    writePage(
      join(projectDir, "data"),
      "shared.md",
      `---\nowner: alice-id\nacl:\n  read: [alice, bob]\n---\n\n# Shared\n`,
    );
  });

  afterEach(() => {
    writer.close();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("returns all hits in single-user mode", () => {
    const hits = [
      { path: "public.md", title: "Public" },
      { path: "alice-only.md", title: "Alice's" },
      { path: "shared.md", title: "Shared" },
    ];
    expect(filterReadableForTool(buildCtx(), writer, hits)).toHaveLength(3);
  });

  it("filters out pages bob can't read", () => {
    const hits = [
      { path: "public.md", title: "Public" },
      { path: "alice-only.md", title: "Alice's" },
      { path: "shared.md", title: "Shared" },
    ];
    const out = filterReadableForTool(buildCtx(bob), writer, hits);
    expect(out.map((h) => h.path).sort()).toEqual(["public.md", "shared.md"]);
  });

  it("alice sees everything she has on the allow-list", () => {
    const hits = [
      { path: "public.md", title: "Public" },
      { path: "alice-only.md", title: "Alice's" },
      { path: "shared.md", title: "Shared" },
    ];
    expect(filterReadableForTool(buildCtx(alice), writer, hits)).toHaveLength(3);
  });
});

describe("loadEffectiveAcl + isDefaultAcl — direct unit", () => {
  it("isDefaultAcl is true only when every field is null/empty", () => {
    expect(isDefaultAcl({ owner: null, read: null, write: null })).toBe(true);
    expect(isDefaultAcl({ owner: "alice", read: null, write: null })).toBe(false);
    expect(isDefaultAcl({ owner: null, read: ["alice"], write: null })).toBe(false);
    expect(isDefaultAcl({ owner: null, read: null, write: ["alice"] })).toBe(false);
  });

  it("loadEffectiveAcl returns the page's own ACL when non-default", () => {
    const reader = (p: string): string | null =>
      p === "page.md" ? `---\nowner: alice-id\nacl:\n  read: [alice]\n---\n\n# Page\n` : null;
    const acl = loadEffectiveAcl("page.md", reader);
    expect(acl.owner).toBe("alice-id");
    expect(acl.read).toEqual(["alice"]);
  });

  it("loadEffectiveAcl walks ancestors when the page's ACL is default", () => {
    const reader = (p: string): string | null => {
      if (p === "team/private/note.md") return "# Note\n";
      if (p === "team/private/index.md")
        return `---\nowner: alice-id\nacl:\n  read: [alice]\n---\n`;
      return null;
    };
    const acl = loadEffectiveAcl("team/private/note.md", reader);
    expect(acl.read).toEqual(["alice"]);
  });

  it("loadEffectiveAcl asking from an index.md doesn't recurse into itself", () => {
    // /team/index.md asking for its own effective ACL should return its own.
    const reader = (p: string): string | null =>
      p === "team/index.md" ? `---\nowner: alice-id\nacl:\n  read: [alice]\n---\n` : null;
    const acl = loadEffectiveAcl("team/index.md", reader);
    expect(acl.read).toEqual(["alice"]);
  });
});
