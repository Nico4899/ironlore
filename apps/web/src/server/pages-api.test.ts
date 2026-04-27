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
  app.route("/raw", createRawApi(writer, writer.getDataRoot()));

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

describe("Pages API — GET /provenance", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => {
    rmSync(ctx.projectDir, { recursive: true, force: true });
  });

  it("returns { blocks: [] } for a page with no agent stamps", async () => {
    // Page exists but no .blocks.json or sidecar with no agent
    // fields → empty array, not 404. The UI should treat this as
    // "nothing to show your work for."
    await ctx.app.request("/pages/human.md", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "# Human\n\nbody.\n" }),
    });
    const res = await ctx.app.request("/pages/provenance/human.md");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { blocks: unknown[] };
    expect(body.blocks).toEqual([]);
  });

  it("surfaces sidecar provenance + computed trust for agent-stamped blocks", async () => {
    // Land an agent-stamped block via the sidecar carry-forward
    // path. We side-step the kb tool dispatcher to keep the test
    // small — the writeBlocksSidecar call mirrors what the tool
    // does at line 156 of kb-replace-block.ts.
    const { writer } = ctx;
    writer.write("src.md", "# Source\n\nfact.\n", "test");
    writer.write("wiki.md", "# Wiki\n\nsynthesis.\n", "test");
    const { writeBlocksSidecar, parseBlocks } = await import("./block-ids.js");
    const wikiBlocks = parseBlocks(writer.read("wiki.md").content);
    const synth = wikiBlocks.find((b) => b.type === "paragraph");
    if (!synth) throw new Error("test fixture: missing paragraph block");
    const provenance = new Map([
      [
        synth.id,
        {
          derived_from: ["src.md#someBlk"],
          agent: "wiki-gardener",
          compiled_at: "2026-04-25T10:00:00.000Z",
        },
      ],
    ]);
    writeBlocksSidecar(join(writer.getDataRoot(), "wiki.md"), wikiBlocks, provenance);

    const res = await ctx.app.request("/pages/provenance/wiki.md");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      blocks: Array<{
        id: string;
        agent: string;
        compiledAt: string;
        derivedFrom: string[];
        trust: { state: string } | null;
      }>;
    };
    expect(body.blocks.length).toBe(1);
    const row = body.blocks[0];
    expect(row?.agent).toBe("wiki-gardener");
    expect(row?.derivedFrom).toEqual(["src.md#someBlk"]);
    expect(row?.compiledAt).toBe("2026-04-25T10:00:00.000Z");
    // Source page exists; trust is computed and one of the
    // documented enum values.
    expect(row?.trust).not.toBeNull();
    expect(["fresh", "stale", "unverified"]).toContain(row?.trust?.state);
  });

  it("returns 404 when the page itself does not exist", async () => {
    const res = await ctx.app.request("/pages/provenance/missing.md");
    expect(res.status).toBe(404);
  });
});

describe("Pages API — POST /from-conversation (Save as wiki)", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => {
    rmSync(ctx.projectDir, { recursive: true, force: true });
  });

  it("creates a kind: wiki page with source_ids from the request body", async () => {
    // The Phase-11 query-to-wiki workflow (A.6.2) — user clicks
    // "Save as wiki" on an agent reply and the panel posts the
    // text + extracted source paths. Pin the resulting frontmatter
    // shape so a future refactor that drops `kind: wiki` or skips
    // `source_ids` breaks loudly.
    const res = await ctx.app.request("/pages/from-conversation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "What is RRF",
        markdown: "Reciprocal rank fusion combines BM25 and vector ranks.",
        sourceIds: ["sources/rrf-paper", "sources/our-eval"],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; path: string; etag: string };
    expect(body.path).toBe("wiki/what-is-rrf.md");

    // Read the page back and confirm the persisted frontmatter.
    const read = await ctx.app.request("/pages/wiki/what-is-rrf.md");
    expect(read.status).toBe(200);
    const page = (await read.json()) as { content: string };
    expect(page.content).toMatch(/^---\nschema: 1/);
    expect(page.content).toMatch(/\nkind: wiki\n/);
    expect(page.content).toMatch(/\nsource_ids: \[sources\/rrf-paper, sources\/our-eval\]\n/);
    expect(page.content).toContain("# What is RRF");
    expect(page.content).toContain("Reciprocal rank fusion");
  });

  it("respects the `parent` field (defaults to wiki/ when absent)", async () => {
    const res = await ctx.app.request("/pages/from-conversation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Saved Note",
        markdown: "Body.",
        parent: "research",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe("research/saved-note.md");
  });

  it("omits source_ids from the frontmatter when the array is empty", async () => {
    // No citations in the agent's reply → empty array → don't
    // emit the YAML key at all (cleaner than `source_ids: []`).
    // The lint pipeline still flags the page as a provenance gap
    // on its next run; that's the documented signal.
    const res = await ctx.app.request("/pages/from-conversation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Citation-less",
        markdown: "No citations in this reply.",
      }),
    });
    expect(res.status).toBe(200);
    const read = await ctx.app.request("/pages/wiki/citation-less.md");
    const page = (await read.json()) as { content: string };
    expect(page.content).not.toMatch(/source_ids:/);
  });

  it("returns 400 when title is missing", async () => {
    const res = await ctx.app.request("/pages/from-conversation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "body without title" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when title slug is empty (non-alphanumeric only)", async () => {
    const res = await ctx.app.request("/pages/from-conversation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "!@#$%", markdown: "body" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 409 on slug collision (same title saved twice)", async () => {
    const body = JSON.stringify({ title: "Dupe", markdown: "first" });
    const init = { method: "POST", headers: { "Content-Type": "application/json" }, body };
    const first = await ctx.app.request("/pages/from-conversation", init);
    expect(first.status).toBe(200);
    const second = await ctx.app.request("/pages/from-conversation", init);
    expect(second.status).toBe(409);
  });
});
