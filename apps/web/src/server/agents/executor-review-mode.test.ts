import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobContext, JobRow } from "../jobs/types.js";
import type { ChatEvent, ChatOptions, ProjectContext, Provider } from "../providers/types.js";
import { createAgentJournal } from "../tools/agent-journal.js";
import { ToolDispatcher } from "../tools/dispatcher.js";

/** Build a dispatcher pre-registered with agent.journal so the executor's
 *  finalize call actually writes to disk. Tests can register additional
 *  tools on the returned dispatcher. */
function makeDispatcherWithJournal(dataRoot: string): ToolDispatcher {
  const d = new ToolDispatcher();
  d.register(createAgentJournal(dataRoot));
  return d;
}
import { executeAgentRun } from "./executor.js";

/**
 * `review_mode: inbox` honoring tests.
 *
 * Regression coverage for the AI-panel evolver bug: an agent's
 * persona declared `review_mode: inbox` and the user expected every
 * write to land on a staging branch for approval, but the executor
 * silently bypassed that gate for `mode: "interactive"` runs and
 * committed straight to main. The fix drops the autonomous-only
 * gate so the persona's stated review intent is honored uniformly.
 */

function makeTmpProject(): { projectDir: string; dataRoot: string } {
  const projectDir = join(tmpdir(), `exec-review-test-${randomBytes(4).toString("hex")}`);
  const dataRoot = join(projectDir, "data");
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(join(projectDir, ".ironlore"), { recursive: true });

  // The executor branch operations need a real repo with a HEAD,
  // otherwise `git checkout -b` and `git rev-parse HEAD` both
  // silently fail and the test can't observe inbox-branch creation.
  execSync("git init -b main", { cwd: projectDir, stdio: "pipe" });
  execSync("git config user.email test@local", { cwd: projectDir, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: projectDir, stdio: "pipe" });
  execSync("git commit --allow-empty -m init", { cwd: projectDir, stdio: "pipe" });

  return { projectDir, dataRoot };
}

function writePersona(dataRoot: string, slug: string, frontmatter: string): void {
  const dir = join(dataRoot, ".agents", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "persona.md"),
    `---\n${frontmatter}\n---\n\nYou are the ${slug} agent.\n`,
    "utf-8",
  );
}

class StubProvider implements Provider {
  readonly name = "anthropic" as const;
  readonly supportsTools = true;
  readonly supportsPromptCache = true;
  async *chat(_opts: ChatOptions, _ctx: ProjectContext): AsyncIterable<ChatEvent> {
    yield { type: "text", text: "ok" };
    yield { type: "done", stopReason: "end_turn" };
  }
}

const projectContext: ProjectContext = { projectId: "main", fetch: globalThis.fetch };

function makeJob(overrides: Partial<JobRow> = {}): JobRow {
  const now = Date.now();
  return {
    id: `job-${randomBytes(3).toString("hex")}`,
    project_id: "main",
    kind: "agent.run",
    mode: "interactive",
    owner_id: "evolver",
    payload: JSON.stringify({ prompt: "hi" }),
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
    ...overrides,
  };
}

function makeJobCtx(): JobContext {
  return {
    projectId: "main",
    workerId: "test-worker",
    emitEvent: () => {},
    markEgressDowngraded: () => undefined,
    signal: new AbortController().signal,
  };
}

