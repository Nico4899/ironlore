import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackpressureController } from "../jobs/backpressure.js";
import type { JobContext, JobRow } from "../jobs/types.js";
import type { ChatEvent, ChatOptions, ProjectContext, Provider } from "../providers/types.js";
import { ToolDispatcher } from "../tools/dispatcher.js";
import { executeAgentRun } from "./executor.js";

/**
 * Executor + backpressure wiring tests.
 *
 * The backpressure controller was previously instantiated but never
 * touched from production code — a shipped-on-paper feature that did
 * nothing. These tests verify the executor actually acquires/releases
 * the per-provider slot on every turn and flips onRateLimit when the
 * provider yields a 429-shaped error.
 */

function makeTmpProject(): { projectDir: string; dataRoot: string } {
  const projectDir = join(tmpdir(), `exec-bp-test-${randomBytes(4).toString("hex")}`);
  const dataRoot = join(projectDir, "data");
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(join(projectDir, ".ironlore"), { recursive: true });
  return { projectDir, dataRoot };
}

/** Minimal provider stub — emits one text chunk then done, or an error. */
class StubProvider implements Provider {
  readonly name = "anthropic" as const;
  readonly supportsTools = true;
  readonly supportsPromptCache = true;
  calls = 0;

  constructor(
    private readonly behavior: { kind: "text"; text: string } | { kind: "error"; message: string },
  ) {}

  async *chat(_opts: ChatOptions, _ctx: ProjectContext): AsyncIterable<ChatEvent> {
    this.calls++;
    if (this.behavior.kind === "error") {
      yield { type: "error", message: this.behavior.message };
      return;
    }
    yield { type: "text", text: this.behavior.text };
    yield { type: "done", stopReason: "end_turn" };
  }
}

const ctx: ProjectContext = { projectId: "main", fetch: globalThis.fetch };

function makeJob(overrides: Partial<JobRow> = {}): JobRow {
  const now = Date.now();
  return {
    id: "test-job",
    project_id: "main",
    kind: "agent.run",
    mode: "interactive",
    owner_id: "general",
    payload: JSON.stringify({ prompt: "hello" }),
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
    ...overrides,
  };
}

function makeJobCtx(): JobContext {
  return {
    projectId: "main",
    workerId: "test-worker",
    emitEvent: () => {},
    signal: new AbortController().signal,
  };
}

describe("executor + backpressure wiring", () => {
  let projectDir: string;
  let dataRoot: string;
  let backpressure: BackpressureController;

  beforeEach(() => {
    const tmp = makeTmpProject();
    projectDir = tmp.projectDir;
    dataRoot = tmp.dataRoot;
    backpressure = new BackpressureController(4);
  });

  afterEach(() => {
    backpressure.stop();
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("releases the provider slot after a successful chat", async () => {
    const provider = new StubProvider({ kind: "text", text: "ok" });
    const dispatcher = new ToolDispatcher();

    await executeAgentRun(makeJob(), makeJobCtx(), {
      provider,
      projectContext: ctx,
      dispatcher,
      dataRoot,
      projectDir,
      model: "claude-haiku-4-20250514",
      agentSlug: "general",
      backpressure,
    });

    // Controller should see zero active calls after the run.
    expect(backpressure.getActive("anthropic")).toBe(0);
    expect(provider.calls).toBeGreaterThanOrEqual(1);
  });

  it("releases the slot even when the provider throws", async () => {
    const provider = new StubProvider({ kind: "error", message: "500 server error" });
    const dispatcher = new ToolDispatcher();

    const result = await executeAgentRun(makeJob(), makeJobCtx(), {
      provider,
      projectContext: ctx,
      dispatcher,
      dataRoot,
      projectDir,
      model: "claude-haiku-4-20250514",
      agentSlug: "general",
      backpressure,
    });

    expect(result.status).toBe("failed");
    expect(backpressure.getActive("anthropic")).toBe(0);
  });

  it("halves the concurrency cap on a 429-shaped provider error", async () => {
    const provider = new StubProvider({
      kind: "error",
      message: "Anthropic API 429: rate limited",
    });
    const dispatcher = new ToolDispatcher();

    expect(backpressure.getCap("anthropic")).toBe(4);

    await executeAgentRun(makeJob(), makeJobCtx(), {
      provider,
      projectContext: ctx,
      dispatcher,
      dataRoot,
      projectDir,
      model: "claude-haiku-4-20250514",
      agentSlug: "general",
      backpressure,
    });

    // One 429 → cap halves from 4 to 2.
    expect(backpressure.getCap("anthropic")).toBe(2);
    // Active count released cleanly despite the error.
    expect(backpressure.getActive("anthropic")).toBe(0);
  });

  it("does NOT halve the cap on a non-rate-limit error", async () => {
    const provider = new StubProvider({ kind: "error", message: "500 internal server error" });
    const dispatcher = new ToolDispatcher();

    await executeAgentRun(makeJob(), makeJobCtx(), {
      provider,
      projectContext: ctx,
      dispatcher,
      dataRoot,
      projectDir,
      model: "claude-haiku-4-20250514",
      agentSlug: "general",
      backpressure,
    });

    // Generic errors should leave the cap alone.
    expect(backpressure.getCap("anthropic")).toBe(4);
  });

  it("executor works without a backpressure controller (legacy path)", async () => {
    const provider = new StubProvider({ kind: "text", text: "ok" });
    const dispatcher = new ToolDispatcher();

    const result = await executeAgentRun(makeJob(), makeJobCtx(), {
      provider,
      projectContext: ctx,
      dispatcher,
      dataRoot,
      projectDir,
      model: "claude-haiku-4-20250514",
      agentSlug: "general",
      // No backpressure — should still run cleanly.
    });

    expect(result.status).toBe("done");
  });
});
