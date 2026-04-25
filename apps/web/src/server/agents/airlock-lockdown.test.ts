import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EgressDowngradedError } from "../airlock.js";
import type { JobContext, JobRow } from "../jobs/types.js";
import type { ChatEvent, ChatOptions, ProjectContext, Provider } from "../providers/types.js";
import { SearchIndex } from "../search-index.js";
import { ToolDispatcher } from "../tools/dispatcher.js";
import { createKbGlobalSearch } from "../tools/kb-global-search.js";
import { executeAgentRun } from "./executor.js";

/**
 * Integration test for the full Airlock loop:
 *
 *   1. Agent is registered with `kb.global_search`.
 *   2. Provider's `chat` calls the tool, which fans out to a
 *      foreign project and triggers the downgrade.
 *   3. Provider's *next* network call goes through the wrapped
 *      `ProjectContext.fetch` and throws `EgressDowngradedError`.
 *
 * This is the audit's "Done when" criterion — verifies the
 * mechanism end-to-end, not just the individual primitives.
 */

function makeTmpProject(): { projectDir: string; dataRoot: string } {
  const projectDir = join(tmpdir(), `airlock-lockdown-${randomBytes(4).toString("hex")}`);
  const dataRoot = join(projectDir, "data");
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(join(projectDir, ".ironlore"), { recursive: true });
  return { projectDir, dataRoot };
}

function makeJob(): JobRow {
  const now = Date.now();
  return {
    id: "airlock-test",
    project_id: "main",
    kind: "agent.run",
    mode: "interactive",
    owner_id: "general",
    payload: JSON.stringify({ prompt: "search across all projects" }),
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
  };
}

function makeJobCtx(events: Array<{ kind: string; data: unknown }>): JobContext {
  return {
    projectId: "main",
    workerId: "test-worker",
    emitEvent: (kind, data) => events.push({ kind, data }),
    signal: new AbortController().signal,
  };
}

/**
 * Provider stub that scripts the documented Airlock flow:
 *   call 1 → emit a `tool_use` for `kb.global_search`
 *   call 2 → call `ctx.fetch` for some allowed host (post-tool)
 *   call 3+ → no-op (executor breaks after journal)
 *
 * The second `chat` invocation is where the lockdown bites — the
 * provider tries to make a network call after the tool dispatched,
 * and the wrapped fetch throws.
 */
class AirlockScriptedProvider implements Provider {
  readonly name = "anthropic" as const;
  readonly supportsTools = true;
  readonly supportsPromptCache = true;

  callCount = 0;
  fetchAttempted = false;
  fetchError: unknown = null;

  async *chat(_opts: ChatOptions, ctx: ProjectContext): AsyncIterable<ChatEvent> {
    this.callCount++;
    if (this.callCount === 1) {
      // Round 1: ask the agent to call kb.global_search.
      yield {
        type: "tool_use",
        id: "tool_call_1",
        name: "kb.global_search",
        input: { query: "carousel" },
      };
      yield { type: "done", stopReason: "tool_use" };
      return;
    }
    // Round 2: try to call the wrapped fetch (= a network call
    // through the Airlock-protected pipe). After the tool's
    // downgrade fires this call should throw — we capture the
    // error so the test can assert on it directly.
    try {
      await ctx.fetch("https://api.example.com/sink");
    } catch (err) {
      this.fetchAttempted = true;
      this.fetchError = err;
    }
    // Then journal the run so the executor exits.
    yield {
      type: "tool_use",
      id: "tool_call_2",
      name: "agent.journal",
      input: { summary: "done" },
    };
    yield { type: "done", stopReason: "tool_use" };
  }
}

describe("Airlock — full lockdown round-trip through the executor", () => {
  let mainFx: { projectDir: string; dataRoot: string };
  let foreignFx: { projectDir: string; dataRoot: string };
  let mainIndex: SearchIndex;
  let foreignIndex: SearchIndex;

  beforeEach(() => {
    mainFx = makeTmpProject();
    foreignFx = makeTmpProject();
    mainIndex = new SearchIndex(mainFx.projectDir);
    foreignIndex = new SearchIndex(foreignFx.projectDir);
    foreignIndex.indexPage("secret.md", "# Foreign\n\nCarousel factory.\n", "test");
  });

  afterEach(() => {
    mainIndex.close();
    foreignIndex.close();
    try {
      rmSync(mainFx.projectDir, { recursive: true, force: true });
      rmSync(foreignFx.projectDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("global_search returns foreign hits → next fetch throws EgressDowngradedError", async () => {
    const provider = new AirlockScriptedProvider();
    const dispatcher = new ToolDispatcher();
    dispatcher.register(
      createKbGlobalSearch({
        getAllProjectIndexes: () =>
          new Map([
            ["main", mainIndex],
            ["other", foreignIndex],
          ]),
      }),
    );
    // Stub agent.journal so the executor's "must finalize"
    // sentinel fires cleanly. Real agent.journal writes to disk;
    // the lockdown is independent of that.
    dispatcher.register({
      definition: {
        name: "agent.journal",
        description: "stub",
        inputSchema: { type: "object", properties: {} },
      },
      async execute() {
        return JSON.stringify({ ok: true });
      },
    });

    // Base fetch always succeeds — the *only* reason the second
    // call fails is the airlock wrapper. If our wrapping logic
    // were broken, this fetch would happily reach
    // `api.example.com/sink` and the test would catch it.
    const baseFetch = vi.fn(async () => new Response("ok"));
    const projectContext: ProjectContext = {
      projectId: "main",
      fetch: baseFetch,
    };

    const events: Array<{ kind: string; data: unknown }> = [];
    await executeAgentRun(makeJob(), makeJobCtx(events), {
      provider,
      projectContext,
      dispatcher,
      dataRoot: mainFx.dataRoot,
      projectDir: mainFx.projectDir,
      model: "claude-sonnet-4-6",
      agentSlug: "general",
    });

    // The second chat round attempted a fetch and got the
    // downgrade error.
    expect(provider.fetchAttempted).toBe(true);
    expect(provider.fetchError).toBeInstanceOf(EgressDowngradedError);

    // Base fetch was never reached — the airlock short-circuited
    // before the network was touched. This is the security
    // invariant: a downgraded run cannot exfiltrate.
    expect(baseFetch).not.toHaveBeenCalled();

    // Job event stream carries the audit trail the AI panel will
    // surface as the "lockdown" banner.
    const downgradeEvent = events.find((e) => e.kind === "egress.downgraded");
    expect(downgradeEvent).toBeDefined();
    expect((downgradeEvent?.data as { reason?: string })?.reason).toMatch(/cross-project/);
  });
});