describe("executor — required_tools gate (anti-fabrication)", () => {
  let projectDir: string;
  let dataRoot: string;

  beforeEach(() => {
    ({ projectDir, dataRoot } = makeTmpProject());
  });

  afterEach(() => {
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  // Stub provider that scripts a sequence of turns: each generator
  // call yields the next scripted turn. Tests script the model
  // emitting a `tool_use` for `agent.journal` directly, then a
  // text-only turn so the executor exits the loop.
  class ScriptedProvider implements Provider {
    readonly name = "anthropic" as const;
    readonly supportsTools = true;
    readonly supportsPromptCache = true;
    private turn = 0;
    constructor(private readonly turns: ChatEvent[][]) {}
    async *chat(_o: ChatOptions, _c: ProjectContext): AsyncIterable<ChatEvent> {
      const events = this.turns[this.turn++] ?? [{ type: "done", stopReason: "end_turn" }];
      for (const e of events) yield e;
    }
  }

  it("rejects agent.journal when a required tool was never called", async () => {
    writePersona(dataRoot, "evolver", "required_tools: [kb.query_failed_runs]");

    // Capture tool.result events so we can inspect the synthetic
    // error envelope the gate emitted instead of running the journal.
    const events: Array<{ kind: string; data: unknown }> = [];
    const jobCtx: JobContext = {
      projectId: "main",
      workerId: "test-worker",
      emitEvent: (kind, data) => events.push({ kind, data }),
      markEgressDowngraded: () => undefined,
      signal: new AbortController().signal,
    };

    // Model immediately tries to journal without calling
    // kb.query_failed_runs first.
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_use",
          id: "tu_1",
          name: "agent.journal",
          input: { text: "fabricated summary" },
        },
        { type: "done", stopReason: "tool_use" },
      ],
      [{ type: "text", text: "ok" }, { type: "done", stopReason: "end_turn" }],
    ]);

    await executeAgentRun(makeJob({ owner_id: "evolver" }), jobCtx, {
      provider,
      projectContext,
      dispatcher: makeDispatcherWithJournal(dataRoot),
      dataRoot,
      projectDir,
      model: "claude-haiku-4-20250514",
      agentSlug: "evolver",
    });

    // The gate should have produced a synthetic tool.result with
    // an error envelope mentioning the missing tool.
    const journalResult = events.find(
      (e) =>
        e.kind === "tool.result" &&
        (e.data as { tool?: string }).tool === "agent.journal" &&
        typeof (e.data as { result?: string }).result === "string" &&
        (e.data as { result: string }).result.includes("kb.query_failed_runs"),
    );
    expect(journalResult).toBeDefined();

    // The journal must NOT have been written.
    const journalPath = join(dataRoot, ".agents", "evolver", "memory", "home.md");
    expect(existsSync(journalPath)).toBe(false);
  });

  it("allows agent.journal once the required tool has been called", async () => {
    // Register a stub kb.query_failed_runs the model can dispatch,
    // alongside the real agent.journal handler.
    const dispatcher = makeDispatcherWithJournal(dataRoot);
    dispatcher.register({
      definition: {
        name: "kb.query_failed_runs",
        description: "stub",
        inputSchema: { type: "object" },
      },
      execute: async () => JSON.stringify({ perAgent: [], window: { sinceHours: 168 } }),
    });

    writePersona(dataRoot, "evolver", "required_tools: [kb.query_failed_runs]");

    const provider = new ScriptedProvider([
      [
        {
          type: "tool_use",
          id: "tu_1",
          name: "kb.query_failed_runs",
          input: {},
        },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        {
          type: "tool_use",
          id: "tu_2",
          name: "agent.journal",
          input: { text: "real summary" },
        },
        { type: "done", stopReason: "tool_use" },
      ],
      [{ type: "text", text: "ok" }, { type: "done", stopReason: "end_turn" }],
    ]);

    await executeAgentRun(makeJob({ owner_id: "evolver" }), makeJobCtx(), {
      provider,
      projectContext,
      dispatcher,
      dataRoot,
      projectDir,
      model: "claude-haiku-4-20250514",
      agentSlug: "evolver",
    });

    // Journal should now exist with the real summary.
    const journalPath = join(dataRoot, ".agents", "evolver", "memory", "home.md");
    expect(existsSync(journalPath)).toBe(true);
    expect(readFileSync(journalPath, "utf-8")).toContain("real summary");
  });

  it("agents with no required_tools field are unaffected", async () => {
    writePersona(dataRoot, "general", "name: General");

    const provider = new ScriptedProvider([
      [
        {
          type: "tool_use",
          id: "tu_1",
          name: "agent.journal",
          input: { text: "hi" },
        },
        { type: "done", stopReason: "tool_use" },
      ],
      [{ type: "text", text: "ok" }, { type: "done", stopReason: "end_turn" }],
    ]);

    await executeAgentRun(makeJob({ owner_id: "general" }), makeJobCtx(), {
      provider,
      projectContext,
      dispatcher: makeDispatcherWithJournal(dataRoot),
      dataRoot,
      projectDir,
      model: "claude-haiku-4-20250514",
      agentSlug: "general",
    });

    const journalPath = join(dataRoot, ".agents", "general", "memory", "home.md");
    expect(existsSync(journalPath)).toBe(true);
  });
});

