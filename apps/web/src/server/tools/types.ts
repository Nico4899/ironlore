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

import type { DryRunBridge } from "../agents/dry-run-bridge.js";
import type { ToolDefinition } from "../providers/types.js";

export interface ToolCallContext {
  projectId: string;
  agentSlug: string;
  jobId: string;
  /** Emits a durable event to the job's event stream. */
  emitEvent: (kind: string, data: unknown) => void;
  /** Data root for the project (for StorageWriter access). */
  dataRoot: string;
  /**
   * **Airlock-wrapped** outbound fetch. Every tool that needs to
   * talk to the network — embedding providers, MCP HTTP servers,
   * connector skills, anything else — must use this fetch and not
   * import `fetchForProject` directly. After a Phase-11 Airlock
   * downgrade, this fetch throws `EgressDowngradedError` *before*
   * the network is touched, so a tool that bypasses it can leak
   * data the airlock was supposed to contain.
   *
   * The dispatcher injects this from the run's
   * `ProjectContext.fetch` (which the executor wraps with
   * `createAirlockSession`). For non-agent contexts (background
   * embedding worker, public HTTP API), construct a fetch via
   * `fetchForProject(projectDir, ...)` directly — the airlock is
   * scoped to agent runs, not server-wide infrastructure.
   */
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
  /**
   * Dry-run coordination bridge. Present only when the executor sets
   * up dry-run mode for a run (persona `review_mode: dry_run`). When
   * set, destructive tools route through the `diff_preview` →
   * approve/reject dance before mutating.
   */
  dryRunBridge?: DryRunBridge;
  /**
   * Airlock dynamic-egress downgrade hook (Phase-11). Set by the
   * executor when the run is operating with cross-project search
   * enabled (`IRONLORE_AIRLOCK=true` + the dispatcher carries
   * `kb.global_search`). The `kb.global_search` tool calls this
   * after returning any cross-project hit, which flips the
   * run's `ProjectContext.fetch` to throw `EgressDowngradedError`
   * for every subsequent network call.
   *
   * Absent for runs that aren't part of the Airlock surface —
   * the dispatcher never registers `kb.global_search` in those
   * configurations, so no tool ever consults the field.
   */
  downgradeEgress?: (reason: string) => void;
}

/**
 * Unified diff for a proposed mutation. `pageId` is the target page's
 * path; `diff` is a rendered `+`/`-` block ready for display by the
 * fallback AI-panel card.
 *
 * The structured trio (`op` + `blockId` + `currentMd` / `proposedMd`)
 * is what the in-editor inline-diff plugin reads to render
 * block-anchored ghost decorations. They're optional only because
 * older `computeDiff` impls predate them; every shipped kb mutation
 * tool fills them in. Splitting the structured surface from the
 * rendered string lets the AI-panel card stay text-only without
 * teaching it to re-render markdown.
 */
export interface DryRunDiff {
  pageId: string;
  diff: string;
  /** Operation kind — drives the inline plugin's decoration shape:
   *  `replace` strikes the old block + ghosts the new text after it,
   *  `insert` ghosts the new text after the anchor block,
   *  `delete` strikes the old block with no ghost. */
  op?: "replace" | "insert" | "delete";
  /** Target block ID — anchor for the inline decoration. For
   *  `insert_after` this is the block the new content lands AFTER. */
  blockId?: string;
  /** The block's current markdown text (replace/delete). Omitted for
   *  pure insertions where there's nothing to strike through. */
  currentMd?: string;
  /** The proposed markdown text (replace/insert). Omitted for
   *  deletions. */
  proposedMd?: string;
}

export interface ToolImplementation {
  /** The tool definition exposed to the provider. */
  definition: ToolDefinition;
  /** Execute the tool. Returns a string result for the model. */
  execute: (args: unknown, ctx: ToolCallContext) => Promise<string>;
  /**
   * Optional dry-run diff generator. Tools that implement this opt in
   * to the review flow: when the agent runs under `review_mode:
   * dry_run`, the dispatcher fetches the diff, emits a `diff_preview`
   * event, and waits for approval before running `execute`.
   *
   * Returns `null` when the proposed args would no-op or fail
   * validation (e.g., unknown block ID) — the dispatcher treats that
   * as "nothing to review" and falls through to `execute` for the
   * tool's normal error path.
   */
  computeDiff?: (args: unknown, ctx: ToolCallContext) => Promise<DryRunDiff | null>;
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
