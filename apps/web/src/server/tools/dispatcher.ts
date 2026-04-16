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