describe("executor — review_mode: inbox honored regardless of run mode", () => {
  let projectDir: string;
  let dataRoot: string;

  beforeEach(() => {
    ({ projectDir, dataRoot } = makeTmpProject());
  });

  afterEach(() => {
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("interactive run with review_mode: inbox routes to a staging branch", async () => {
    writePersona(dataRoot, "evolver", "review_mode: inbox");
    const job = makeJob({ mode: "interactive", owner_id: "evolver" });

    const result = await executeAgentRun(job, makeJobCtx(), {
      provider: new StubProvider(),
      projectContext,
      dispatcher: new ToolDispatcher(),
      dataRoot,
      projectDir,
      model: "claude-haiku-4-20250514",
      agentSlug: "evolver",
    });

    const parsed = JSON.parse(result.result ?? "{}") as { inboxBranch?: string | null };
    expect(parsed.inboxBranch).toBe(`agents/evolver/${job.id}`);

    // Staging branch should exist in the project repo.
    const branches = execSync("git branch --list", { cwd: projectDir, encoding: "utf-8" });
    expect(branches).toContain(`agents/evolver/${job.id}`);
  });

  it("autonomous run with review_mode: inbox still routes to a staging branch", async () => {
    writePersona(dataRoot, "evolver", "review_mode: inbox");
    const job = makeJob({ mode: "autonomous", owner_id: "evolver" });

    const result = await executeAgentRun(job, makeJobCtx(), {
      provider: new StubProvider(),
      projectContext,
      dispatcher: new ToolDispatcher(),
      dataRoot,
      projectDir,
      model: "claude-haiku-4-20250514",
      agentSlug: "evolver",
    });

    const parsed = JSON.parse(result.result ?? "{}") as { inboxBranch?: string | null };
    expect(parsed.inboxBranch).toBe(`agents/evolver/${job.id}`);
  });

  it("restores HEAD to the project's actual default branch (not hardcoded 'main')", async () => {
    // Some installs have `master` as the default branch (older host
    // git config). The executor used to hardcode `git checkout main`
    // at the end of an inbox run, which silently failed on those
    // installs and left HEAD stuck on the staging branch. The fix
    // captures the current branch via `git symbolic-ref` before
    // staging and restores that exact branch after.
    execSync("git branch -m main master", { cwd: projectDir, stdio: "pipe" });
    writePersona(dataRoot, "evolver", "review_mode: inbox");
    const job = makeJob({ mode: "interactive", owner_id: "evolver" });

    await executeAgentRun(job, makeJobCtx(), {
      provider: new StubProvider(),
      projectContext,
      dispatcher: new ToolDispatcher(),
      dataRoot,
      projectDir,
      model: "claude-haiku-4-20250514",
      agentSlug: "evolver",
    });

    const head = execSync("git symbolic-ref --short HEAD", {
      cwd: projectDir,
      encoding: "utf-8",
    }).trim();
    expect(head).toBe("master"); // restored to where we started, not "main"
  });

  it("restores HEAD even when the provider errors mid-run", async () => {
    // Failure paths used to skip the restore entirely, leaving HEAD
    // stuck on the staging branch and contaminating every subsequent
    // run. Verify a provider error still triggers the restore.
    writePersona(dataRoot, "evolver", "review_mode: inbox");
    const job = makeJob({ mode: "interactive", owner_id: "evolver" });

    class ErroringProvider implements Provider {
      readonly name = "anthropic" as const;
      readonly supportsTools = true;
      readonly supportsPromptCache = true;
      async *chat(_o: ChatOptions, _c: ProjectContext): AsyncIterable<ChatEvent> {
        yield { type: "error", message: "simulated 400" };
      }
    }

    await executeAgentRun(job, makeJobCtx(), {
      provider: new ErroringProvider(),
      projectContext,
      dispatcher: new ToolDispatcher(),
      dataRoot,
      projectDir,
      model: "claude-haiku-4-20250514",
      agentSlug: "evolver",
    });

    const head = execSync("git symbolic-ref --short HEAD", {
      cwd: projectDir,
      encoding: "utf-8",
    }).trim();
    expect(head).toBe("main");
  });

  it("interactive run WITHOUT review_mode commits straight to main (no staging)", async () => {
    // Most agents (general, editor, etc.) don't set review_mode and
    // expect immediate writes. Make sure the fix doesn't accidentally
    // route those through the inbox.
    writePersona(dataRoot, "general", "name: General");
    const job = makeJob({ mode: "interactive", owner_id: "general" });

    const result = await executeAgentRun(job, makeJobCtx(), {
      provider: new StubProvider(),
      projectContext,
      dispatcher: new ToolDispatcher(),
      dataRoot,
      projectDir,
      model: "claude-haiku-4-20250514",
      agentSlug: "general",
    });

    const parsed = JSON.parse(result.result ?? "{}") as { inboxBranch?: string | null };
    expect(parsed.inboxBranch).toBeNull();

    const branches = execSync("git branch --list", { cwd: projectDir, encoding: "utf-8" });
    expect(branches).not.toContain("agents/general/");
  });
});
