import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPagesApi } from "./pages-api.js";
import { SearchIndex } from "./search-index.js";
import { StorageWriter } from "./storage-writer.js";

/**
 * Multi-user pages-api integration. Exercises ACL enforcement on
 * the read/write/delete paths against a real StorageWriter +
 * SearchIndex. Single-user mode is covered by `pages-api.test.ts`;
 * this file only adds the ACL-aware branch.
 *
 * Spec source: docs/08-projects-and-isolation.md §Multi-user mode
 * and per-page ACLs. The "Done when" criterion for that bullet
 * lives or dies on these tests passing.
 */

function makeTmpProject(): { projectDir: string } {
  const projectDir = join(tmpdir(), `pages-api-mu-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(projectDir, "data"), { recursive: true });
  mkdirSync(join(projectDir, ".ironlore"), { recursive: true });
  return { projectDir };
}

interface Setup {
  app: Hono;
  writer: StorageWriter;
  searchIndex: SearchIndex;
  projectDir: string;
}

/**
 * Build a Hono app that mimics what `createPagesApi` would see in
 * production: a fake auth middleware sets `userId` + `username` on
 * the context before the pages routes mount. Each request sends a
 * `X-Test-User` header that the middleware reads — that's the
 * shortest path to "two distinct users hitting the same install."
 */
function setup(mode: "single-user" | "multi-user" = "multi-user"): Setup {
  const { projectDir } = makeTmpProject();
  const writer = new StorageWriter(projectDir);
  const searchIndex = new SearchIndex(projectDir);

  const app = new Hono();

  // Test-only auth shim. The real middleware in `auth.ts` sets the
  // same two keys; we shortcut so the test can swap users by header.
  app.use("/pages/*", async (c, next) => {
    const username = c.req.header("X-Test-User") ?? "alice";
    const userId = `${username}-uid`;
    c.set("userId", userId);
    c.set("username", username);
    await next();
  });
  app.route("/pages", createPagesApi(writer, searchIndex, undefined, { mode }));

  return { app, writer, searchIndex, projectDir };
}

function teardown(s: Setup): void {
  s.writer.close();
  s.searchIndex.close();
  try {
    rmSync(s.projectDir, { recursive: true, force: true });
  } catch {
    /* */
  }
}

async function put(
  app: Hono,
  user: string,
  path: string,
  markdown: string,
  ifMatch?: string,
): Promise<Response> {
  return app.request(`/pages/${path}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Test-User": user,
      ...(ifMatch ? { "If-Match": ifMatch } : {}),
    },
    body: JSON.stringify({ markdown }),
  });
}

async function get(app: Hono, user: string, path: string): Promise<Response> {
  return app.request(`/pages/${path}`, {
    headers: { "X-Test-User": user },
  });
}

async function del(
  app: Hono,
  user: string,
  path: string,
  ifMatch?: string,
): Promise<Response> {
  return app.request(`/pages/${path}`, {
    method: "DELETE",
    headers: {
      "X-Test-User": user,
      ...(ifMatch ? { "If-Match": ifMatch } : {}),
    },
  });
}

