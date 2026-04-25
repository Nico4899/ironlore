import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
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
import { executeAgentRun } from "./executor.js";

/**
 * Executor + async-batch wiring.
 *
 * The provider-side batch surface ships in
 * [`anthropic-batch.test.ts`](../providers/anthropic-batch.test.ts).
 * This file exercises the executor's *integration* with that
 * surface — the per-persona opt-in, the bounded poll loop, the
 * event shape the AI panel sees, and the failure paths.
 */

function makeTmpProject(): { projectDir: string; dataRoot: string } {
  const projectDir = join(tmpdir(), `exec-batch-${randomBytes(4).toString("hex")}`);
  const dataRoot = join(projectDir, "data");
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(join(projectDir, ".ironlore"), { recursive: true });
  return { projectDir, dataRoot };
}

const ctx: ProjectContext = { projectId: "main", fetch: globalThis.fetch };

function makeJob(overrides: Partial<JobRow> = {}): JobRow {
  const now = Date.now();
  return {
    id: "test-job",
    project_id: "main",
    // Batch path is autonomous-only by design — interactive runs
    // always stream because the user is at their desk.
    kind: "agent.run",
    mode: "autonomous",
    owner_id: "general",
    payload: JSON.stringify({ prompt: "summarise the inbox" }),
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
    batch_handle: null,
    created_at: now,
    ...overrides,
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

/**
 * Stub provider with a configurable batch lifecycle. Returns
 * `in_progress` for the first `progressCount` polls, then the
 * next call returns the configured terminal state.
 */
class StubBatchProvider implements Provider {
  readonly name = "anthropic" as const;
  readonly supportsTools = true;
  readonly supportsPromptCache = true;
  readonly supportsBatch = true;

  submitCalls = 0;
  pollCalls = 0;
  lastSubmitOpts: ChatOptions | null = null;

  constructor(
    private readonly script: {
      progressCount: number;
      terminal: BatchPollResult;
    },
  ) {}

  // Should never be reached in batch tests — yield nothing so a
  // misrouted call surfaces as an empty stream rather than fake
  // success.
  // biome-ignore lint/correctness/useYield: deliberate empty stream
  async *chat(_opts: ChatOptions, _ctx: ProjectContext): AsyncIterable<ChatEvent> {
    return;
  }

  async submitBatch(opts: ChatOptions, _ctx: ProjectContext): Promise<BatchHandle> {
    this.submitCalls++;
    this.lastSubmitOpts = opts;
    return {
      provider: "anthropic",
      batchId: `msgbatch_stub_${this.submitCalls}`,
      requestId: "req_stub",
    };
  }

  async pollBatch(_handle: BatchHandle, _ctx: ProjectContext): Promise<BatchPollResult> {
    this.pollCalls++;
    if (this.pollCalls <= this.script.progressCount) {
      return { status: "in_progress" };
    }
    return this.script.terminal;
  }
}

describe("executor — async-batch path", () => {
  let projectDir: string;
  let dataRoot: string;

  beforeEach(() => {
    const tmp = makeTmpProject();
    projectDir = tmp.projectDir;
    dataRoot = tmp.dataRoot;
  });

  afterEach(() => {
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("submits the batch and returns batch_pending so the worker pool can release the slot", async () => {
    const provider = new StubBatchProvider({
      progressCount: 0,
      terminal: {
        status: "completed",
        result: {
          text: "summary text",
          stopReason: "end_turn",
          usage: { inputTokens: 100, outputTokens: 50 },
        },
      },
    });
    const events: RecordedEvent[] = [];

    const result = await executeAgentRun(makeJob(), makeJobCtx(events), {
      provider,
      projectContext: ctx,
      dispatcher: new ToolDispatcher(),
      dataRoot,
      projectDir,
      model: "claude-sonnet-4-6",
      agentSlug: "general",
      // forceOptIn bypasses the persona-frontmatter read so the
      // test stays focused on the executor wiring.
      batchOptions: { forceOptIn: true, pollIntervalMs: 1, timeoutMs: 5000 },
    });

    expect(result.status).toBe("batch_pending");
    expect(result.batchHandle).toBeDefined();
    expect(result.batchHandle?.provider).toBe("anthropic");
    expect(result.batchHandle?.batchId).toMatch(/^msgbatch_/);
    expect(result.batchHandle?.agentSlug).toBe("general");
    expect(provider.submitCalls).toBe(1);
    // The executor no longer polls in-process — that's the worker
    // pool's job via agent.batch_resume ticks.
    expect(provider.pollCalls).toBe(0);

    // Submit-side events fire before the executor returns.
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("message.user");
    expect(kinds).toContain("batch.starting");
    expect(kinds).toContain("batch.submitted");
    // Polling events are emitted later, by resumeBatchedTurn —
    // they shouldn't appear yet.
    expect(kinds).not.toContain("batch.poll");
    expect(kinds).not.toContain("batch.completed");
  });

  it("strips tools from the submitBatch payload — single-turn invariant", async () => {
    const provider = new StubBatchProvider({
      progressCount: 0,
      terminal: {
        status: "completed",
        result: { text: "ok", stopReason: "end_turn" },
      },
    });

    await executeAgentRun(makeJob(), makeJobCtx([]), {
      provider,
      projectContext: ctx,
      dispatcher: new ToolDispatcher(),
      dataRoot,
      projectDir,
      model: "claude-sonnet-4-6",
      agentSlug: "general",
      batchOptions: { forceOptIn: true, pollIntervalMs: 1, timeoutMs: 5000 },
    });

    expect(provider.lastSubmitOpts?.tools).toBeUndefined();
  });

  it("returns failed when the submitBatch call itself throws", async () => {
    // A provider whose submit implementation throws (network
    // hiccup, auth error) should fail the run synchronously
    // instead of parking — there's no batch to poll later.
    class ThrowingSubmitProvider extends StubBatchProvider {
      override async submitBatch(): Promise<never> {
        throw new Error("upstream 500");
      }
    }
    const provider = new ThrowingSubmitProvider({
      progressCount: 0,
      terminal: { status: "completed", result: { text: "x", stopReason: "end_turn" } },
    });
    const events: RecordedEvent[] = [];

    const result = await executeAgentRun(makeJob(), makeJobCtx(events), {
      provider,
      projectContext: ctx,
      dispatcher: new ToolDispatcher(),
      dataRoot,
      projectDir,
      model: "claude-sonnet-4-6",
      agentSlug: "general",
      batchOptions: { forceOptIn: true, pollIntervalMs: 1, timeoutMs: 5000 },
    });

    expect(result.status).toBe("failed");
    expect(result.result).toMatch(/upstream 500/);
    const errEvent = events.find((e) => e.kind === "message.error");
    expect(errEvent).toBeDefined();
  });

  it("falls back to the streaming path for interactive jobs even when batch is opted in", async () => {
    // Interactive runs always stream — the user is at their desk.
    // forceOptIn shouldn't override that. The stub provider's
    // chat() yields nothing so the streaming path produces no
    // text — but submitBatch must NOT have been called.
    const provider = new StubBatchProvider({
      progressCount: 0,
      terminal: { status: "completed", result: { text: "x", stopReason: "end_turn" } },
    });

    await executeAgentRun(makeJob({ mode: "interactive" }), makeJobCtx([]), {
      provider,
      projectContext: ctx,
      dispatcher: new ToolDispatcher(),
      dataRoot,
      projectDir,
      model: "claude-sonnet-4-6",
      agentSlug: "general",
      batchOptions: { forceOptIn: true, pollIntervalMs: 1, timeoutMs: 5000 },
    });

    expect(provider.submitCalls).toBe(0);
  });

  it("falls back to the streaming path when the provider doesn't support batch", async () => {
    // Provider declares supportsBatch:false → executor must not
    // attempt to call submitBatch (which is undefined). It falls
    // through to the chat loop.
    const provider: Provider = {
      name: "ollama",
      supportsTools: false,
      supportsPromptCache: false,
      // No supportsBatch / submitBatch / pollBatch.
      // biome-ignore lint/correctness/useYield: stub stream
      async *chat(): AsyncIterable<ChatEvent> {
        return;
      },
    };

    const result = await executeAgentRun(makeJob(), makeJobCtx([]), {
      provider,
      projectContext: ctx,
      dispatcher: new ToolDispatcher(),
      dataRoot,
      projectDir,
      model: "llama3",
      agentSlug: "general",
      batchOptions: { forceOptIn: true, pollIntervalMs: 1, timeoutMs: 5000 },
    });

    // Streaming path with an empty stub yields no text and exits
    // after one turn — which the executor treats as `done`. We
    // assert success rather than failure: the absence of a batch
    // call is the real test.
    expect(result.status).toBe("done");
  });
});
