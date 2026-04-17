import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JobContext, JobResult, JobRow } from "../jobs/types.js";
import type { ChatMessage, ProjectContext, Provider } from "../providers/types.js";
import type { ToolDispatcher } from "../tools/dispatcher.js";
import type { RunBudget, ToolCallContext } from "../tools/types.js";

/**
 * Agent execution loop.
 *
 * Orchestrates the conversation between the LLM provider and the
 * `kb.*` tool set. Each iteration:
 *
 *   1. Build system prompt from persona + loaded skills.
 *   2. Call provider.chat() with conversation history.
 *   3. On tool_use events → dispatch to tool handler, append result.
 *   4. On text events → stream to job_events.
 *   5. On done → check if the run should finalize.
 *
 * For interactive mode, the loop waits for user input between turns.
 * For autonomous mode, the loop runs until `agent.journal` is called
 * or the budget is exhausted.
 *
 * See docs/04-ai-and-agents.md §Agent execution loop.
 */

export interface ExecutorOptions {
  provider: Provider;
  projectContext: ProjectContext;
  dispatcher: ToolDispatcher;
  dataRoot: string;
  projectDir: string;
  model: string;
  agentSlug: string;
  /** Initial user prompt (for interactive mode). */
  prompt?: string;
  /** Budget caps for the run. */
  budget?: Partial<RunBudget>;
  /**
   * Interactive bridge — if provided, the executor waits for user
   * messages between turns instead of exiting after one turn.
   * Only meaningful for `mode='interactive'` jobs.
   */
  interactiveBridge?: import("./interactive-bridge.js").InteractiveBridge;
}

/**
 * Run a single agent execution loop as a job handler.
 *
 * Returns when the agent finalizes (journal for autonomous, or the
 * conversation ends for interactive).
 */
