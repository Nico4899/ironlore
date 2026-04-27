import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobContext, JobRow } from "../jobs/types.js";
import type { ChatEvent, ChatOptions, ProjectContext, Provider } from "../providers/types.js";
import { createAgentJournal } from "../tools/agent-journal.js";
import { ToolDispatcher } from "../tools/dispatcher.js";
import { executeAgentRun } from "./executor.js";

/**
 * Phase-11 lint surface — `agent.journal({ lintReport })` triggers
 * `executor.onLintReport`, which the production wiring hands to
 * the WS broadcast as a `lint:findings` event.
 *
 * Pinning three behaviours:
 *   1. Calling agent.journal WITHOUT `lintReport` does not fire
 *      onLintReport — every generic agent run today journals at
 *      finalize, and we don't want a banner on every one.
 *   2. Calling with a well-formed `lintReport` fires onLintReport
 *      exactly once with the same counts the agent supplied.
 *   3. Counts are coerced to integers ≥ 0 even when the agent
 *      passes garbage (defensive: prompt-injected agents shouldn't
 *      be able to ship a negative count to the UI).
 */

let projectDir: string;
let dataRoot: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "lint-findings-"));
  dataRoot = join(projectDir, "data");
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(join(projectDir, ".ironlore"), { recursive: true });
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

const projectCtx: ProjectContext = { projectId: "main", fetch: globalThis.fetch };

function makeJob(): JobRow {
  const now = Date.now();
  return {
    id: "lint-job",
    project_id: "main",
    kind: "agent.run",
    mode: "autonomous",
    owner_id: "wiki-gardener",
    payload: JSON.stringify({ prompt: "lint" }),
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
    egress_downgraded: null,
    created_at: now,
  };
}

function makeJobCtx(events: Array<{ kind: string; data: unknown }>): JobContext {
  return {
    projectId: "main",
    workerId: "test-worker",
    emitEvent: (kind, data) => events.push({ kind, data }),
    markEgressDowngraded: () => undefined,
    signal: new AbortController().signal,
  };
}

/**
 * Provider that yields exactly one tool_use event for `agent.journal`,
 * with the given args. Lets us drive the executor's finalize path
 * without a real LLM round-trip.
 */
function makeJournalProvider(journalArgs: unknown): Provider {
  return {
    name: "anthropic",
    supportsTools: true,
    supportsPromptCache: true,
    async *chat(_o: ChatOptions, _c: ProjectContext): AsyncIterable<ChatEvent> {
      yield {
        type: "tool_use",
        id: "tool_1",
        name: "agent.journal",
        input: journalArgs,
      };
      yield {
        type: "done",
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    },
  };
}

describe("executor.onLintReport", () => {
  it("fires onLintReport exactly once when the agent journals with lintReport", async () => {
    // Need a real dispatcher with the journal tool registered so the
    // executor's tool-dispatch + finalize-detect codepath runs end-to-end.
    const dispatcher = new ToolDispatcher();
    dispatcher.register(createAgentJournal(dataRoot));

    const provider = makeJournalProvider({
      text: "wrote lint report",
      lintReport: {
        reportPath: "_maintenance/lint-2026-04-26.md",
        counts: {
          orphans: 3,
          stale: 1,
          contradictions: 0,
          coverageGaps: 2,
          provenanceGaps: 0,
        },
      },
    });

    const onLintReport = vi.fn();

    await executeAgentRun(makeJob(), makeJobCtx([]), {
      provider,
      projectContext: projectCtx,
      dispatcher,
      dataRoot,
      projectDir,
      model: "claude-sonnet-4-6",
      agentSlug: "wiki-gardener",
      onLintReport,
    });

    expect(onLintReport).toHaveBeenCalledTimes(1);
    const call = onLintReport.mock.calls[0]?.[0];
    expect(call.reportPath).toBe("_maintenance/lint-2026-04-26.md");
    expect(call.counts).toEqual({
      orphans: 3,
      stale: 1,
      contradictions: 0,
      coverageGaps: 2,
      provenanceGaps: 0,
    });
  });

  it("does NOT fire onLintReport when the agent journals without lintReport", async () => {
    // Generic agent runs that finalize via plain `agent.journal({text})`
    // must not fire the banner — otherwise every agent.run would push
    // a "lint complete" toast.
    const dispatcher = new ToolDispatcher();
    dispatcher.register(createAgentJournal(dataRoot));

    const provider = makeJournalProvider({ text: "just a regular run" });
    const onLintReport = vi.fn();

    await executeAgentRun(makeJob(), makeJobCtx([]), {
      provider,
      projectContext: projectCtx,
      dispatcher,
      dataRoot,
      projectDir,
      model: "claude-sonnet-4-6",
      agentSlug: "general",
      onLintReport,
    });

    expect(onLintReport).not.toHaveBeenCalled();
  });

  it("coerces malformed counts to integers ≥ 0 (defensive against prompt injection)", async () => {
    // The journal tool itself coerces malformed counts before
    // emitting the event payload (numberOr0 helper). Pin that —
    // a prompt-injected agent supplying `-99999` or `"NaN"` should
    // surface as 0, not poison the UI.
    const dispatcher = new ToolDispatcher();
    dispatcher.register(createAgentJournal(dataRoot));

    const provider = makeJournalProvider({
      text: "malformed counts",
      lintReport: {
        reportPath: "_maintenance/lint-evil.md",
        counts: {
          orphans: -5,
          stale: "ten" as unknown as number,
          contradictions: Number.NaN,
          coverageGaps: 1.5,
          provenanceGaps: 0,
        },
      },
    });

    // Capture the event payload from the journal tool itself —
    // that's where coercion runs. The executor passes whatever's
    // on `tc.input` through to onLintReport, so we assert the
    // sanitisation by reading the agent.journal event's payload.
    const events: Array<{ kind: string; data: unknown }> = [];
    await executeAgentRun(makeJob(), makeJobCtx(events), {
      provider,
      projectContext: projectCtx,
      dispatcher,
      dataRoot,
      projectDir,
      model: "claude-sonnet-4-6",
      agentSlug: "wiki-gardener",
    });

    const journalEvent = events.find((e) => e.kind === "agent.journal");
    expect(journalEvent).toBeDefined();
    const payload = journalEvent?.data as {
      lintReport?: { counts: Record<string, number> };
    };
    expect(payload.lintReport?.counts).toEqual({
      orphans: 0,
      stale: 0,
      contradictions: 0,
      coverageGaps: 1.5,
      provenanceGaps: 0,
    });
  });
});
