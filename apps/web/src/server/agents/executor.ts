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
  model: string;
  agentSlug: string;
  /** Initial user prompt (for interactive mode). */
  prompt?: string;
  /** Budget caps for the run. */
  budget?: Partial<RunBudget>;
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
  const { provider, projectContext, dispatcher, dataRoot, model, agentSlug } = opts;

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

    // For interactive mode, we'd wait for the next user message here.
    // That's wired in Step 8 via the WebSocket bridge.
    break;
  }

  return { status: "done", result: journalEmitted ? "finalized" : "completed" };
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