export async function executeAgentRun(
  job: JobRow,
  jobCtx: JobContext,
  opts: ExecutorOptions,
): Promise<JobResult> {
  const { provider, projectContext, dispatcher, dataRoot, projectDir, model, agentSlug } = opts;

  // Check if this agent uses inbox mode for autonomous runs.
  const reviewMode = job.mode === "autonomous" ? parseReviewMode(dataRoot, agentSlug) : null;
  const inboxBranch = reviewMode === "inbox" ? `agents/${agentSlug}/${job.id}` : null;

  // Create and checkout inbox staging branch if needed.
  if (inboxBranch) {
    try {
      execSync(`git checkout -b ${inboxBranch}`, {
        cwd: projectDir,
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch {
      // Branch creation failed — proceed on main.
    }
  }

  // Capture git HEAD before the run for commit-range tracking.
  let commitShaStart: string | null = null;
  try {
    commitShaStart = execSync("git rev-parse HEAD", {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch {
    // No git repo or no commits — skip.
  }

  const budget: RunBudget = {
    maxTokens: opts.budget?.maxTokens ?? 100_000,
    maxToolCalls: opts.budget?.maxToolCalls ?? 50,
    usedTokens: 0,
    usedToolCalls: 0,
  };

  // Build system prompt from persona.
  const systemPrompt = loadPersona(dataRoot, agentSlug);

  // Build tool context.
  const toolCtx: ToolCallContext = {
    projectId: jobCtx.projectId,
    agentSlug,
    jobId: job.id,
    emitEvent: jobCtx.emitEvent,
    dataRoot,
  };

  // Conversation history.
  const messages: ChatMessage[] = [];

  // Seed with the initial prompt if provided.
  const payload = JSON.parse(job.payload) as { prompt?: string };
  const initialPrompt = opts.prompt ?? payload.prompt;
  if (initialPrompt) {
    messages.push({ role: "user", content: initialPrompt });
    jobCtx.emitEvent("message.user", { text: initialPrompt });
  }

  const toolDefinitions = dispatcher.getDefinitions();

  // Main loop: call provider → handle events → loop on tool_use.
  let journalEmitted = false;
  let turnCount = 0;
  const maxTurns = 30; // Safety cap to prevent infinite loops.

  while (turnCount < maxTurns && !journalEmitted && !jobCtx.signal.aborted) {
    turnCount++;

    const stream = provider.chat(
      {
        model,
        systemPrompt,
        messages,
        tools: provider.supportsTools ? toolDefinitions : undefined,
        cacheSystemPrompt: provider.supportsPromptCache,
      },
      projectContext,
    );

    let assistantText = "";
    let pendingToolCalls: Array<{ id: string; name: string; input: unknown }> = [];

    for await (const event of stream) {
      if (jobCtx.signal.aborted) break;

      switch (event.type) {
        case "text":
          assistantText += event.text;
          jobCtx.emitEvent("message.text", { text: event.text });
          break;

        case "tool_use":
          pendingToolCalls.push({ id: event.id, name: event.name, input: event.input });
          break;

        case "done":
          if (event.usage) {
            budget.usedTokens += event.usage.inputTokens + event.usage.outputTokens;
            jobCtx.emitEvent("usage", event.usage);
          }
          break;

        case "error":
          jobCtx.emitEvent("message.error", { text: event.message });
          return { status: "failed", result: event.message };
      }
    }

    // Record the assistant's text response.
    if (assistantText) {
      messages.push({ role: "assistant", content: assistantText });
    }

    // If the provider returned tool calls, execute them and continue.
    if (pendingToolCalls.length > 0) {
      // Record tool_use messages in conversation history.
      for (const tc of pendingToolCalls) {
        messages.push({ role: "tool_use", id: tc.id, name: tc.name, input: tc.input });
      }

      // Execute each tool call sequentially.
      for (const tc of pendingToolCalls) {
        const { result, isError } = await dispatcher.call(tc.name, tc.input, toolCtx, budget);

        messages.push({ role: "tool_result", id: tc.id, content: result, is_error: isError });

        // Check if this was agent.journal — the finalization signal.
        if (tc.name === "agent.journal") {
          journalEmitted = true;
        }

        // Check if budget is exhausted after this call.
        if (budget.usedToolCalls >= budget.maxToolCalls || budget.usedTokens >= budget.maxTokens) {
          if (!journalEmitted) {
            jobCtx.emitEvent("budget.warning", {
              usedToolCalls: budget.usedToolCalls,
              usedTokens: budget.usedTokens,
            });
          }
          break;
        }
      }

      pendingToolCalls = [];
      // Continue the loop — the next iteration sends the tool results
      // back to the provider for the next turn.
      continue;
    }

    // No tool calls — the provider finished its turn with text only.
    // For autonomous mode without journal, this means the agent is done
    // but didn't journal. Emit a synthetic journal.
    if (job.mode === "autonomous" && !journalEmitted) {
      await dispatcher.call(
        "agent.journal",
        { text: assistantText || "(run completed without explicit journal entry)" },
        toolCtx,
        budget,
      );
      journalEmitted = true;
    }

    // Interactive mode: wait for the next user message via the bridge.
    // If no bridge is provided (e.g. tests), exit after one turn.
    if (job.mode === "interactive" && opts.interactiveBridge) {
      const nextMessage = await opts.interactiveBridge.waitForUserMessage();
      if (nextMessage === null) {
        // WS disconnected — pause the job, don't finalize.
        jobCtx.emitEvent("session.paused", { reason: "client_disconnected" });
        return { status: "done", result: "paused" };
      }
      messages.push({ role: "user", content: nextMessage });
      jobCtx.emitEvent("message.user", { text: nextMessage });
      continue; // Loop back to the next provider call.
    }

    // No bridge or autonomous mode — exit after this turn.
    break;
  }

  // Capture git HEAD after the run for commit-range tracking.
  let commitShaEnd: string | null = null;
  try {
    commitShaEnd = execSync("git rev-parse HEAD", {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch {
    // No commits produced — skip.
  }

  // Compute the list of files changed across the run so the AI panel's
  // run-finalized card and the inbox entry can show "N files changed".
  let filesChanged: string[] = [];
  if (commitShaStart && commitShaEnd && commitShaStart !== commitShaEnd) {
    try {
      const raw = execSync(`git diff --name-only ${commitShaStart} ${commitShaEnd}`, {
        cwd: projectDir,
        encoding: "utf-8",
        stdio: "pipe",
      }).trim();
      filesChanged = raw.length > 0 ? raw.split("\n") : [];
    } catch {
      // No diff available — leave the list empty.
    }
  }

  // Emit the run_finalized event so the AI panel can render a finalized
  // card (with commit range + revert button). The client's
  // `processJobEvent` maps this to a `run_finalized` message.
  if (commitShaStart && commitShaEnd) {
    jobCtx.emitEvent("run.finalized", {
      runId: job.id,
      agentSlug,
      commitShaStart,
      commitShaEnd,
      filesChanged,
    });
  }

  // Switch back to main if we were on an inbox staging branch.
  if (inboxBranch) {
    try {
      execSync("git checkout main", {
        cwd: projectDir,
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch {
      // Checkout back to main failed — log but don't fail the run.
    }
  }

  return {
    status: "done",
    result: JSON.stringify({
      outcome: journalEmitted ? "finalized" : "completed",
      commitShaStart,
      commitShaEnd,
      filesChanged,
      inboxBranch,
    }),
  };
}

/**
 * Load an agent's persona from its filesystem layout.
 * Falls back to a minimal system prompt if the persona file is missing.
 */
function loadPersona(dataRoot: string, slug: string): string {
  const personaPath = join(dataRoot, ".agents", slug, "persona.md");
  if (!existsSync(personaPath)) {
    return `You are the ${slug} assistant for this Ironlore knowledge base.`;
  }

  const raw = readFileSync(personaPath, "utf-8");

  // Strip YAML frontmatter — the persona body is the system prompt.
  const stripped = raw.replace(/^---[\s\S]*?^---\r?\n?/m, "").trim();
  return stripped || `You are the ${slug} assistant for this Ironlore knowledge base.`;
}

/**
 * Parse the persona's YAML frontmatter for `review_mode`.
 * Returns `"inbox"` if the persona declares it, `null` otherwise.
 */
function parseReviewMode(dataRoot: string, slug: string): "inbox" | null {
  const personaPath = join(dataRoot, ".agents", slug, "persona.md");
  if (!existsSync(personaPath)) return null;
  const raw = readFileSync(personaPath, "utf-8");
  const match = /^review_mode:\s*(\w+)/m.exec(raw);
  return match?.[1] === "inbox" ? "inbox" : null;
}
