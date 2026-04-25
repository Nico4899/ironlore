import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BackpressureController } from "../jobs/backpressure.js";
import type { JobContext, JobResult, JobRow } from "../jobs/types.js";
import type {
  BatchPollResult,
  ChatMessage,
  ProjectContext,
  Provider,
} from "../providers/types.js";
import type { ToolDispatcher } from "../tools/dispatcher.js";
import type { RunBudget, ToolCallContext } from "../tools/types.js";
import type { DryRunBridge } from "./dry-run-bridge.js";
import { loadSkills } from "./skill-loader.js";

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
  /**
   * Dry-run bridge — if provided, the executor attaches it to the
   * tool context so destructive tools route through the
   * diff_preview / approve flow. Only set when the agent's persona
   * declares `review_mode: dry_run`.
   */
  dryRunBridge?: DryRunBridge;
  /**
   * Adaptive backpressure controller. The executor acquires a slot
   * per provider.chat() call and releases it when the stream ends,
   * so the pool self-tunes under 429 pressure.
   */
  backpressure?: BackpressureController;
  /**
   * Async-batch tuning knobs — exposed for tests + operators with
   * unusual upstream latencies. Production defaults match the spec
   * (poll every 5 s, give up after 30 min). The persona opts in via
   * `batch: true` in frontmatter; without that flag these knobs are
   * dead code per run.
   */
  batchOptions?: {
    /** Override the persona's `batch:` decision (tests inject `true`). */
    forceOptIn?: boolean;
    /** Poll cadence in milliseconds; defaults to 5_000. */
    pollIntervalMs?: number;
    /** Hard deadline; defaults to 30 min. After that the run fails. */
    timeoutMs?: number;
  };
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

  // Parse the agent's review mode from persona frontmatter. `inbox`
  // runs land on a staging branch for approval; `dry_run` runs pause
  // on every destructive tool call and wait for user verdict.
  const reviewMode = parseReviewMode(dataRoot, agentSlug);
  const inboxBranch =
    job.mode === "autonomous" && reviewMode === "inbox" ? `agents/${agentSlug}/${job.id}` : null;
  // Dry-run bridge is attached whenever the persona declares it, even
  // for interactive sessions — the user explicitly wants a review step
  // regardless of job mode.
  const effectiveDryRun = reviewMode === "dry_run" ? opts.dryRunBridge : undefined;

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

  // Build system prompt from persona + any declared workflow skills.
  // Persona body is the voice; skills are prompt fragments the author
  // opted into via `skills: [...]` frontmatter. Resolution is
  // agent-local first, then `.shared/` — see skill-loader.ts.
  const persona = loadPersona(dataRoot, agentSlug);
  const skillsBlock = loadSkills(dataRoot, agentSlug, persona.skills);
  const systemPrompt = skillsBlock ? `${persona.body}${skillsBlock}` : persona.body;

  // Build tool context.
  const toolCtx: ToolCallContext = {
    projectId: jobCtx.projectId,
    agentSlug,
    jobId: job.id,
    emitEvent: jobCtx.emitEvent,
    dataRoot,
    ...(effectiveDryRun ? { dryRunBridge: effectiveDryRun } : {}),
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

  // ───────── Async-batch path (Phase-11 cost reduction) ─────────
  //
  // Persona opts in via `batch: true` in frontmatter. Only fires
  // for autonomous jobs (interactive runs always stream — the user
  // is at their desk). The provider must declare `supportsBatch`
  // *and* expose both `submitBatch` + `pollBatch`. When eligible
  // the executor takes a single round-trip with no tools, polls
  // until the batch ends (bounded by `timeoutMs`), and emits the
  // result as a normal `message.text` + `usage`.
  //
  // **Single-turn constraint.** Anthropic's batch API doesn't
  // support tool-use round-trips; we strip `tools` from the
  // submission. A persona that opts in without restructuring its
  // workflow skill (i.e. one that still expects to call
  // `kb.replace_block` mid-conversation) will produce a coherent
  // text reply but no mutations. Authors are responsible for
  // shaping their workflow before opting in — see
  // docs/04-ai-and-agents.md §Batch API.
  //
  // **Worker-release deferred.** This slice does not yet release
  // the worker lease while polling — the worker pool still pins a
  // slot for the full batch duration. Acceptable for the documented
  // wiki-gardener / bulk-reindex callers (batches typically
  // complete in seconds-to-minutes). The full lease-release
  // refactor is the audited follow-up.
  const batchOptIn = opts.batchOptions?.forceOptIn ?? parseBatchOptIn(dataRoot, agentSlug);
  const batchEligible =
    job.mode === "autonomous" &&
    batchOptIn &&
    provider.supportsBatch === true &&
    typeof provider.submitBatch === "function" &&
    typeof provider.pollBatch === "function";

  if (batchEligible) {
    return runBatchedTurn({
      provider,
      projectContext,
      jobCtx,
      model,
      systemPrompt,
      messages,
      budget,
      pollIntervalMs: opts.batchOptions?.pollIntervalMs ?? 5_000,
      timeoutMs: opts.batchOptions?.timeoutMs ?? 30 * 60_000,
    });
  }

  // Main loop: call provider → handle events → loop on tool_use.
  let journalEmitted = false;
  let turnCount = 0;
  const maxTurns = 30; // Safety cap to prevent infinite loops.

  while (turnCount < maxTurns && !journalEmitted && !jobCtx.signal.aborted) {
    turnCount++;

    // Adaptive backpressure gate: if the provider is at its cap
    // (after prior 429s halved it), wait briefly before retrying
    // rather than firing the request and compounding the throttle.
    if (opts.backpressure) {
      if (!opts.backpressure.canProceed(provider.name)) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue; // Retry the turn after backoff.
      }
      opts.backpressure.acquire(provider.name);
    }

    let assistantText = "";
    let pendingToolCalls: Array<{ id: string; name: string; input: unknown }> = [];
    let providerError: string | null = null;

    try {
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
            providerError = event.message;
            // Feed rate-limit signals back into backpressure. Any
            // provider error whose message mentions "429" or "rate"
            // halves the cap for that provider so concurrent runs
            // back off.
            if (
              opts.backpressure &&
              (/(^|\s)429/.test(event.message) || /rate.limit/i.test(event.message))
            ) {
              opts.backpressure.onRateLimit(provider.name);
            }
            break;
        }
        if (providerError) break;
      }
    } finally {
      if (opts.backpressure) opts.backpressure.release(provider.name);
    }

    if (providerError) {
      jobCtx.emitEvent("message.error", { text: providerError });
      return { status: "failed", result: providerError };
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
        const { result, isError } = await dispatcher.call(
          tc.name,
          tc.input,
          toolCtx,
          budget,
          tc.id,
        );

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

interface LoadedPersona {
  /** System-prompt body (frontmatter stripped). */
  body: string;
  /**
   * Skills declared under `skills:` in frontmatter, or null when the
   * field is absent. Empty array is meaningful — it means the persona
   * explicitly opts into zero skills. Resolved to file content by
   * `loadSkills()` at the callsite.
   */
  skills: string[] | null;
}

/**
 * Load an agent's persona from its filesystem layout.
 * Falls back to a minimal prompt and null skills if the persona file
 * is missing.
 */
function loadPersona(dataRoot: string, slug: string): LoadedPersona {
  const personaPath = join(dataRoot, ".agents", slug, "persona.md");
  if (!existsSync(personaPath)) {
    return {
      body: `You are the ${slug} assistant for this Ironlore knowledge base.`,
      skills: null,
    };
  }

  const raw = readFileSync(personaPath, "utf-8");

  // Strip YAML frontmatter — the persona body is the system prompt.
  const stripped = raw.replace(/^---[\s\S]*?^---\r?\n?/m, "").trim();
  const body = stripped || `You are the ${slug} assistant for this Ironlore knowledge base.`;

  return { body, skills: parseDeclaredSkills(raw) };
}

/**
 * Extract the `skills: [...]` list from persona frontmatter without
 * pulling in the full observability projection (the executor only
 * needs the skill names, not the UI rail's null-tolerant shape).
 */
function parseDeclaredSkills(raw: string): string[] | null {
  const match = /^---[^\n]*\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match?.[1]) return null;
  // Flow style: `skills: [a, b]` or `skills: [a.md, b.md]`.
  const flow = /^skills\s*:\s*\[([^\]]*)\]\s*$/m.exec(match[1]);
  if (flow?.[1] !== undefined) {
    return flow[1]
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  // Block style: `skills:\n  - a\n  - b`.
  const block = /^skills\s*:\s*\r?\n((?:[ \t]+-[^\n]*\r?\n?)+)/m.exec(match[1]);
  if (block?.[1]) {
    return block[1]
      .split(/\r?\n/)
      .map((line) => /^\s*-\s*(.+?)\s*$/.exec(line)?.[1])
      .filter((s): s is string => Boolean(s))
      .map((s) => s.replace(/^["']|["']$/g, ""));
  }
  return null;
}

/**
 * Parse the persona's YAML frontmatter for `review_mode`.
 * Returns `"inbox"` or `"dry_run"` if declared, `null` otherwise.
 */
function parseReviewMode(dataRoot: string, slug: string): "inbox" | "dry_run" | null {
  const personaPath = join(dataRoot, ".agents", slug, "persona.md");
  if (!existsSync(personaPath)) return null;
  const raw = readFileSync(personaPath, "utf-8");
  const match = /^review_mode:\s*(\w+)/m.exec(raw);
  if (match?.[1] === "inbox") return "inbox";
  if (match?.[1] === "dry_run") return "dry_run";
  return null;
}

/**
 * Parse the persona's YAML frontmatter for `batch: true`. The flag
 * is the per-persona opt-in to the Phase-11 async batch path
 * (Anthropic Message Batches, OpenAI batch when shipped).
 * Returns `false` when the field is absent, malformed, or
 * `false` — matches the documented default in
 * docs/04-ai-and-agents.md §Batch API.
 *
 * Exported so the executor + the observability projection (the
 * Settings → Agents card surface) can read the same answer.
 */
export function parseBatchOptIn(dataRoot: string, slug: string): boolean {
  const personaPath = join(dataRoot, ".agents", slug, "persona.md");
  if (!existsSync(personaPath)) return false;
  const raw = readFileSync(personaPath, "utf-8");
  // `^batch:` at the start of a line (no leading whitespace, so
  // an indented `  batch:` under another key isn't picked up).
  const match = /^batch\s*:\s*(true|false)\b/m.exec(raw);
  return match?.[1] === "true";
}

// ---------------------------------------------------------------------------
// Async-batch runner
// ---------------------------------------------------------------------------

interface BatchRunOpts {
  provider: Provider;
  projectContext: ProjectContext;
  jobCtx: JobContext;
  model: string;
  systemPrompt: string;
  messages: readonly ChatMessage[];
  budget: RunBudget;
  pollIntervalMs: number;
  timeoutMs: number;
}

/**
 * Submit the run to the provider's async batch queue + poll until
 * the batch ends. Mirrors the streaming path's event surface
 * (`message.text`, `usage`, `message.error`) so the AI panel +
 * job-events stream don't need to know which path produced the
 * reply. Tools are intentionally stripped — Anthropic's batch API
 * is single-turn.
 *
 * Returns immediately with `failed` when the provider doesn't
 * implement the batch surface (defensive — `executeAgentRun`
 * already gates on `supportsBatch`, but the helper is exported for
 * tests that drive it directly).
 */
async function runBatchedTurn(opts: BatchRunOpts): Promise<JobResult> {
  const { provider, projectContext, jobCtx, model, systemPrompt, messages, budget } = opts;
  if (!provider.submitBatch || !provider.pollBatch) {
    return { status: "failed", result: "Provider does not implement batch surface" };
  }

  jobCtx.emitEvent("batch.starting", {
    provider: provider.name,
    model,
    pollIntervalMs: opts.pollIntervalMs,
    timeoutMs: opts.timeoutMs,
  });

  let handle: Awaited<ReturnType<NonNullable<Provider["submitBatch"]>>>;
  try {
    handle = await provider.submitBatch(
      {
        model,
        systemPrompt,
        messages: [...messages],
        // No `tools` — single-turn, the model can't call mid-batch.
        cacheSystemPrompt: provider.supportsPromptCache,
      },
      projectContext,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    jobCtx.emitEvent("message.error", { text: `Batch submit failed: ${message}` });
    return { status: "failed", result: message };
  }

  jobCtx.emitEvent("batch.submitted", {
    provider: handle.provider,
    batchId: handle.batchId,
    requestId: handle.requestId,
  });

  // Bounded poll loop. We sleep `pollIntervalMs` between calls and
  // bail at `timeoutMs`. Cooperatively respects `jobCtx.signal`
  // (set when an admin cancels the job through the inbox).
  const deadline = Date.now() + opts.timeoutMs;
  let pollCount = 0;
  while (!jobCtx.signal.aborted) {
    pollCount++;
    let result: BatchPollResult;
    try {
      result = await provider.pollBatch(handle, projectContext);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      jobCtx.emitEvent("message.error", { text: `Batch poll failed: ${message}` });
      return { status: "failed", result: message };
    }

    jobCtx.emitEvent("batch.poll", {
      batchId: handle.batchId,
      status: result.status,
      pollCount,
    });

    if (result.status === "completed" && result.result) {
      const text = result.result.text;
      const usage = result.result.usage;
      if (text) {
        jobCtx.emitEvent("message.text", { text });
      }
      if (usage) {
        budget.usedTokens += usage.inputTokens + usage.outputTokens;
        jobCtx.emitEvent("usage", usage);
      }
      jobCtx.emitEvent("batch.completed", {
        batchId: handle.batchId,
        stopReason: result.result.stopReason,
      });
      return { status: "done", result: text };
    }

    if (result.status === "failed" || result.status === "expired") {
      const reason = result.error ?? `Batch ${result.status}`;
      jobCtx.emitEvent("message.error", { text: reason });
      return { status: "failed", result: reason };
    }

    // status === "in_progress" → wait + try again, unless we've
    // hit the wall-clock deadline. The deadline check is *after*
    // the first poll so a fast batch (returning `completed` on
    // the first call) doesn't spuriously time out at low budgets.
    if (Date.now() >= deadline) {
      jobCtx.emitEvent("message.error", {
        text: `Batch did not complete within ${opts.timeoutMs}ms`,
      });
      return { status: "failed", result: "batch timeout" };
    }
    await new Promise((resolve) => setTimeout(resolve, opts.pollIntervalMs));
  }

  // Aborted — propagate cooperatively so the worker pool sees a
  // clean shutdown rather than a hanging batch.
  jobCtx.emitEvent("batch.aborted", { batchId: handle.batchId });
  return { status: "failed", result: "aborted" };
}
