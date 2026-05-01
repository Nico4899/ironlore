import type { RunBudget, ToolCallContext, ToolImplementation } from "./types.js";

/**
 * Tool dispatcher.
 *
 * Maps tool names to implementations, enforces the per-run budget
 * (token cap + tool-call cap), and logs every call + result to the
 * job's durable event stream.
 *
 * See docs/04-ai-and-agents.md §The edit protocol and
 * docs/05-jobs-and-security.md §Safety rails.
 */
export class ToolDispatcher {
  private tools = new Map<string, ToolImplementation>();

  register(tool: ToolImplementation): void {
    this.tools.set(tool.definition.name, tool);
  }

  getDefinitions(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    return [...this.tools.values()].map((t) => t.definition);
  }

  /**
   * Execute a tool call. Returns the result string for the model.
   *
   * If the budget is exhausted, returns an error message instead of
   * executing — the agent's next move should be `agent.journal` to
   * finalize the run.
   */
  async call(
    name: string,
    args: unknown,
    ctx: ToolCallContext,
    budget: RunBudget,
    /**
     * Tool-call ID from the provider's tool_use event. Used to route
     * dry-run verdicts back to the right pending dispatcher call.
     * When omitted, a synthetic ID is generated — tests and one-shot
     * invocations don't need to wire the provider's ID through.
     */
    toolCallId?: string,
  ): Promise<{ result: string; isError: boolean }> {
    // Budget gate.
    if (budget.usedToolCalls >= budget.maxToolCalls) {
      ctx.emitEvent("budget.exhausted", { reason: "tool_call_cap", used: budget.usedToolCalls });
      return {
        result: `Budget exhausted: ${budget.usedToolCalls}/${budget.maxToolCalls} tool calls used. Finalize with agent.journal.`,
        isError: true,
      };
    }

    const tool = this.tools.get(name);
    if (!tool) {
      return { result: `Unknown tool: ${name}`, isError: true };
    }

    budget.usedToolCalls++;

    // Log the call before execution.
    ctx.emitEvent("tool.call", { tool: name, args });

    // Dry-run gate: if the tool opts in (via `computeDiff`) and the
    // agent is running under `review_mode: dry_run`, show the user
    // the diff and wait for approval before executing.
    if (ctx.dryRunBridge && tool.computeDiff) {
      const diffId = toolCallId ?? `dryrun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        const diff = await tool.computeDiff(args, ctx);
        if (diff) {
          ctx.emitEvent("diff_preview", {
            toolCallId: diffId,
            tool: name,
            pageId: diff.pageId,
            diff: diff.diff,
            // Phase-11 inline-diff plugin: structured fields are
            //  forwarded to the WS event so the client-side editor
            //  can render block-anchored ghost decorations on the
            //  in-editor surface when the user is on the target page.
            //  Older clients keep using `diff` as before.
            ...(diff.op !== undefined ? { op: diff.op } : {}),
            ...(diff.blockId !== undefined ? { blockId: diff.blockId } : {}),
            ...(diff.currentMd !== undefined ? { currentMd: diff.currentMd } : {}),
            ...(diff.proposedMd !== undefined ? { proposedMd: diff.proposedMd } : {}),
          });
          const verdict = await ctx.dryRunBridge.awaitVerdict(diffId);
          if (verdict === "reject" || verdict === "timeout") {
            const reason =
              verdict === "timeout" ? "no response within review window" : "user rejected change";
            const resultPayload = JSON.stringify({
              ok: false,
              skipped: true,
              reason,
            });
            ctx.emitEvent("tool.result", { tool: name, result: resultPayload });
            return { result: resultPayload, isError: false };
          }
          // verdict === "approve" → fall through to execute normally.
        }
      } catch (err) {
        // computeDiff failed — surface as a tool error and skip execute
        // so the agent sees a structured response instead of a hang.
        const message = err instanceof Error ? err.message : String(err);
        ctx.emitEvent("tool.error", { tool: name, error: message });
        return { result: `Tool error: ${message}`, isError: true };
      }
    }

    try {
      const result = await tool.execute(args, ctx);
      ctx.emitEvent("tool.result", { tool: name, result });
      return { result, isError: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.emitEvent("tool.error", { tool: name, error: message });
      return { result: `Tool error: ${message}`, isError: true };
    }
  }
}
