/**
 * Tool system types.
 *
 * Every `kb.*` tool and `agent.journal` shares this contract. The
 * dispatcher maps tool names to implementations, validates args via
 * Zod, logs every call + result to `job_events`, and enforces per-run
 * budget caps (token cap, tool-call cap).
 *
 * See docs/04-ai-and-agents.md §The edit protocol.
 */

import type { ToolDefinition } from "../providers/types.js";

export interface ToolCallContext {
  projectId: string;
  agentSlug: string;
  jobId: string;
  /** Emits a durable event to the job's event stream. */
  emitEvent: (kind: string, data: unknown) => void;
  /** Data root for the project (for StorageWriter access). */
  dataRoot: string;
}

export interface ToolImplementation {
  /** The tool definition exposed to the provider. */
  definition: ToolDefinition;
  /** Execute the tool. Returns a string result for the model. */
  execute: (args: unknown, ctx: ToolCallContext) => Promise<string>;
}

/**
 * Budget state for a single agent run. Enforced by the dispatcher
 * before each tool call. When exhausted, the dispatcher returns a
 * budget-exhaustion signal instead of executing the tool.
 */
export interface RunBudget {
  maxTokens: number;
  maxToolCalls: number;
  usedTokens: number;
  usedToolCalls: number;
}
