import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeEtag } from "@ironlore/core/server";
import { afterEach, describe, expect, it } from "vitest";
import { assignBlockIds } from "../block-ids.js";
import { SearchIndex } from "../search-index.js";
import { StorageWriter } from "../storage-writer.js";
import { createAgentJournal } from "./agent-journal.js";
import { ToolDispatcher } from "./dispatcher.js";
import { createKbCreatePage } from "./kb-create-page.js";
import { createKbReadPage } from "./kb-read-page.js";
import { createKbReplaceBlock } from "./kb-replace-block.js";
import { createKbSearch } from "./kb-search.js";
import type { RunBudget, ToolCallContext } from "./types.js";

/**
 * Tier-1 tool-protocol tests.
 *
 * These exercise the exact scenarios from docs/04-ai-and-agents.md
 * §Tool protocol testing against the REAL StorageWriter + SearchIndex
 * (not mocks). The test asserts the tool's response so an agent
 * exercising the same loop would recover correctly.
 */

function makeTmpProject(): { projectDir: string; dataRoot: string } {
  const projectDir = join(tmpdir(), `ironlore-tools-${randomBytes(4).toString("hex")}`);
  const dataRoot = join(projectDir, "data");
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(join(projectDir, ".ironlore"), { recursive: true });
  return { projectDir, dataRoot };
}

function makeCtx(dataRoot: string): ToolCallContext {
  const events: Array<{ kind: string; data: unknown }> = [];
  return {
    projectId: "main",
    agentSlug: "editor",
    jobId: "test-job",
    emitEvent: (kind, data) => events.push({ kind, data }),
    dataRoot,
  };
}

function makeBudget(): RunBudget {
  return { maxTokens: 100_000, maxToolCalls: 50, usedTokens: 0, usedToolCalls: 0 };
}

