import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assignBlockIds } from "../block-ids.js";
import { SearchIndex } from "../search-index.js";
import { StorageWriter } from "../storage-writer.js";
import { ToolDispatcher } from "./dispatcher.js";
import { createKbCreatePage } from "./kb-create-page.js";
import { createKbDeleteBlock } from "./kb-delete-block.js";
import { createKbInsertAfter } from "./kb-insert-after.js";
import { createKbReadBlock } from "./kb-read-block.js";
import { createKbReadPage } from "./kb-read-page.js";
import { createKbReplaceBlock } from "./kb-replace-block.js";
import { createKbSearch } from "./kb-search.js";
import type { RunBudget, ToolCallContext } from "./types.js";

/**
 * Phase-9 multi-user — kb-tool ACL integration.
 *
 * The unit tests in `acl-gate.test.ts` cover the gate helper in
 * isolation. This file pushes calls through the actual dispatcher +
 * each tool's `execute` so the wiring matches what an agent run
 * sees.
 */

function makeTmpProject(): { projectDir: string; dataRoot: string } {
  const projectDir = join(tmpdir(), `kb-acl-test-${randomBytes(4).toString("hex")}`);
  const dataRoot = join(projectDir, "data");
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(join(projectDir, ".ironlore", "wal"), { recursive: true });
  mkdirSync(join(projectDir, ".ironlore", "locks"), { recursive: true });
  return { projectDir, dataRoot };
}

