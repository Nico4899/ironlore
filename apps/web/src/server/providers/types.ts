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

  chat(opts: ChatOptions, ctx: ProjectContext): AsyncIterable<ChatEvent>;
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
