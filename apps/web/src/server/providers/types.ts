/**
 * Provider abstraction — one interface, many backends.
 *
 * See docs/04-ai-and-agents.md §Provider abstraction for the full
 * design. Every provider receives a `ProjectContext` whose `fetch` is
 * the only network handle it gets — routed through the per-project
 * egress middleware so allowlists are enforced at the choke point.
 */

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export type ProviderId = "anthropic" | "openai" | "ollama" | "claude-cli";

export interface Provider {
  readonly name: ProviderId;
  readonly supportsTools: boolean;
  readonly supportsPromptCache: boolean;
  /**
   * Whether this provider exposes an async-batch API (Anthropic /
   * OpenAI ship one with a ~50% discount and a 24h SLA). When
   * `false`, calling `submitBatch` should throw — the executor's
   * batch path checks this flag before opting in.
   */
  readonly supportsBatch?: boolean;

  chat(opts: ChatOptions, ctx: ProjectContext): AsyncIterable<ChatEvent>;

  /**
   * Submit a single-turn message to the provider's async batch
   * queue. Returns a handle the caller persists to a job row;
   * `pollBatch` consumes the handle to check completion. Optional
   * — providers that don't implement async batch (Ollama, the
   * Claude CLI) leave this undefined.
   *
   * Per docs/04-ai-and-agents.md §Batch API (Phase 11): batch is
   * only viable for runs whose entire conversation is known
   * up-front (no tool-use round-trips), so the caller is
   * responsible for ensuring `opts.tools` is omitted before
   * handing off to this method.
   */
  submitBatch?: (opts: ChatOptions, ctx: ProjectContext) => Promise<BatchHandle>;

  /**
   * Poll the status of a submitted batch. Returns the lifecycle
   * state plus, when the batch has finished, the assembled
   * single-message result + usage. A failed / expired batch comes
   * back with `error` set so the caller can fail the job
   * gracefully.
   */
  pollBatch?: (handle: BatchHandle, ctx: ProjectContext) => Promise<BatchPollResult>;
}

export interface ProjectContext {
  projectId: string;
  /**
   * Egress-aware fetch routed through `fetchForProject`. The provider
   * must use this instead of `globalThis.fetch` — lint enforces it.
   */
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
}

// ---------------------------------------------------------------------------
// Chat options
// ---------------------------------------------------------------------------

export interface ChatOptions {
  model: string;
  systemPrompt: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  /** Enable prompt caching for the system prompt (Anthropic / Gemini). */
  cacheSystemPrompt?: boolean;
}

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "tool_use"; id: string; name: string; input: unknown }
  | { role: "tool_result"; id: string; content: string; is_error?: boolean };

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's input parameters. */
  inputSchema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Chat events (streamed)
// ---------------------------------------------------------------------------

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "done"; stopReason: string; usage?: TokenUsage }
  | { type: "error"; message: string };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
}

// ---------------------------------------------------------------------------
// Async-batch API
// ---------------------------------------------------------------------------

/**
 * Opaque handle returned by `submitBatch`. The executor persists
 * this to the `jobs` table (alongside the run's progress) and
 * passes it back to `pollBatch` until the result lands. Provider
 * + ID together identify the batch — no other field is meaningful
 * to the caller; provider-specific blobs go in `_provider`.
 */
export interface BatchHandle {
  provider: ProviderId;
  /** Provider-issued batch ID (Anthropic `msgbatch_…`, OpenAI `batch_…`). */
  batchId: string;
  /** Custom request ID submitted alongside the batch (we always
   *  send a single request per batch) — used to demultiplex the
   *  results JSONL when the provider returns one row per request. */
  requestId: string;
  /** Provider-specific opaque metadata (e.g. results URL) the
   *  executor doesn't need to interpret. JSON-serializable. */
  _provider?: Record<string, unknown>;
}

export type BatchStatus = "in_progress" | "completed" | "failed" | "expired";

export interface BatchPollResult {
  status: BatchStatus;
  /** Populated when `status === "completed"`. */
  result?: { text: string; usage?: TokenUsage; stopReason: string };
  /** Populated when `status === "failed"` / `"expired"`. */
  error?: string;
}