function writePage(dataDir: string, relPath: string, body: string): void {
  const abs = join(dataDir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf-8");
}

function makeCtx(dataRoot: string, acl?: { userId: string; username: string }): ToolCallContext {
  return {
    projectId: "main",
    agentSlug: "editor",
    jobId: "j-test",
    emitEvent: () => {},
    dataRoot,
    fetch: globalThis.fetch,
    ...(acl ? { acl } : {}),
  };
}

function makeBudget(): RunBudget {
  return { maxTokens: 100_000, maxToolCalls: 50, usedTokens: 0, usedToolCalls: 0 };
}

describe("kb tools + multi-user ACL gate", () => {
  let projectDir: string;
  let dataRoot: string;
  let writer: StorageWriter;
  let index: SearchIndex;
  let dispatcher: ToolDispatcher;

  const alice = { userId: "alice-id", username: "alice" };
  const bob = { userId: "bob-id", username: "bob" };

  beforeEach(() => {
    const tmp = makeTmpProject();
    projectDir = tmp.projectDir;
    dataRoot = tmp.dataRoot;
    writer = new StorageWriter(projectDir);
    index = new SearchIndex(projectDir);
    dispatcher = new ToolDispatcher();
    dispatcher.register(createKbReadPage(writer));
    dispatcher.register(createKbReadBlock(writer));
    dispatcher.register(createKbReplaceBlock(writer, index));
    dispatcher.register(createKbInsertAfter(writer, index));
    dispatcher.register(createKbDeleteBlock(writer, index));
    dispatcher.register(createKbCreatePage(writer, index));
    dispatcher.register(createKbSearch(index, writer));
  });

  afterEach(() => {
    writer.close();
    index.close();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("kb.read_page denies bob a 403 envelope on alice-only page", async () => {
    writePage(
      dataRoot,
      "secret.md",
      `---\nowner: alice-id\nacl:\n  read: [alice]\n---\n\n# Secret\n`,
    );

    const result = await dispatcher.call(
      "kb.read_page",
      { path: "secret.md" },
      makeCtx(dataRoot, bob),
      makeBudget(),
    );
    expect(result.isError).toBe(true);
    const env = JSON.parse(result.result);
    expect(env.status).toBe(403);
    expect(env.op).toBe("read");
  });

  it("kb.read_page permits alice on the same page", async () => {
    writePage(
      dataRoot,
      "secret.md",
      `---\nowner: alice-id\nacl:\n  read: [alice]\n---\n\n# Secret\n`,
    );

    const result = await dispatcher.call(
      "kb.read_page",
      { path: "secret.md" },
      makeCtx(dataRoot, alice),
      makeBudget(),
    );
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.result);
    expect(data.content).toContain("# Secret");
  });

  it("kb.read_page permits bob in single-user mode (no ctx.acl)", async () => {
    writePage(
      dataRoot,
      "secret.md",
      `---\nowner: alice-id\nacl:\n  read: [alice]\n---\n\n# Secret\n`,
    );

    const result = await dispatcher.call(
      "kb.read_page",
      { path: "secret.md" },
      makeCtx(dataRoot),
      makeBudget(),
    );
    expect(result.isError).toBe(false);
  });

  it("kb.replace_block denies bob a 403 envelope on alice's page", async () => {
    const { markdown: ann } = assignBlockIds(
      `---\nowner: alice-id\nacl:\n  write: [alice]\n---\n\n# Page\n\nOriginal.\n`,
    );
    await writer.write("alice.md", ann, null);

    // Read first as alice to get a valid ETag + block ID.
    const readAsAlice = await dispatcher.call(
      "kb.read_page",
      { path: "alice.md" },
      makeCtx(dataRoot, alice),
      makeBudget(),
    );
    const data = JSON.parse(readAsAlice.result);
    const blockId = data.blocks.at(-1)?.id;
    expect(blockId).toBeDefined();

    // Bob tries to replace.
    const result = await dispatcher.call(
      "kb.replace_block",
      { path: "alice.md", blockId, markdown: "Hijacked.", etag: data.etag },
      makeCtx(dataRoot, bob),
      makeBudget(),
    );
    expect(result.isError).toBe(true);
    const env = JSON.parse(result.result);
    expect(env.status).toBe(403);
    expect(env.op).toBe("write");

    // Verify nothing landed on disk.
    const { content } = writer.read("alice.md");
    expect(content).toContain("Original.");
    expect(content).not.toContain("Hijacked.");
  });

  it("kb.create_page in a directory whose ancestor index.md restricts writes", async () => {
    writePage(
      dataRoot,
      "team/index.md",
      `---\nowner: alice-id\nacl:\n  write: [alice]\n---\n\n# Team\n`,
    );

    // Bob tries to create a page in /team/ — denied by ancestor ACL.
    const denied = await dispatcher.call(
      "kb.create_page",
      { parent: "team", title: "Bob's Page", markdown: "Body." },
      makeCtx(dataRoot, bob),
      makeBudget(),
    );
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.result).status).toBe(403);

    // Alice can create.
    const allowed = await dispatcher.call(
      "kb.create_page",
      { parent: "team", title: "Alice's Page", markdown: "Body." },
      makeCtx(dataRoot, alice),
      makeBudget(),
    );
    expect(allowed.isError).toBe(false);
    const created = JSON.parse(allowed.result);
    expect(created.ok).toBe(true);
    // First-write owner stamp landed on the new page.
    const onDisk = writer.read(created.path).content;
    expect(onDisk).toMatch(/^---\nowner: alice-id\n/);
  });

  it("kb.search filters out hits the calling user can't read", async () => {
    // Write three pages: public, alice-only, shared.
    const pubAnn = assignBlockIds("# Public\n\npublicword content.\n").markdown;
    await writer.write("public.md", pubAnn, null);
    index.indexPage("public.md", pubAnn, "user");

    const aliceAnn = assignBlockIds(
      `---\nowner: alice-id\nacl:\n  read: [alice]\n---\n\n# Alice's\n\npublicword content.\n`,
    ).markdown;
    await writer.write("alice-only.md", aliceAnn, null);
    index.indexPage("alice-only.md", aliceAnn, "user");

    const sharedAnn = assignBlockIds(
      `---\nowner: alice-id\nacl:\n  read: [alice, bob]\n---\n\n# Shared\n\npublicword content.\n`,
    ).markdown;
    await writer.write("shared.md", sharedAnn, null);
    index.indexPage("shared.md", sharedAnn, "user");

    const result = await dispatcher.call(
      "kb.search",
      { query: "publicword" },
      makeCtx(dataRoot, bob),
      makeBudget(),
    );
    expect(result.isError).toBe(false);
    const hits = JSON.parse(result.result) as Array<{ path: string }>;
    const paths = hits.map((h) => h.path).sort();
    // Bob doesn't see alice-only.md.
    expect(paths).not.toContain("alice-only.md");
    expect(paths).toContain("public.md");
    expect(paths).toContain("shared.md");
  });

  it("kb.search returns all hits in single-user mode", async () => {
    const aliceAnn = assignBlockIds(
      `---\nowner: alice-id\nacl:\n  read: [alice]\n---\n\n# Alice's\n\nmarker content.\n`,
    ).markdown;
    await writer.write("alice-only.md", aliceAnn, null);
    index.indexPage("alice-only.md", aliceAnn, "user");

    const result = await dispatcher.call(
      "kb.search",
      { query: "marker" },
      makeCtx(dataRoot),
      makeBudget(),
    );
    expect(result.isError).toBe(false);
    const hits = JSON.parse(result.result) as Array<{ path: string }>;
    expect(hits.map((h) => h.path)).toContain("alice-only.md");
  });
});