describe("multi-user pages-api — ACL enforcement", () => {
  let s: Setup;

  beforeEach(() => {
    s = setup();
  });
  afterEach(() => {
    teardown(s);
  });

  it("default page (no acl: frontmatter) is readable by everyone", async () => {
    // Alice creates a page. Bob reads it. Default ACL is
    // `read: everyone, write: owner` so Bob can read but not
    // write — verified in the next test.
    const md = "---\nid: x\ntitle: T\n---\n\nbody\n";
    const r1 = await put(s.app, "alice", "a.md", md);
    expect(r1.status).toBe(200);

    const r2 = await get(s.app, "bob", "a.md");
    expect(r2.status).toBe(200);
    const body = (await r2.json()) as { content: string };
    expect(body.content).toContain("body");
  });

  it("default write ACL is owner-only — second user can't overwrite", async () => {
    await put(s.app, "alice", "a.md", "---\nid: x\n---\n\nv1\n");
    // Bob reads to discover the etag, then attempts to overwrite.
    const r1 = await get(s.app, "bob", "a.md");
    const etag = r1.headers.get("ETag") ?? "";
    const r2 = await put(s.app, "bob", "a.md", "---\nid: x\n---\n\nbob was here\n", etag);
    expect(r2.status).toBe(403);
  });

  it("explicit `read: [alice]` blocks bob from reading", async () => {
    const md = [
      "---",
      "id: x",
      "owner: alice-uid",
      "acl:",
      "  read: [alice]",
      "  write: [alice]",
      "---",
      "",
      "secret",
      "",
    ].join("\n");
    await put(s.app, "alice", "secret.md", md);

    const bobRes = await get(s.app, "bob", "secret.md");
    expect(bobRes.status).toBe(403);

    const aliceRes = await get(s.app, "alice", "secret.md");
    expect(aliceRes.status).toBe(200);
  });

  it("`read: [everyone]` lets bob read even when write is restricted", async () => {
    const md = [
      "---",
      "id: x",
      "owner: alice-uid",
      "acl:",
      "  read: [everyone]",
      "  write: [alice]",
      "---",
      "",
      "public",
      "",
    ].join("\n");
    await put(s.app, "alice", "doc.md", md);
    const bobRes = await get(s.app, "bob", "doc.md");
    expect(bobRes.status).toBe(200);
  });

  it("`write: [alice, bob]` lets bob successfully overwrite", async () => {
    const md = [
      "---",
      "id: x",
      "owner: alice-uid",
      "acl:",
      "  read: [everyone]",
      "  write: [alice, bob]",
      "---",
      "",
      "v1",
      "",
    ].join("\n");
    await put(s.app, "alice", "shared.md", md);

    const r1 = await get(s.app, "bob", "shared.md");
    const etag = r1.headers.get("ETag") ?? "";
    const r2 = await put(s.app, "bob", "shared.md", `${md}bob's edit\n`, etag);
    expect(r2.status).toBe(200);
  });

  it("delete is gated by write ACL", async () => {
    const md = [
      "---",
      "id: x",
      "owner: alice-uid",
      "acl:",
      "  read: [everyone]",
      "  write: [alice]",
      "---",
      "",
      "body",
      "",
    ].join("\n");
    await put(s.app, "alice", "doc.md", md);

    const bobDel = await del(s.app, "bob", "doc.md");
    expect(bobDel.status).toBe(403);

    const aliceDel = await del(s.app, "alice", "doc.md");
    expect(aliceDel.status).toBe(204);
  });

  it("first PUT stamps the calling user as `owner` in frontmatter", async () => {
    // Bob creates a fresh page. The pipeline should stamp
    // `owner: bob-uid` automatically so subsequent ACL checks
    // resolve `owner` against bob.
    const md = "---\nid: x\ntitle: T\n---\n\nbody\n";
    await put(s.app, "bob", "bob-page.md", md);
    const r = await get(s.app, "bob", "bob-page.md");
    const body = (await r.json()) as { content: string };
    expect(body.content).toContain("owner: bob-uid");

    // Alice can read (default), can't write (default = owner only).
    const aliceWrite = await put(
      s.app,
      "alice",
      "bob-page.md",
      `${body.content}alice was here\n`,
      r.headers.get("ETag") ?? "",
    );
    expect(aliceWrite.status).toBe(403);
  });

  it("an existing `owner:` is not hijacked by a later write", async () => {
    // Alice owns the page. We grant write to Bob. Bob writes.
    // The `owner:` field must still be alice — stampOwner is a
    // no-op when owner is already set.
    const md = [
      "---",
      "id: x",
      "owner: alice-uid",
      "acl:",
      "  read: [everyone]",
      "  write: [alice, bob]",
      "---",
      "",
      "v1",
      "",
    ].join("\n");
    await put(s.app, "alice", "doc.md", md);

    const r1 = await get(s.app, "bob", "doc.md");
    const etag = r1.headers.get("ETag") ?? "";
    await put(s.app, "bob", "doc.md", `${(await r1.json() as { content: string }).content}bob edit\n`, etag);

    const final = await get(s.app, "alice", "doc.md");
    const body = (await final.json()) as { content: string };
    expect(body.content).toContain("owner: alice-uid");
    expect(body.content).not.toContain("owner: bob-uid");
  });
});

describe("single-user pages-api — ACL is a no-op (regression)", () => {
  let s: Setup;

  beforeEach(() => {
    s = setup("single-user");
  });
  afterEach(() => {
    teardown(s);
  });

  it("any user can write even with restrictive frontmatter", async () => {
    // Single-user mode never parses ACL frontmatter; any
    // authenticated user passes. Locks in the spec's "single-user
    // installs are unchanged" guarantee.
    const md = [
      "---",
      "id: x",
      "owner: alice-uid",
      "acl:",
      "  read: [alice]",
      "  write: [alice]",
      "---",
      "",
      "secret",
      "",
    ].join("\n");
    await put(s.app, "alice", "doc.md", md);
    const bobRead = await get(s.app, "bob", "doc.md");
    expect(bobRead.status).toBe(200);
    const etag = bobRead.headers.get("ETag") ?? "";
    const bobWrite = await put(s.app, "bob", "doc.md", `${md}bob's edit\n`, etag);
    expect(bobWrite.status).toBe(200);
  });

  it("does not stamp `owner:` in single-user mode", async () => {
    // No identity to stamp, no value in adding a field nobody
    // reads — single-user mode skips the stampOwner pass.
    const md = "---\nid: x\ntitle: T\n---\n\nbody\n";
    await put(s.app, "bob", "page.md", md);
    const r = await get(s.app, "bob", "page.md");
    const body = (await r.json()) as { content: string };
    expect(body.content).not.toContain("owner:");
  });
});