describe("Tool dispatcher — Tier 1 protocol tests", () => {
  const writers: StorageWriter[] = [];
  const indexes: SearchIndex[] = [];

  afterEach(() => {
    for (const w of writers) w.close();
    for (const i of indexes) i.close();
    writers.length = 0;
    indexes.length = 0;
  });

  function setup() {
    const { projectDir, dataRoot } = makeTmpProject();
    const writer = new StorageWriter(projectDir);
    const index = new SearchIndex(projectDir);
    writers.push(writer);
    indexes.push(index);

    const dispatcher = new ToolDispatcher();
    dispatcher.register(createKbSearch(index));
    dispatcher.register(createKbReadPage(writer));
    dispatcher.register(createKbReplaceBlock(writer, index));
    dispatcher.register(createKbCreatePage(writer, index));
    dispatcher.register(createAgentJournal(dataRoot));

    const ctx = makeCtx(dataRoot);
    const budget = makeBudget();

    return { writer, index, dispatcher, ctx, budget, projectDir, dataRoot };
  }

  it("happy path: read → replace → verify", async () => {
    const { writer, dispatcher, ctx, budget } = setup();

    // Create a page with block IDs pre-assigned (in production the
    // pages-api PUT handler calls assignBlockIds; tests bypass that).
    const { markdown: annotated } = assignBlockIds("# Test\n\nOriginal content.\n");
    await writer.write("test.md", annotated, null);

    // Read it.
    const readResult = await dispatcher.call("kb.read_page", { path: "test.md" }, ctx, budget);
    expect(readResult.isError).toBe(false);
    const readData = JSON.parse(readResult.result);
    expect(readData.etag).toBeDefined();
    expect(readData.blocks.length).toBeGreaterThan(0);

    // Replace a block.
    const blockId = readData.blocks[1]?.id ?? readData.blocks[0]?.id;
    const replaceResult = await dispatcher.call(
      "kb.replace_block",
      { path: "test.md", blockId, markdown: "Updated content.", etag: readData.etag },
      ctx,
      budget,
    );
    expect(replaceResult.isError).toBe(false);
    const replaceData = JSON.parse(replaceResult.result);
    expect(replaceData.ok).toBe(true);
    expect(replaceData.newEtag).toBeDefined();

    // Verify the content changed.
    const { content } = writer.read("test.md");
    expect(content).toContain("Updated content.");
  });

  it("stale ETag returns 409-equivalent error", async () => {
    const { writer, dispatcher, ctx, budget } = setup();
    const { markdown: ann } = assignBlockIds("# Test\n\nOriginal.\n");
    await writer.write("test.md", ann, null);

    const staleEtag = computeEtag("something completely different");
    const result = await dispatcher.call(
      "kb.replace_block",
      { path: "test.md", blockId: "blk_FAKE", markdown: "new", etag: staleEtag },
      ctx,
      budget,
    );
    expect(result.isError).toBe(false); // Tool returns structured error, not throw
    const data = JSON.parse(result.result);
    expect(data.error).toContain("ETag mismatch");
    expect(data.currentEtag).toBeDefined();
  });

  it("hallucinated block ID returns 404-equivalent error", async () => {
    const { writer, dispatcher, ctx, budget } = setup();
    const { markdown: ann2 } = assignBlockIds("# Test\n\nBody.\n");
    await writer.write("test.md", ann2, null);
    const { etag } = writer.read("test.md");

    const result = await dispatcher.call(
      "kb.replace_block",
      { path: "test.md", blockId: "blk_NONEXISTENT00000000000", markdown: "new", etag },
      ctx,
      budget,
    );
    const data = JSON.parse(result.result);
    expect(data.error).toContain("not found");
    expect(data.availableBlocks).toBeDefined();
  });

  it("ENOENT path returns page-not-found error", async () => {
    const { dispatcher, ctx, budget } = setup();

    const result = await dispatcher.call(
      "kb.read_page",
      { path: "does-not-exist.md" },
      ctx,
      budget,
    );
    const data = JSON.parse(result.result);
    expect(data.error).toBe("Page not found");
  });

  it("budget exhaustion returns a budget-exhausted signal", async () => {
    const { dispatcher, ctx } = setup();
    const budget: RunBudget = {
      maxTokens: 100_000,
      maxToolCalls: 1,
      usedTokens: 0,
      usedToolCalls: 1,
    };

    const result = await dispatcher.call("kb.search", { query: "test" }, ctx, budget);
    expect(result.isError).toBe(true);
    expect(result.result).toContain("Budget exhausted");
  });

  it("kb.create_page creates a page and returns the ID", async () => {
    const { writer, dispatcher, ctx, budget } = setup();

    const result = await dispatcher.call(
      "kb.create_page",
      { parent: "", title: "New Page", markdown: "Some content.", kind: "wiki", tags: ["test"] },
      ctx,
      budget,
    );
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.result);
    expect(data.ok).toBe(true);
    expect(data.id).toBeDefined();
    expect(data.path).toMatch(/new-page\.md$/);

    // Verify the file exists.
    const { content } = writer.read(data.path);
    expect(content).toContain("# New Page");
    expect(content).toContain("kind: wiki");
  });

  it("agent.journal appends to memory/home.md", async () => {
    const { dispatcher, ctx, budget, dataRoot } = setup();

    const result = await dispatcher.call(
      "agent.journal",
      { text: "Completed a 5-tool-call edit run. Updated the carousel index." },
      ctx,
      budget,
    );
    expect(result.isError).toBe(false);

    const homePath = join(dataRoot, ".agents", "editor", "memory", "home.md");
    const content = readFileSync(homePath, "utf-8");
    expect(content).toContain("Completed a 5-tool-call edit run");
    expect(content).toContain("## Journal");
  });

  it("unknown tool returns an error", async () => {
    const { dispatcher, ctx, budget } = setup();

    const result = await dispatcher.call("kb.nonexistent", {}, ctx, budget);
    expect(result.isError).toBe(true);
    expect(result.result).toContain("Unknown tool");
  });
});
