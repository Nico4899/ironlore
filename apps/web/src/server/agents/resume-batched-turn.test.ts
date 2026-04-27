import { describe, expect, it, vi } from "vitest";
import type { BatchHandlePersisted } from "../jobs/types.js";
import type {
  BatchHandle,
  BatchPollResult,
  ChatEvent,
  ChatOptions,
  ProjectContext,
  Provider,
} from "../providers/types.js";
import { resumeBatchedTurn } from "./executor.js";

/**
 * Phase-11 batch resume tick.
 *
 * `resumeBatchedTurn` is the per-tick polling helper invoked by
 * the `agent.batch_resume` job handler. It polls upstream once,
 * emits events on the *original* job's stream, and either
 * finalizes the original or returns `rescheduled` so the caller
 * can re-enqueue the next tick.
 *
 * These tests pin three behaviours:
 *   1. Completion path emits message.text + usage + batch.completed
 *      and finalizes the original as `done`.
 *   2. Failure path emits message.error + finalizes as `failed`.
 *   3. In-progress path emits batch.poll + returns `rescheduled`
 *      *without* touching the original's terminal state.
 */

const ctx: ProjectContext = { projectId: "main", fetch: globalThis.fetch };
const handle: BatchHandlePersisted = {
  provider: "anthropic",
  batchId: "msgbatch_resume",
  requestId: "req_resume",
  model: "claude-sonnet-4-6",
  agentSlug: "general",
};

class StubPollProvider implements Provider {
  readonly name = "anthropic" as const;
  readonly supportsTools = true;
  readonly supportsPromptCache = true;
  readonly supportsBatch = true;
  pollCalls = 0;
  constructor(private readonly verdict: BatchPollResult) {}
  // biome-ignore lint/correctness/useYield: deliberate empty stream
  async *chat(_o: ChatOptions, _c: ProjectContext): AsyncIterable<ChatEvent> {
    return;
  }
  async submitBatch(): Promise<BatchHandle> {
    throw new Error("not used in resume-tick tests");
  }
  async pollBatch(): Promise<BatchPollResult> {
    this.pollCalls++;
    return this.verdict;
  }
}

describe("resumeBatchedTurn", () => {
  it("on completed → emits message.text + usage + batch.completed + finalizes done", async () => {
    const provider = new StubPollProvider({
      status: "completed",
      result: {
        text: "summary text",
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 50 },
      },
    });
    const emit = vi.fn();
    const finalize = vi.fn();
    const result = await resumeBatchedTurn({
      provider,
      projectContext: ctx,
      originalJobId: "orig-1",
      handle,
      emitOriginal: emit,
      finalizeOriginal: finalize,
      attempt: 1,
      attemptCap: 720,
    });

    expect(result.outcome).toBe("completed");
    expect(provider.pollCalls).toBe(1);
    const kinds = emit.mock.calls.map((c) => c[0]);
    expect(kinds).toContain("batch.poll");
    expect(kinds).toContain("message.text");
    expect(kinds).toContain("usage");
    expect(kinds).toContain("batch.completed");
    expect(finalize).toHaveBeenCalledWith("done", "summary text");
  });

  it("on expired → emits message.error + finalizes failed with the upstream reason", async () => {
    const provider = new StubPollProvider({
      status: "expired",
      error: "Batch expired before completion",
    });
    const emit = vi.fn();
    const finalize = vi.fn();
    const result = await resumeBatchedTurn({
      provider,
      projectContext: ctx,
      originalJobId: "orig-2",
      handle,
      emitOriginal: emit,
      finalizeOriginal: finalize,
      attempt: 1,
      attemptCap: 720,
    });

    expect(result.outcome).toBe("failed");
    const errorEmit = emit.mock.calls.find((c) => c[0] === "message.error");
    expect(errorEmit).toBeDefined();
    expect((errorEmit?.[1] as { text: string }).text).toMatch(/expired/i);
    expect(finalize).toHaveBeenCalledWith("failed", expect.stringMatching(/expired/i));
  });

  it("on in_progress → emits batch.poll + returns rescheduled without finalizing", async () => {
    const provider = new StubPollProvider({ status: "in_progress" });
    const emit = vi.fn();
    const finalize = vi.fn();
    const result = await resumeBatchedTurn({
      provider,
      projectContext: ctx,
      originalJobId: "orig-3",
      handle,
      emitOriginal: emit,
      finalizeOriginal: finalize,
      attempt: 5,
      attemptCap: 720,
    });

    expect(result.outcome).toBe("rescheduled");
    const pollEmit = emit.mock.calls.find((c) => c[0] === "batch.poll");
    expect(pollEmit).toBeDefined();
    expect((pollEmit?.[1] as { attempt: number }).attempt).toBe(5);
    // Critically: no finalization on in-progress.
    expect(finalize).not.toHaveBeenCalled();
  });

  it("attemptCap exhaustion → emits a clear error + fails fast, never polls", async () => {
    const provider = new StubPollProvider({ status: "in_progress" });
    const emit = vi.fn();
    const finalize = vi.fn();
    const result = await resumeBatchedTurn({
      provider,
      projectContext: ctx,
      originalJobId: "orig-cap",
      handle,
      emitOriginal: emit,
      finalizeOriginal: finalize,
      attempt: 100,
      attemptCap: 50,
    });

    expect(result.outcome).toBe("failed");
    expect(provider.pollCalls).toBe(0);
    expect(finalize).toHaveBeenCalledWith("failed", expect.stringMatching(/poll-attempt cap/));
  });

  it("provider.pollBatch throws → emits error + finalizes failed (no infinite reschedule)", async () => {
    class ThrowingProvider extends StubPollProvider {
      override async pollBatch(): Promise<BatchPollResult> {
        throw new Error("upstream timeout");
      }
    }
    const provider = new ThrowingProvider({ status: "in_progress" });
    const emit = vi.fn();
    const finalize = vi.fn();
    const result = await resumeBatchedTurn({
      provider,
      projectContext: ctx,
      originalJobId: "orig-throw",
      handle,
      emitOriginal: emit,
      finalizeOriginal: finalize,
      attempt: 1,
      attemptCap: 720,
    });

    expect(result.outcome).toBe("failed");
    expect(finalize).toHaveBeenCalledWith("failed", "upstream timeout");
  });
});
