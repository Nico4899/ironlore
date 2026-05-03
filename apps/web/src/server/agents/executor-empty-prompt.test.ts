import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobContext, JobRow } from "../jobs/types.js";
import type {
  ChatEvent,
  ChatMessage,
  ChatOptions,
  ProjectContext,
  Provider,
} from "../providers/types.js";
import { ToolDispatcher } from "../tools/dispatcher.js";
import { executeAgentRun } from "./executor.js";

/**
 * Empty-prompt regression for autonomous runs.
 *
 * The "Run Now" CTA on the Agent Detail page enqueues an autonomous
 * run with `payload: { prompt: "" }` (no user message). Heartbeat
 * scheduler does the same for cron-fired runs. The earlier executor
 * skipped the message-push when `initialPrompt` was empty, leaving
 * the conversation history empty when `provider.chat` was called —
 * Anthropic rejected with HTTP 400 "messages: at least one message
 * is required". Every autonomous fire crashed before turn 1.
 *
 * The fix synthesises a generic kick-off message when no
 * user-supplied prompt exists, and crucially does NOT echo it on
 * the event stream so the AI panel transcript stays clean for any
 * user who happens to be watching.
 */

function makeTmpProject(): { projectDir: string; dataRoot: string } {
  const projectDir = join(tmpdir(), `exec-emptyprompt-test-${randomBytes(4).toString("hex")}`);
  const dataRoot = join(projectDir, "data");
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(join(projectDir, ".ironlore"), { recursive: true });
  return { projectDir, dataRoot };
}

/** Provider stub that records the messages it received on chat(). */
class RecordingProvider implements Provider {
  readonly name = "anthropic" as const;
  readonly supportsTools = true;
  readonly supportsPromptCache = true;
  receivedMessages: ChatMessage[][] = [];

  async *chat(opts: ChatOptions, _ctx: ProjectContext): AsyncIterable<ChatEvent> {
    this.receivedMessages.push([...opts.messages]);
    yield { type: "text", text: "ok" };
    yield { type: "done", stopReason: "end_turn" };
  }
}

const ctx: ProjectContext = { projectId: "main", fetch: globalThis.fetch };

function makeJob(payload: { prompt?: string }, mode: "interactive" | "autonomous"): JobRow {
  const now = Date.now();
  return {
    id: "test-job",
    project_id: "main",
    kind: "agent.run",
    mode,
    owner_id: "general",
    payload: JSON.stringify(payload),
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

interface CapturedEvent {
  kind: string;
  data: unknown;
}

function makeJobCtx(events: CapturedEvent[]): JobContext {
  return {
    projectId: "main",
    workerId: "test-worker",
    emitEvent: (kind, data) => events.push({ kind, data }),
    markEgressDowngraded: () => undefined,
    signal: new AbortController().signal,
  };
}

describe("executor — empty-prompt autonomous run", () => {
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

  it("synthesises a kick-off message when no prompt is supplied (autonomous)", async () => {
    const provider = new RecordingProvider();
    const events: CapturedEvent[] = [];
    await executeAgentRun(makeJob({ prompt: "" }, "autonomous"), makeJobCtx(events), {
      provider,
      projectContext: ctx,
      dispatcher: new ToolDispatcher(),
      dataRoot,
      projectDir,
      model: "claude-haiku-4-20250514",
      agentSlug: "general",
    });

    // First (and only) chat call must have a non-empty messages array.
    expect(provider.receivedMessages).toHaveLength(1);
    const firstTurn = provider.receivedMessages[0] ?? [];
    expect(firstTurn.length).toBeGreaterThanOrEqual(1);
    const firstMsg = firstTurn[0];
    expect(firstMsg?.role).toBe("user");
    expect(firstMsg && "content" in firstMsg ? firstMsg.content : "").toContain("Begin");
  });

  it("does NOT emit `message.user` for the synthetic kick-off", async () => {
    const provider = new RecordingProvider();
    const events: CapturedEvent[] = [];
    await executeAgentRun(makeJob({ prompt: "" }, "autonomous"), makeJobCtx(events), {
      provider,
      projectContext: ctx,
      dispatcher: new ToolDispatcher(),
      dataRoot,
      projectDir,
      model: "claude-haiku-4-20250514",
      agentSlug: "general",
    });

    // The user-message event is the AI panel's transcript surface.
    //  Synthetic kick-offs would clutter the panel with "Begin your
    //  scheduled run." every time a heartbeat fires; never emit one.
    const userEvents = events.filter((e) => e.kind === "message.user");
    expect(userEvents).toHaveLength(0);
  });

  it("preserves the user-supplied prompt verbatim (interactive)", async () => {
    const provider = new RecordingProvider();
    const events: CapturedEvent[] = [];
    await executeAgentRun(
      makeJob({ prompt: "What can you do?" }, "interactive"),
      makeJobCtx(events),
      {
        provider,
        projectContext: ctx,
        dispatcher: new ToolDispatcher(),
        dataRoot,
        projectDir,
        model: "claude-haiku-4-20250514",
        agentSlug: "general",
      },
    );

    const firstTurn = provider.receivedMessages[0] ?? [];
    const firstMsg = firstTurn[0];
    expect(firstMsg && "content" in firstMsg ? firstMsg.content : "").toBe("What can you do?");
    // Interactive prompt SHOULD echo to the event stream — that's
    //  the user's bubble in the AI panel.
    const userEvents = events.filter((e) => e.kind === "message.user");
    expect(userEvents).toHaveLength(1);
    expect((userEvents[0]?.data as { text?: string })?.text).toBe("What can you do?");
  });

  it("trims whitespace-only prompts to empty (treats as autonomous kick-off)", async () => {
    const provider = new RecordingProvider();
    const events: CapturedEvent[] = [];
    await executeAgentRun(makeJob({ prompt: "   \n\t  " }, "autonomous"), makeJobCtx(events), {
      provider,
      projectContext: ctx,
      dispatcher: new ToolDispatcher(),
      dataRoot,
      projectDir,
      model: "claude-haiku-4-20250514",
      agentSlug: "general",
    });

    const firstTurn = provider.receivedMessages[0] ?? [];
    const firstMsg = firstTurn[0];
    expect(firstMsg && "content" in firstMsg ? firstMsg.content : "").toContain("Begin");
    // Whitespace-only doesn't count as user-supplied; no echo.
    expect(events.filter((e) => e.kind === "message.user")).toHaveLength(0);
  });
});
