import type {
  ChatEvent,
  ChatMessage,
  ChatOptions,
  ProjectContext,
  Provider,
  TokenUsage,
  ToolDefinition,
} from "./types.js";

/**
 * Anthropic API provider.
 *
 * Reference implementation with prompt caching enabled. Uses the
 * project's egress-aware `fetch` for all HTTP calls so the per-project
 * allowlist is enforced at the network choke point.
 *
 * See docs/04-ai-and-agents.md §Provider abstraction.
 */
export class AnthropicProvider implements Provider {
  readonly name = "anthropic" as const;
  readonly supportsTools = true;
  readonly supportsPromptCache = true;

  private apiKey: string;
  private baseUrl: string;

  constructor(opts: { apiKey: string; baseUrl?: string }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.anthropic.com";
  }

  async *chat(opts: ChatOptions, ctx: ProjectContext): AsyncIterable<ChatEvent> {
    const url = `${this.baseUrl}/v1/messages`;

    const systemBlock = buildSystemBlock(opts);
    const messages = convertMessages(opts.messages);
    const tools = opts.tools ? convertTools(opts.tools) : undefined;

    const body: Record<string, unknown> = {
      model: opts.model,
      max_tokens: opts.maxTokens ?? 4096,
      system: systemBlock,
      messages,
      stream: true,
    };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (tools && tools.length > 0) body.tools = tools;

    const res = await ctx.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.apiKey,
        "anthropic-version": "2023-06-01",
        // Enable streaming for the Messages API.
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      yield { type: "error", message: `Anthropic API ${res.status}: ${text}` };
      return;
    }

    if (!res.body) {
      yield { type: "error", message: "Anthropic API returned no body" };
      return;
    }

    // Parse the SSE stream.
    yield* parseSSEStream(res.body);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSystemBlock(opts: ChatOptions): unknown[] {
  const block: Record<string, unknown> = {
    type: "text",
    text: opts.systemPrompt,
  };

  // Prompt caching: mark the system prompt for caching so subsequent
  // calls within the same heartbeat reuse the cached input tokens.
  if (opts.cacheSystemPrompt !== false) {
    block.cache_control = { type: "ephemeral" };
  }

  return [block];
}

function convertMessages(messages: ChatMessage[]): Array<{ role: string; content: unknown }> {
  return messages.map((msg) => {
    if (msg.role === "tool_use") {
      return {
        role: "assistant",
        content: [{ type: "tool_use", id: msg.id, name: msg.name, input: msg.input }],
      };
    }
    if (msg.role === "tool_result") {
      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.id,
            content: msg.content,
            is_error: msg.is_error ?? false,
          },
        ],
      };
    }
    return { role: msg.role, content: msg.content };
  });
}

function convertTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

/**
 * Parse an Anthropic SSE stream into ChatEvent objects.
 *
 * The Messages API streams events as `data: {...}\n\n` lines. We
 * process them incrementally to yield tool-use and text events as
 * they arrive.
 */
async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncIterable<ChatEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentToolId = "";
  let currentToolName = "";
  let currentToolInput = "";
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep the last (possibly incomplete) line in the buffer.
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const json = line.slice(6).trim();
        if (json === "[DONE]") continue;

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(json) as Record<string, unknown>;
        } catch {
          continue;
        }

        const eventType = event.type as string;

        if (eventType === "content_block_start") {
          const block = event.content_block as Record<string, unknown>;
          if (block?.type === "tool_use") {
            currentToolId = block.id as string;
            currentToolName = block.name as string;
            currentToolInput = "";
          }
        }

        if (eventType === "content_block_delta") {
          const delta = event.delta as Record<string, unknown>;
          if (delta?.type === "text_delta") {
            yield { type: "text", text: delta.text as string };
          }
          if (delta?.type === "input_json_delta") {
            currentToolInput += delta.partial_json as string;
          }
        }

        if (eventType === "content_block_stop") {
          if (currentToolId) {
            let input: unknown = {};
            try {
              input = JSON.parse(currentToolInput);
            } catch {
              // Malformed tool input — pass as string.
              input = currentToolInput;
            }
            yield { type: "tool_use", id: currentToolId, name: currentToolName, input };
            currentToolId = "";
            currentToolName = "";
            currentToolInput = "";
          }
        }

        if (eventType === "message_delta") {
          const msgUsage = event.usage as Record<string, number> | undefined;
          if (msgUsage) {
            usage.outputTokens = msgUsage.output_tokens ?? usage.outputTokens;
          }
        }

        if (eventType === "message_start") {
          const msg = event.message as Record<string, unknown> | undefined;
          const msgUsage = msg?.usage as Record<string, number> | undefined;
          if (msgUsage) {
            usage.inputTokens = msgUsage.input_tokens ?? 0;
            usage.cacheReadTokens = msgUsage.cache_read_input_tokens;
            usage.cacheCreateTokens = msgUsage.cache_creation_input_tokens;
          }
        }

        if (eventType === "message_stop") {
          yield {
            type: "done",
            stopReason: (event.message as Record<string, string>)?.stop_reason ?? "end_turn",
            usage,
          };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
