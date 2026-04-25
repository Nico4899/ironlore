import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobContext, JobRow } from "../jobs/types.js";
import type {
  BatchHandle,
  BatchPollResult,
  ChatEvent,
  ChatOptions,
  ProjectContext,
  Provider,
} from "../providers/types.js";
import { ToolDispatcher } from "../tools/dispatcher.js";
import { executeAgentRun, findMutatingToolsInPersona } from "./executor.js";

/**
 * Batch tool-use precondition guard.
 *
 * Anthropic's Message Batches API is single-turn — the model
 * cannot call mutating tools mid-batch. A persona that opts into
 * `batch: true` but declares any of the mutating kb tools is
 * misconfigured: today the executor would strip the tools from
 * the submission and produce a coherent text reply with **no
 * mutations**, silently failing the workflow. The guard refuses
 * the run upfront so the author sees a loud, actionable error
 * instead of an empty diff.
 *
 * Pinning the tool list here so a refactor that adds a new
 * mutating tool (e.g. `kb.move_page`) without updating the guard
 * fails the test.
 */

const ctx: ProjectContext = { projectId: "main", fetch: globalThis.fetch };

let dataDir: string;
let projectDir: string;

function writePersona(slug: string, frontmatter: string): void {
  const dir = join(dataDir, ".agents", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "persona.md"),
    `---\nslug: ${slug}\n${frontmatter}\n---\n\nBody.\n`,
    "utf-8",
  );
}

function makeJob(): JobRow {
  const now = Date.now();
  return {
    id: "test-job",
    project_id: "main",
    kind: "agent.run",
    mode: "autonomous",
    owner_id: "gardener",
    payload: JSON.stringify({ prompt: "summarise" }),
    status: "running",
    lease_until: null,
    worker_id: null,
    attempts: 1,
    max_attempts: 3,
    scheduled_at: now,
    started_at: now,
    finished_at: null,
    result: null,
    commit_sha_start: null,
    commit_sha_end: null,
    created_at: now,
  };
}

interface RecordedEvent {
  kind: string;
  data: unknown;
}

function makeJobCtx(events: RecordedEvent[]): JobContext {
  return {
    projectId: "main",
    workerId: "test-worker",
    emitEvent: (kind, data) => events.push({ kind, data }),
    signal: new AbortController().signal,
  };
}

class StubBatchProvider implements Provider {
  readonly name = "anthropic" as const;
  readonly supportsTools = true;
  readonly supportsPromptCache = true;
  readonly supportsBatch = true;

  submitCalls = 0;

  // biome-ignore lint/correctness/useYield: deliberate empty stream
  async *chat(_opts: ChatOptions, _ctx: ProjectContext): AsyncIterable<ChatEvent> {
    return;
  }

  async submitBatch(_opts: ChatOptions, _ctx: ProjectContext): Promise<BatchHandle> {
    this.submitCalls++;
    return {
      provider: "anthropic",
      batchId: "msgbatch_stub",
      requestId: "req_stub",
    };
  }

  async pollBatch(_handle: BatchHandle, _ctx: ProjectContext): Promise<BatchPollResult> {
    return {
      status: "completed",
      result: { text: "ok", stopReason: "end_turn" },
    };
  }
}

describe("findMutatingToolsInPersona", () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), `batch-guard-${randomBytes(4).toString("hex")}-`));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns empty when persona is missing", () => {
    expect(findMutatingToolsInPersona(dataDir, "ghost")).toEqual([]);
  });

  it("returns empty when persona declares no tools field", () => {
    writePersona("plain", "active: true");
    expect(findMutatingToolsInPersona(dataDir, "plain")).toEqual([]);
  });

  it("returns empty when only read-only tools are declared", () => {
    writePersona("reader", "tools: [kb.search, kb.read_page, kb.read_block]");
    expect(findMutatingToolsInPersona(dataDir, "reader")).toEqual([]);
  });

  it("flags kb.replace_block in flow-style tools list", () => {
    writePersona("editor", "tools: [kb.search, kb.replace_block]");
    expect(findMutatingToolsInPersona(dataDir, "editor")).toEqual(["kb.replace_block"]);
  });

  it("flags every mutating tool when several are declared (block style)", () => {
    writePersona(
      "writer",
      "tools:\n  - kb.search\n  - kb.replace_block\n  - kb.insert_after\n  - kb.delete_block\n  - kb.create_page",
    );
    const flagged = findMutatingToolsInPersona(dataDir, "writer");
    expect(flagged.sort()).toEqual(
      ["kb.create_page", "kb.delete_block", "kb.insert_after", "kb.replace_block"].sort(),
    );
  });

  it("ignores quoted forms — quotes are stripped before matching", () => {
    writePersona("quoted", `tools: ["kb.search", 'kb.replace_block']`);
    expect(findMutatingToolsInPersona(dataDir, "quoted")).toEqual(["kb.replace_block"]);
  });
});

describe("executor — batch precondition guard", () => {
  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), `batch-guard-exec-${randomBytes(4).toString("hex")}-`));
    dataDir = join(projectDir, "data");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(projectDir, ".ironlore"), { recursive: true });
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("refuses the run when persona declares batch:true + a mutating tool", async () => {
    writePersona("misconfigured", "batch: true\ntools: [kb.search, kb.replace_block]");
    const provider = new StubBatchProvider();
    const events: RecordedEvent[] = [];

    const result = await executeAgentRun(makeJob(), makeJobCtx(events), {
      provider,
      projectContext: ctx,
      dispatcher: new ToolDispatcher(),
      dataRoot: dataDir,
      projectDir,
      model: "claude-sonnet-4-6",
      agentSlug: "misconfigured",
      batchOptions: { forceOptIn: true, pollIntervalMs: 1, timeoutMs: 5000 },
    });

    expect(result.status).toBe("failed");
    expect(result.result).toMatch(/kb\.replace_block/);
    expect(result.result).toMatch(/single-turn/);
    expect(provider.submitCalls).toBe(0);
    const errEvent = events.find((e) => e.kind === "message.error");
    expect(errEvent).toBeDefined();
  });

  it("allows the run when persona declares batch:true + only read-only tools", async () => {
    writePersona("safe", "batch: true\ntools: [kb.search, kb.read_page]");
    const provider = new StubBatchProvider();

    const result = await executeAgentRun(makeJob(), makeJobCtx([]), {
      provider,
      projectContext: ctx,
      dispatcher: new ToolDispatcher(),
      dataRoot: dataDir,
      projectDir,
      model: "claude-sonnet-4-6",
      agentSlug: "safe",
      batchOptions: { forceOptIn: true, pollIntervalMs: 1, timeoutMs: 5000 },
    });

    expect(result.status).toBe("done");
    expect(provider.submitCalls).toBe(1);
  });

  it("allows the run when persona declares batch:true with no tools field at all", async () => {
    // No tools declared = persona accepts whatever the dispatcher
    // exposes; the batch path strips them, which is fine for a
    // read-only summarisation workflow.
    writePersona("undeclared", "batch: true");
    const provider = new StubBatchProvider();

    const result = await executeAgentRun(makeJob(), makeJobCtx([]), {
      provider,
      projectContext: ctx,
      dispatcher: new ToolDispatcher(),
      dataRoot: dataDir,
      projectDir,
      model: "claude-sonnet-4-6",
      agentSlug: "undeclared",
      batchOptions: { forceOptIn: true, pollIntervalMs: 1, timeoutMs: 5000 },
    });

    expect(result.status).toBe("done");
    expect(provider.submitCalls).toBe(1);
  });
});
