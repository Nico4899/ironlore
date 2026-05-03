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
    dispatcher.register(createKbSearch(index, writer));
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
    // The dispatcher detects the `{"error": ...}` envelope and flips
    // `isError`. Previously this returned `false` and the model
    // treated the failure as success — see the AI-panel evolver
    // run that finalized after silently dropping two writes.
    expect(result.isError).toBe(true);
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
    expect(result.isError).toBe(true);
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
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.result);
    expect(data.error).toBe("Page not found");
  });

  // Bug 6 regression — kb.read_page used to surface raw `EISDIR:
  // illegal operation on a directory, read` from the dispatcher's
  // catch-all when the model passed a directory path. Now wrapped
  // as a structured envelope so the model can recover (call
  // kb.search instead) and the dispatcher's is_error gate fires
  // via the top-level `error` field.
  it("EISDIR (directory path) returns a structured envelope, not raw errno", async () => {
    const { writer, dispatcher, ctx, budget } = setup();
    // Create a real directory the writer can stat.
    await writer.write("wiki/page.md", "# Real page\n", null);

    const result = await dispatcher.call(
      "kb.read_page",
      { path: "wiki" }, // points at the directory, not a .md file
      ctx,
      budget,
    );
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.result);
    expect(data.error).toMatch(/directory, not a page/);
    expect(data.path).toBe("wiki");
    expect(data.kind).toBe("directory");
    // Raw Node errno suppressed.
    expect(data.error).not.toContain("EISDIR");
    expect(data.error).not.toContain("illegal operation");
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

  // Tier-1 §6 per docs/04-ai-and-agents.md §Tool protocol testing:
  // "A 20-call plan hits a 409 on call 7; assert the agent re-plans
  //  from the conflict point, not from call 1."
  //
  // The agent's correct recovery is `kb.read_page` (to refresh the
  // ETag + re-enumerate block IDs that may have changed on disk),
  // followed by a fresh `kb.replace_block` with the new ETag and a
  // re-resolved block. The earlier successful writes must NOT be
  // re-applied — the page on disk already reflects them. This test
  // pins that subset of behaviour: that the *server side* gives the
  // agent enough state to re-plan locally rather than restart the
  // whole sequence.
  it("mid-sequence conflict: a fresh kb.read_page after a 409 surfaces the new ETag", async () => {
    const { writer, dispatcher, ctx, budget } = setup();

    // Seed a page with three replaceable blocks.
    const seeded = assignBlockIds("# Plan\n\nFirst block.\n\nSecond block.\n\nThird block.\n");
    await writer.write("plan.md", seeded.markdown, null);

    // Calls 1–6: the agent reads, then replaces blocks 1 and 2 in
    //  sequence. Each replace returns a fresh ETag the agent threads
    //  into the next call.
    const read1 = await dispatcher.call("kb.read_page", { path: "plan.md" }, ctx, budget);
    expect(read1.isError).toBe(false);
    const read1Data = JSON.parse(read1.result) as {
      etag: string;
      blocks: Array<{ id: string; type: string }>;
    };
    const blockIds = read1Data.blocks.filter((b) => b.type === "paragraph").map((b) => b.id);
    expect(blockIds.length).toBeGreaterThanOrEqual(3);

    const replace1 = await dispatcher.call(
      "kb.replace_block",
      { path: "plan.md", blockId: blockIds[0], markdown: "Edited first.", etag: read1Data.etag },
      ctx,
      budget,
    );
    expect(replace1.isError).toBe(false);
    const replace1Data = JSON.parse(replace1.result) as { newEtag: string };

    const replace2 = await dispatcher.call(
      "kb.replace_block",
      {
        path: "plan.md",
        blockId: blockIds[1],
        markdown: "Edited second.",
        etag: replace1Data.newEtag,
      },
      ctx,
      budget,
    );
    expect(replace2.isError).toBe(false);
    const replace2Data = JSON.parse(replace2.result) as { newEtag: string };

    // Call 7: an *external* writer (simulating the user) edits the
    //  page out from under the agent. This invalidates the ETag the
    //  agent is holding for its planned call-7 replace.
    await writer.write(
      "plan.md",
      assignBlockIds("# Plan\n\nUser-edited first.\n\nUser-edited second.\n\nUser-edited third.\n")
        .markdown,
      replace2Data.newEtag,
    );

    // Call 7 (the agent's): replace block-3 with the now-stale ETag
    //  → 409. The error envelope must hand back the current ETag so
    //  the agent's recovery loop has the input it needs to re-plan
    //  locally.
    const conflict = await dispatcher.call(
      "kb.replace_block",
      {
        path: "plan.md",
        blockId: blockIds[2],
        markdown: "Edited third.",
        etag: replace2Data.newEtag,
      },
      ctx,
      budget,
    );
    expect(conflict.isError).toBe(true);
    const conflictData = JSON.parse(conflict.result) as { error: string; currentEtag: string };
    expect(conflictData.error).toContain("ETag mismatch");
    expect(conflictData.currentEtag).toBeDefined();
    expect(conflictData.currentEtag).not.toBe(replace2Data.newEtag);

    // Recovery: the agent re-reads (NOT re-runs calls 1–2) and uses
    //  the fresh ETag + fresh block IDs to retry the in-flight call.
    //  The user's prior two edits stay intact — call-7's recovery
    //  doesn't clobber them, which is the whole point of the
    //  scoped-re-plan vs. start-over distinction.
    const read2 = await dispatcher.call("kb.read_page", { path: "plan.md" }, ctx, budget);
    expect(read2.isError).toBe(false);
    const read2Data = JSON.parse(read2.result) as {
      etag: string;
      blocks: Array<{ id: string; type: string }>;
      content: string;
    };
    expect(read2Data.etag).toBe(conflictData.currentEtag);
    expect(read2Data.content).toContain("User-edited first.");
    expect(read2Data.content).toContain("User-edited second.");
    // The fresh block-IDs may differ from the originals (the user's
    //  full-page rewrite re-stamped them). The agent must read off
    //  the fresh list, not retry against the stale `blockIds[2]`.
    const freshBlocks = read2Data.blocks.filter((b) => b.type === "paragraph");
    expect(freshBlocks.length).toBeGreaterThanOrEqual(3);

    const replace3 = await dispatcher.call(
      "kb.replace_block",
      {
        path: "plan.md",
        blockId: freshBlocks[2]?.id ?? "",
        markdown: "Recovered third.",
        etag: read2Data.etag,
      },
      ctx,
      budget,
    );
    expect(replace3.isError).toBe(false);
    // Final state has the user's edits + the agent's recovered call-7.
    const final = writer.read("plan.md");
    expect(final.content).toContain("User-edited first.");
    expect(final.content).toContain("User-edited second.");
    expect(final.content).toContain("Recovered third.");
  });

  // Bug 4 regression — kb.search used to return the prose string
  // `"No results found."` for the empty case and a JSON array for
  // the populated case. Two shapes for the same logical answer
  // forced downstream consumers (the AI panel result-count chip,
  // the model parsing the result) to handle both. Now always a
  // JSON array.
  it("kb.search returns [] for the empty case (not the prose string)", async () => {
    const { dispatcher, ctx, budget } = setup();

    const result = await dispatcher.call(
      "kb.search",
      { query: "definitely-no-such-content-xyzzy" },
      ctx,
      budget,
    );
    expect(result.isError).toBe(false);
    // Must be JSON-parseable as an array (not the legacy
    // "No results found." string).
    const parsed = JSON.parse(result.result) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual([]);
  });

  it("kb.search returns the same shape for populated queries", async () => {
    const { writer, dispatcher, ctx, budget, index } = setup();
    const { markdown } = assignBlockIds("# Title\n\nFindable content.\n");
    await writer.write("findme.md", markdown, null);
    index.indexPage("findme.md", markdown, "test");

    const result = await dispatcher.call(
      "kb.search",
      { query: "Findable" },
      ctx,
      budget,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.result) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as unknown[]).length).toBeGreaterThan(0);
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

  // Bug 8 regression — files created under `.agents/**/skills/` must
  // use the skill convention (`{name, description}`), not the page
  // convention (`{schema, id, title, kind, ...}`). The hallucinated
  // `conversation-initialization.md` from the AI-panel evolver run
  // had page frontmatter, which the skill-loader's discovery surface
  // doesn't recognise as a skill.
  it("kb.create_page emits skill-shaped frontmatter for `.agents/.shared/skills/` paths", async () => {
    const { writer, dispatcher, ctx, budget } = setup();

    const result = await dispatcher.call(
      "kb.create_page",
      {
        parent: ".agents/.shared/skills",
        title: "My Skill",
        markdown: "# My Skill\n\nDoes a thing.",
        description: "Does a thing concisely",
      },
      ctx,
      budget,
    );
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.result);
    expect(data.path).toMatch(/\.agents\/\.shared\/skills\/my-skill\.md$/);

    const { content } = writer.read(data.path);
    expect(content).toContain("name: My Skill");
    expect(content).toContain("description: Does a thing concisely");
    // No page-shaped fields should leak in.
    expect(content).not.toContain("schema:");
    expect(content).not.toContain("kind:");
    expect(content).not.toMatch(/^id:/m);
  });

  it("kb.create_page falls back to title when description is omitted on a skill path", async () => {
    const { writer, dispatcher, ctx, budget } = setup();

    const result = await dispatcher.call(
      "kb.create_page",
      {
        parent: ".agents/.shared/skills",
        title: "Bare Skill",
        markdown: "Body.",
      },
      ctx,
      budget,
    );
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.result);
    const { content } = writer.read(data.path);
    // Description defaults to the title rather than being omitted —
    // the skill loader's BM25 surface needs *something* searchable.
    expect(content).toContain("description: Bare Skill");
  });

  it("kb.create_page detects per-agent skills dirs, not just .shared", async () => {
    const { writer, dispatcher, ctx, budget } = setup();

    const result = await dispatcher.call(
      "kb.create_page",
      {
        parent: ".agents/wiki-gardener/skills",
        title: "Local Skill",
        markdown: "Body.",
        description: "Local-only skill",
      },
      ctx,
      budget,
    );
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.result);
    const { content } = writer.read(data.path);
    expect(content).toContain("name: Local Skill");
    expect(content).not.toContain("schema:");
  });

  // Bug regression — kb.create_page used to unconditionally prepend
  // `# {title}` to the body, producing two stacked H1s when the model
  // already included its own (the audit caught `cats.md` and
  // `notes/test-cleanup.md` with duplicate `# Cats` / `# test-cleanup`
  // headings). Detect a leading ATX heading and skip the prepend.

  it("kb.create_page does not duplicate the H1 when the body already opens with one", async () => {
    const { writer, dispatcher, ctx, budget } = setup();

    const result = await dispatcher.call(
      "kb.create_page",
      {
        parent: "wiki",
        title: "Cats",
        markdown: "# Cats\n\nCats are fascinating animals.",
        kind: "wiki",
      },
      ctx,
      budget,
    );
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.result);
    const { content } = writer.read(data.path);

    // Exactly one `# Cats` heading — not two stacked.
    const h1Matches = content.match(/^#\s+Cats\b/gm) ?? [];
    expect(h1Matches).toHaveLength(1);
  });

  it("kb.create_page detects leading whitespace before the H1", async () => {
    const { writer, dispatcher, ctx, budget } = setup();

    const result = await dispatcher.call(
      "kb.create_page",
      {
        parent: "wiki",
        title: "Spaced",
        markdown: "\n\n  \n# Spaced\n\nBody.",
      },
      ctx,
      budget,
    );
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.result);
    const { content } = writer.read(data.path);
    const h1Matches = content.match(/^#\s+Spaced\b/gm) ?? [];
    expect(h1Matches).toHaveLength(1);
  });

  it("kb.create_page still prepends the H1 when the body has no heading", async () => {
    // Original behaviour preserved for the common case where the
    // model passes raw prose. The page must always end up with a
    // top-level heading so the file isn't headless.
    const { writer, dispatcher, ctx, budget } = setup();

    const result = await dispatcher.call(
      "kb.create_page",
      {
        parent: "wiki",
        title: "Bare",
        markdown: "Just a paragraph, no heading.",
      },
      ctx,
      budget,
    );
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.result);
    const { content } = writer.read(data.path);
    // `assignBlockIds` may append ` <!-- #blk_... -->` to the
    // heading line, so anchor on the prefix only.
    expect(content).toMatch(/^# Bare\b/m);
  });

  it("kb.create_page treats sub-headings (## / ###) the same — skip the prepend", async () => {
    // A model that opens with `## Cats` clearly thinks they're
    // writing a section, not a page top-level. Don't second-guess
    // by stacking a `# Cats` above it — that looked weird in the
    // audit too. The page-creator's job is to wrap, not to
    // override the model's heading hierarchy.
    const { writer, dispatcher, ctx, budget } = setup();

    const result = await dispatcher.call(
      "kb.create_page",
      {
        parent: "wiki",
        title: "Cats",
        markdown: "## Cats overview\n\nBody.",
      },
      ctx,
      budget,
    );
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.result);
    const { content } = writer.read(data.path);
    expect(content).not.toMatch(/^# Cats\b/m);
    expect(content).toMatch(/^## Cats overview\b/m);
  });

  it("kb.create_page leaves non-skill paths on the page convention", async () => {
    const { writer, dispatcher, ctx, budget } = setup();

    const result = await dispatcher.call(
      "kb.create_page",
      {
        parent: "wiki",
        title: "Regular Page",
        markdown: "Body.",
        kind: "wiki",
      },
      ctx,
      budget,
    );
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.result);
    const { content } = writer.read(data.path);
    expect(content).toContain("schema: 1");
    expect(content).toContain("title: Regular Page");
    expect(content).toContain("kind: wiki");
    // `name`/`description` belong to the skill envelope, not pages.
    expect(content).not.toMatch(/^name:/m);
    expect(content).not.toMatch(/^description:/m);
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

  // -------------------------------------------------------------------------
  // tool.result / tool.error duration measurement
  // -------------------------------------------------------------------------
  //
  // Regression for the "every tool reads 0ms in the AI panel" bug.
  // Duration was measured client-side from `Date.now() - msg.timestamp`,
  // but `tool.call` and `tool.result` events land in the same 500ms
  // poll batch and were stamped in the same JS tick — so every
  // duration rounded to ~0ms regardless of how long the tool actually
  // ran. The fix moves measurement into the dispatcher (server-side)
  // and emits the result on the event payload.

  it("emits durationMs on tool.result events", async () => {
    const { dispatcher, dataRoot, budget } = setup();
    const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
    const ctx: ToolCallContext = {
      projectId: "main",
      agentSlug: "editor",
      jobId: "test-job",
      emitEvent: (kind, data) => events.push({ kind, data: data as Record<string, unknown> }),
      dataRoot,
      fetch: globalThis.fetch,
    };

    await dispatcher.call("kb.search", { query: "anything" }, ctx, budget);

    const resultEvt = events.find((e) => e.kind === "tool.result");
    expect(resultEvt).toBeDefined();
    expect(typeof resultEvt?.data.durationMs).toBe("number");
    expect(resultEvt?.data.durationMs as number).toBeGreaterThanOrEqual(0);
  });

  it("emits durationMs on tool.error events when the tool throws", async () => {
    const dispatcher = new ToolDispatcher();
    // Hand-rolled tool that throws — exercises the catch branch.
    dispatcher.register({
      definition: {
        name: "test.boom",
        description: "throws on call",
        inputSchema: { type: "object" },
      },
      execute: async () => {
        throw new Error("simulated failure");
      },
    });

    const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
    const ctx: ToolCallContext = {
      projectId: "main",
      agentSlug: "editor",
      jobId: "test-job",
      emitEvent: (kind, data) => events.push({ kind, data: data as Record<string, unknown> }),
      dataRoot: "/tmp",
      fetch: globalThis.fetch,
    };

    const out = await dispatcher.call("test.boom", {}, ctx, makeBudget());
    expect(out.isError).toBe(true);

    const errEvt = events.find((e) => e.kind === "tool.error");
    expect(errEvt).toBeDefined();
    expect(typeof errEvt?.data.durationMs).toBe("number");
  });
});
