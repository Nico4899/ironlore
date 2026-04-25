import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeEtag } from "@ironlore/core/server";
import { afterEach, describe, expect, it } from "vitest";
import { DryRunBridge } from "../agents/dry-run-bridge.js";
import { assignBlockIds } from "../block-ids.js";
import { SearchIndex } from "../search-index.js";
import { StorageWriter } from "../storage-writer.js";
import { createAgentJournal } from "./agent-journal.js";
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
    fetch: globalThis.fetch,
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
    dispatcher.register(createKbReadBlock(writer));
    dispatcher.register(createKbReplaceBlock(writer, index));
    dispatcher.register(createKbInsertAfter(writer, index));
    dispatcher.register(createKbDeleteBlock(writer, index));
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

  // -------------------------------------------------------------------------
  // kb.read_block
  // -------------------------------------------------------------------------

  it("kb.read_block returns the target block text + page ETag", async () => {
    const { writer, dispatcher, ctx, budget } = setup();
    const { markdown: annotated } = assignBlockIds("# Title\n\nFirst paragraph.\n\nSecond.\n");
    await writer.write("rb.md", annotated, null);

    const read = await dispatcher.call("kb.read_page", { path: "rb.md" }, ctx, budget);
    const { blocks, etag } = JSON.parse(read.result) as {
      blocks: Array<{ id: string }>;
      etag: string;
    };
    const firstPara = blocks[1]?.id;
    expect(firstPara).toBeDefined();

    const result = await dispatcher.call(
      "kb.read_block",
      { path: "rb.md", blockId: firstPara },
      ctx,
      budget,
    );
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.result);
    expect(data.blockId).toBe(firstPara);
    expect(data.text).toContain("First paragraph");
    expect(data.etag).toBe(etag);
  });

  it("kb.read_block returns 404 for an unknown block", async () => {
    const { writer, dispatcher, ctx, budget } = setup();
    const { markdown } = assignBlockIds("# Title\n\nBody.\n");
    await writer.write("rb2.md", markdown, null);

    const result = await dispatcher.call(
      "kb.read_block",
      { path: "rb2.md", blockId: "blk_NONEXISTENT00000000000" },
      ctx,
      budget,
    );
    const data = JSON.parse(result.result);
    expect(data.error).toContain("not found");
    expect(data.availableBlocks).toBeDefined();
  });

  it("kb.read_block returns page-not-found for missing paths", async () => {
    const { dispatcher, ctx, budget } = setup();
    const result = await dispatcher.call(
      "kb.read_block",
      { path: "missing.md", blockId: "blk_ANY" },
      ctx,
      budget,
    );
    const data = JSON.parse(result.result);
    expect(data.error).toBe("Page not found");
  });

  // -------------------------------------------------------------------------
  // kb.insert_after
  // -------------------------------------------------------------------------

  it("kb.insert_after splices a new block after the reference", async () => {
    const { writer, dispatcher, ctx, budget } = setup();
    const { markdown } = assignBlockIds("# Title\n\nOriginal paragraph.\n");
    await writer.write("ia.md", markdown, null);

    const read = await dispatcher.call("kb.read_page", { path: "ia.md" }, ctx, budget);
    const { blocks, etag } = JSON.parse(read.result) as {
      blocks: Array<{ id: string }>;
      etag: string;
    };
    const firstPara = blocks[1]?.id ?? blocks[0]?.id;

    const result = await dispatcher.call(
      "kb.insert_after",
      { path: "ia.md", blockId: firstPara, markdown: "Inserted paragraph.", etag },
      ctx,
      budget,
    );
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.result);
    expect(data.ok).toBe(true);
    expect(data.newEtag).toBeDefined();

    // Verify the file now contains both paragraphs in the right order.
    const { content } = writer.read("ia.md");
    expect(content).toContain("Original paragraph");
    expect(content).toContain("Inserted paragraph");
    expect(content.indexOf("Original")).toBeLessThan(content.indexOf("Inserted"));
  });

  it("kb.insert_after rejects stale ETags", async () => {
    const { writer, dispatcher, ctx, budget } = setup();
    const { markdown } = assignBlockIds("# Title\n\nBody.\n");
    await writer.write("ia2.md", markdown, null);
    const read = await dispatcher.call("kb.read_page", { path: "ia2.md" }, ctx, budget);
    const { blocks } = JSON.parse(read.result) as { blocks: Array<{ id: string }> };
    const blockId = blocks[1]?.id ?? blocks[0]?.id;

    const result = await dispatcher.call(
      "kb.insert_after",
      {
        path: "ia2.md",
        blockId,
        markdown: "new",
        etag: computeEtag("stale content"),
      },
      ctx,
      budget,
    );
    const data = JSON.parse(result.result);
    expect(data.error).toContain("ETag mismatch");
    expect(data.currentEtag).toBeDefined();
  });

  it("kb.insert_after rejects unknown block IDs", async () => {
    const { writer, dispatcher, ctx, budget } = setup();
    const { markdown } = assignBlockIds("# T\n\nBody.\n");
    await writer.write("ia3.md", markdown, null);
    const { etag } = writer.read("ia3.md");

    const result = await dispatcher.call(
      "kb.insert_after",
      { path: "ia3.md", blockId: "blk_NONEXISTENT00000000000", markdown: "x", etag },
      ctx,
      budget,
    );
    const data = JSON.parse(result.result);
    expect(data.error).toContain("not found");
    expect(data.availableBlocks).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // kb.delete_block
  // -------------------------------------------------------------------------

  it("kb.delete_block removes the target block from the page", async () => {
    const { writer, dispatcher, ctx, budget } = setup();
    const { markdown } = assignBlockIds("# Title\n\nKeep me.\n\nDelete me.\n\nKeep me too.\n");
    await writer.write("db.md", markdown, null);

    const read = await dispatcher.call("kb.read_page", { path: "db.md" }, ctx, budget);
    const { blocks, etag } = JSON.parse(read.result) as {
      blocks: Array<{ id: string; preview: string }>;
      etag: string;
    };
    const toDelete = blocks.find((b) => b.preview.includes("Delete"));
    expect(toDelete).toBeDefined();

    const result = await dispatcher.call(
      "kb.delete_block",
      { path: "db.md", blockId: toDelete?.id, etag },
      ctx,
      budget,
    );
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.result);
    expect(data.ok).toBe(true);

    const { content } = writer.read("db.md");
    expect(content).not.toContain("Delete me");
    expect(content).toContain("Keep me.");
    expect(content).toContain("Keep me too.");
  });

  it("kb.delete_block rejects stale ETags", async () => {
    const { writer, dispatcher, ctx, budget } = setup();
    const { markdown } = assignBlockIds("# T\n\nA.\n\nB.\n");
    await writer.write("db2.md", markdown, null);
    const read = await dispatcher.call("kb.read_page", { path: "db2.md" }, ctx, budget);
    const { blocks } = JSON.parse(read.result) as { blocks: Array<{ id: string }> };

    const result = await dispatcher.call(
      "kb.delete_block",
      { path: "db2.md", blockId: blocks[1]?.id, etag: computeEtag("stale") },
      ctx,
      budget,
    );
    const data = JSON.parse(result.result);
    expect(data.error).toContain("ETag mismatch");
  });

  it("kb.delete_block rejects unknown block IDs", async () => {
    const { writer, dispatcher, ctx, budget } = setup();
    const { markdown } = assignBlockIds("# T\n\nA.\n");
    await writer.write("db3.md", markdown, null);
    const { etag } = writer.read("db3.md");

    const result = await dispatcher.call(
      "kb.delete_block",
      { path: "db3.md", blockId: "blk_NONEXISTENT00000000000", etag },
      ctx,
      budget,
    );
    const data = JSON.parse(result.result);
    expect(data.error).toContain("not found");
  });

  // -------------------------------------------------------------------------
  // End-to-end: 5-tool-call edit run (Phase 4 exit criterion)
  // -------------------------------------------------------------------------

  it("executes a 5-tool-call sequential edit run without crashing", async () => {
    // Simulates what the executor would drive: read → replace → re-read
    // → insert → journal. This is the "5-tool-call edit" exit criterion
    // from docs/06-implementation-roadmap.md §Phase 4. The re-read is
    // intrinsic: every mutation yields a new ETag, and the next mutation
    // needs the fresh one.
    const { writer, dispatcher, ctx, budget } = setup();
    const { markdown } = assignBlockIds(
      "# Carousel\n\nFirst slide description.\n\nSecond slide description.\n",
    );
    await writer.write("carousel.md", markdown, null);

    // 1. Read the page.
    const readRes = await dispatcher.call("kb.read_page", { path: "carousel.md" }, ctx, budget);
    const { blocks, etag } = JSON.parse(readRes.result) as {
      blocks: Array<{ id: string; preview: string }>;
      etag: string;
    };
    const firstSlide = blocks.find((b) => b.preview.includes("First"));
    expect(firstSlide).toBeDefined();

    // 2. Replace a block.
    const replaceRes = await dispatcher.call(
      "kb.replace_block",
      {
        path: "carousel.md",
        blockId: firstSlide?.id,
        markdown: "First slide (revised).",
        etag,
      },
      ctx,
      budget,
    );
    const { newEtag: etag2 } = JSON.parse(replaceRes.result) as { newEtag: string };
    expect(etag2).toBeDefined();

    // 3. Re-read to get fresh ETag + block IDs after the replace.
    const reread = await dispatcher.call("kb.read_page", { path: "carousel.md" }, ctx, budget);
    const { blocks: blocks2, etag: etag3 } = JSON.parse(reread.result) as {
      blocks: Array<{ id: string; preview: string }>;
      etag: string;
    };
    const revised = blocks2.find((b) => b.preview.includes("revised"));
    expect(revised).toBeDefined();

    // 4. Insert after the revised slide.
    const insertRes = await dispatcher.call(
      "kb.insert_after",
      {
        path: "carousel.md",
        blockId: revised?.id,
        markdown: "Bonus slide inserted between.",
        etag: etag3,
      },
      ctx,
      budget,
    );
    expect(insertRes.isError).toBe(false);

    // 5. Journal the run.
    const journalRes = await dispatcher.call(
      "agent.journal",
      { text: "Revised carousel: replaced slide 1 and inserted a bonus slide." },
      ctx,
      budget,
    );
    expect(journalRes.isError).toBe(false);

    // Budget accounting — 5 tool calls used.
    expect(budget.usedToolCalls).toBe(5);

    // Verify the final page has all expected content.
    const { content } = writer.read("carousel.md");
    expect(content).toContain("revised");
    expect(content).toContain("Bonus slide");
    expect(content).toContain("Second slide");
  });

  // -------------------------------------------------------------------------
  // Dry-run diff preview flow
  // -------------------------------------------------------------------------
  // When the agent's persona declares `review_mode: dry_run`, the
  // executor attaches a DryRunBridge to the tool context. Destructive
  // tools then emit `diff_preview` + wait for approval instead of
  // mutating directly. These tests cover the three outcomes:
  // approve → normal execute; reject → skipped; unknown tool → no-op.

  it("dry-run: emits diff_preview and waits on bridge before mutating", async () => {
    const { writer, dispatcher, budget, dataRoot } = setup();
    const { markdown } = assignBlockIds("# Page\n\nOriginal paragraph.\n");
    await writer.write("dry.md", markdown, null);
    const { etag } = writer.read("dry.md");
    // Second block — first is the heading, we want the paragraph.
    const blockMatches = [...writer.read("dry.md").content.matchAll(/blk_[A-Z0-9]{26}/g)];
    const blockId = blockMatches[1]?.[0] ?? blockMatches[0]?.[0];
    expect(blockId).toBeDefined();

    const events: Array<{ kind: string; data: unknown }> = [];
    const bridge = new DryRunBridge();
    const ctx: ToolCallContext = {
      projectId: "main",
      agentSlug: "editor",
      jobId: "test-job",
      emitEvent: (kind, data) => events.push({ kind, data }),
      dataRoot,
      fetch: globalThis.fetch,
      dryRunBridge: bridge,
    };

    // Fire the tool call and the verdict concurrently.
    const call = dispatcher.call(
      "kb.replace_block",
      { path: "dry.md", blockId, markdown: "New content.", etag },
      ctx,
      budget,
      "tool-call-xyz",
    );

    // Wait until the dispatcher has actually emitted the preview and
    // parked on the bridge. Polling beats a fixed sleep here — bridge
    // wiring is fast but not synchronous.
    await new Promise((resolve) => {
      const check = () => {
        if (events.some((e) => e.kind === "diff_preview")) resolve(undefined);
        else setTimeout(check, 5);
      };
      check();
    });

    const previewEvent = events.find((e) => e.kind === "diff_preview");
    expect(previewEvent).toBeDefined();
    const previewData = previewEvent?.data as {
      toolCallId: string;
      tool: string;
      pageId: string;
      diff: string;
    };
    expect(previewData.toolCallId).toBe("tool-call-xyz");
    expect(previewData.tool).toBe("kb.replace_block");
    expect(previewData.pageId).toBe("dry.md");
    expect(previewData.diff).toContain("- Original paragraph.");
    expect(previewData.diff).toContain("+ New content.");

    // Approve → the mutation proceeds.
    expect(bridge.submitVerdict("tool-call-xyz", "approve")).toBe(true);
    const result = await call;
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.result);
    expect(data.ok).toBe(true);

    const { content } = writer.read("dry.md");
    expect(content).toContain("New content.");
  });

  it("dry-run: reject short-circuits the mutation with a skipped result", async () => {
    const { writer, dispatcher, budget, dataRoot } = setup();
    const { markdown } = assignBlockIds("# Page\n\nKeep me.\n");
    await writer.write("dry2.md", markdown, null);
    const { etag } = writer.read("dry2.md");
    const blockId = [...writer.read("dry2.md").content.matchAll(/blk_[A-Z0-9]{26}/g)][1]?.[0];

    const bridge = new DryRunBridge();
    const ctx: ToolCallContext = {
      projectId: "main",
      agentSlug: "editor",
      jobId: "test-job",
      emitEvent: () => {},
      dataRoot,
      fetch: globalThis.fetch,
      dryRunBridge: bridge,
    };

    const call = dispatcher.call(
      "kb.replace_block",
      { path: "dry2.md", blockId, markdown: "Evil rewrite.", etag },
      ctx,
      budget,
      "tool-call-reject",
    );

    // Wait until the dispatcher is parked, then reject.
    await new Promise((resolve) => {
      const check = () => {
        if (bridge.pendingCount > 0) resolve(undefined);
        else setTimeout(check, 5);
      };
      check();
    });
    bridge.submitVerdict("tool-call-reject", "reject");

    const result = await call;
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.result);
    expect(data.ok).toBe(false);
    expect(data.skipped).toBe(true);
    expect(data.reason).toContain("user rejected");

    // Verify the page was NOT modified.
    const { content } = writer.read("dry2.md");
    expect(content).toContain("Keep me.");
    expect(content).not.toContain("Evil rewrite.");
  });

  it("dry-run: bridge timeout is treated as a rejection", async () => {
    const { writer, dispatcher, budget, dataRoot } = setup();
    const { markdown } = assignBlockIds("# Page\n\nOriginal.\n");
    await writer.write("dry3.md", markdown, null);
    const { etag } = writer.read("dry3.md");
    const blockId = [...writer.read("dry3.md").content.matchAll(/blk_[A-Z0-9]{26}/g)][1]?.[0];

    // Use a bridge that returns "timeout" immediately by calling
    // cancelAll right after the dispatcher parks.
    const bridge = new DryRunBridge();
    const ctx: ToolCallContext = {
      projectId: "main",
      agentSlug: "editor",
      jobId: "test-job",
      emitEvent: () => {},
      dataRoot,
      fetch: globalThis.fetch,
      dryRunBridge: bridge,
    };

    const call = dispatcher.call(
      "kb.replace_block",
      { path: "dry3.md", blockId, markdown: "timeout", etag },
      ctx,
      budget,
      "tool-call-timeout",
    );

    await new Promise((resolve) => {
      const check = () => {
        if (bridge.pendingCount > 0) resolve(undefined);
        else setTimeout(check, 5);
      };
      check();
    });
    bridge.cancelAll();

    const result = await call;
    const data = JSON.parse(result.result);
    expect(data.skipped).toBe(true);
    expect(data.reason).toContain("no response within review window");

    const { content } = writer.read("dry3.md");
    expect(content).toContain("Original.");
  });

  it("dry-run: tools without computeDiff bypass the bridge entirely", async () => {
    // kb.search / kb.read_page / kb.read_page / kb.create_page do not
    // implement computeDiff. Even with a bridge attached, these run
    // normally — no diff_preview event, no verdict wait.
    const { dispatcher, budget, dataRoot } = setup();
    const bridge = new DryRunBridge();
    const events: Array<{ kind: string; data: unknown }> = [];
    const ctx: ToolCallContext = {
      projectId: "main",
      agentSlug: "general",
      jobId: "test-job",
      emitEvent: (kind, data) => events.push({ kind, data }),
      dataRoot,
      fetch: globalThis.fetch,
      dryRunBridge: bridge,
    };

    const result = await dispatcher.call("kb.search", { query: "anything" }, ctx, budget);
    expect(result.isError).toBe(false);
    expect(bridge.pendingCount).toBe(0);
    expect(events.some((e) => e.kind === "diff_preview")).toBe(false);
  });

  it("dry-run: no bridge attached means destructive tools run normally", async () => {
    // Sanity check — the pre-dry-run behavior still works when no
    // bridge is attached (the common "Editor agent in straight run
    // mode" case).
    const { writer, dispatcher, ctx, budget } = setup();
    const { markdown } = assignBlockIds("# Page\n\nOriginal.\n");
    await writer.write("no-bridge.md", markdown, null);
    const { etag } = writer.read("no-bridge.md");
    const blockId = [...writer.read("no-bridge.md").content.matchAll(/blk_[A-Z0-9]{26}/g)][1]?.[0];

    const result = await dispatcher.call(
      "kb.replace_block",
      { path: "no-bridge.md", blockId, markdown: "Straight write.", etag },
      ctx,
      budget,
    );
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.result);
    expect(data.ok).toBe(true);
    const { content } = writer.read("no-bridge.md");
    expect(content).toContain("Straight write.");
  });
});
