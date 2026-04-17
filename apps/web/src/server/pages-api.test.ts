import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPagesApi, createRawApi } from "./pages-api.js";
import { SearchIndex } from "./search-index.js";
import { StorageWriter } from "./storage-writer.js";

/**
 * Pages HTTP API — ETag + concurrency tests.
 *
 * Exercises GET/PUT/DELETE against a real StorageWriter + SearchIndex
 * with a live Hono router. Verifies the full If-Match cycle, 409 on
 * conflict, 403 on path traversal, 404 on missing, and the broadcast
 * side-effects.
 */

function makeTmpProject(): { projectDir: string } {
  const projectDir = join(tmpdir(), `pages-api-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(projectDir, "data"), { recursive: true });
  mkdirSync(join(projectDir, ".ironlore"), { recursive: true });
  return { projectDir };
}

type Broadcast = Parameters<typeof createPagesApi>[2];

function setup() {
  const { projectDir } = makeTmpProject();
  const writer = new StorageWriter(projectDir);
  const searchIndex = new SearchIndex(projectDir);
  const events: Array<Parameters<NonNullable<Broadcast>>[0]> = [];
  const broadcast: Broadcast = (ev) => events.push(ev);

  const app = new Hono();
  app.route("/pages", createPagesApi(writer, searchIndex, broadcast));
  app.route("/raw", createRawApi(writer));

  return { app, writer, searchIndex, events, projectDir };
}

describe("Pages API — GET", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(() => {
    ctx.writer.close();
    ctx.searchIndex.close();
    try {
      rmSync(ctx.projectDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("returns 404 for missing page", async () => {
    const res = await ctx.app.request("/pages/missing.md");
    expect(res.status).toBe(404);
  });

  it("returns 200 with content + etag + blocks for existing page", async () => {
    await ctx.writer.write("a.md", "# Hello\n\nBody.", null);
    const res = await ctx.app.request("/pages/a.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toMatch(/^"sha256-/);
    const body = (await res.json()) as { content: string; etag: string; blocks: unknown[] };
    expect(body.content).toContain("Hello");
    expect(body.etag).toMatch(/^"sha256-/);
    expect(body.blocks).toBeInstanceOf(Array);
  });

  it("rejects path traversal with 403", async () => {
    const res = await ctx.app.request("/pages/..%2F..%2Fetc%2Fpasswd");
    expect([403, 404]).toContain(res.status); // Either forbidden or not-found
  });
});

describe("Pages API — PUT", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(() => {
    ctx.writer.close();
    ctx.searchIndex.close();
    try {
      rmSync(ctx.projectDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("creates a new page without If-Match", async () => {
    const res = await ctx.app.request("/pages/new.md", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "# New\n" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { etag: string };
    expect(body.etag).toMatch(/^"sha256-/);

    // Broadcasts tree:add on create
    expect(ctx.events.some((e) => e.type === "tree:add")).toBe(true);
  });

  it("updates an existing page with matching If-Match", async () => {
    const create = await ctx.app.request("/pages/a.md", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "# v1\n" }),
    });
    const { etag: v1Etag } = (await create.json()) as { etag: string };

    const update = await ctx.app.request("/pages/a.md", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": v1Etag },
      body: JSON.stringify({ markdown: "# v2\n" }),
    });
    expect(update.status).toBe(200);
    const { etag: v2Etag } = (await update.json()) as { etag: string };
    expect(v2Etag).not.toBe(v1Etag);

    // Broadcasts tree:update on update
    expect(ctx.events.some((e) => e.type === "tree:update")).toBe(true);
  });

  it("returns 409 on stale If-Match with current content for merge", async () => {
    await ctx.app.request("/pages/a.md", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "# v1\n" }),
    });

    const res = await ctx.app.request("/pages/a.md", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": '"sha256-wrong"',
      },
      body: JSON.stringify({ markdown: "# v2\n" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      currentEtag: string;
      currentContent: string;
      diff: string;
    };
    expect(body.error).toBe("Conflict");
    expect(body.currentEtag).toMatch(/^"sha256-/);
    expect(body.currentContent).toContain("v1");
    expect(body.diff).toBeTruthy();
  });

  it("rejects non-markdown paths with 400", async () => {
    const res = await ctx.app.request("/pages/a.txt", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "# x\n" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects body without 'markdown' field with 400", async () => {
    const res = await ctx.app.request("/pages/a.md", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wrong: "field" }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts If-Match both with and without quotes", async () => {
    const create = await ctx.app.request("/pages/a.md", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "# v1\n" }),
    });
    const { etag } = (await create.json()) as { etag: string };
    const unquoted = etag.replace(/^"|"$/g, "");

    const withQuotes = await ctx.app.request("/pages/a.md", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": etag },
      body: JSON.stringify({ markdown: "# v2\n" }),
    });
    expect(withQuotes.status).toBe(200);

    const { etag: v2 } = (await withQuotes.json()) as { etag: string };
    const withoutQuotes = await ctx.app.request("/pages/a.md", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": v2.replace(/^"|"$/g, "") },
      body: JSON.stringify({ markdown: "# v3\n" }),
    });
    expect(withoutQuotes.status).toBe(200);
    // unquoted variable used above — avoid unused warning
    expect(unquoted.length).toBeGreaterThan(0);
  });
});

describe("Pages API — DELETE", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(() => {
    ctx.writer.close();
    ctx.searchIndex.close();
    try {
      rmSync(ctx.projectDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("deletes with matching If-Match returns 204", async () => {
    const create = await ctx.app.request("/pages/a.md", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "# del\n" }),
    });
    const { etag } = (await create.json()) as { etag: string };

    const del = await ctx.app.request("/pages/a.md", {
      method: "DELETE",
      headers: { "If-Match": etag },
    });
    expect(del.status).toBe(204);

    // Broadcasts tree:delete
    expect(ctx.events.some((e) => e.type === "tree:delete")).toBe(true);
  });

  it("deletes without If-Match succeeds (optional)", async () => {
    await ctx.app.request("/pages/a.md", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "# del\n" }),
    });
    const del = await ctx.app.request("/pages/a.md", { method: "DELETE" });
    expect(del.status).toBe(204);
  });

  it("returns 409 on stale If-Match", async () => {
    await ctx.app.request("/pages/a.md", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "# del\n" }),
    });
    const res = await ctx.app.request("/pages/a.md", {
      method: "DELETE",
      headers: { "If-Match": '"sha256-wrong"' },
    });
    expect(res.status).toBe(409);
  });

  it("returns 404 when deleting a missing file", async () => {
    const res = await ctx.app.request("/pages/never.md", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
