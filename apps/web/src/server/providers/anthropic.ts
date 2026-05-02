import type {
  BatchHandle,
  BatchPollResult,
  BatchStatus,
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
  readonly supportsBatch = true;

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

  /**
   * Submit a single-request Message Batch — the cheap async path.
   * Anthropic's batch endpoint accepts an array of `requests`; we
   * always submit one (callers control batching at the run level,
   * not at the message level), with a stable `custom_id` we use to
   * demultiplex the JSONL results once the batch completes.
   *
   * Per-request 50 % discount applies; the SLA is "within 24 h" but
   * batches typically complete within a few minutes for low-volume
   * autonomous runs (wiki-gardener, bulk reindex). See
   * https://docs.anthropic.com/en/api/messages-batches for the
   * authoritative shape.
   */
  async submitBatch(opts: ChatOptions, ctx: ProjectContext): Promise<BatchHandle> {
    const url = `${this.baseUrl}/v1/messages/batches`;
    const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

    const params: Record<string, unknown> = {
      model: opts.model,
      max_tokens: opts.maxTokens ?? 4096,
      system: buildSystemBlock(opts),
      messages: convertMessages(opts.messages),
    };
    if (opts.temperature !== undefined) params.temperature = opts.temperature;
    // Tools are intentionally not forwarded — the batch path is
    // single-turn, no round-trips. Caller must omit or strip them.

    const body = {
      requests: [{ custom_id: requestId, params }],
    };

    const res = await ctx.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "message-batches-2024-09-24",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic batch submit ${res.status}: ${text}`);
    }
    const json = (await res.json()) as { id: string; results_url?: string };
    if (!json.id) {
      throw new Error("Anthropic batch submit: missing batch id in response");
    }
    return {
      provider: "anthropic",
      batchId: json.id,
      requestId,
      ...(json.results_url ? { _provider: { resultsUrl: json.results_url } } : {}),
    };
  }

  /**
   * Poll a submitted batch. While Anthropic's batch is `in_progress`
   * we return a status-only response; once `processing_status` is
   * `ended` we follow the `results_url` to fetch the JSONL stream
   * and assemble the single message we submitted into a `done`-shaped
   * result the caller can record back into the run transcript.
   */
  async pollBatch(handle: BatchHandle, ctx: ProjectContext): Promise<BatchPollResult> {
    if (handle.provider !== "anthropic") {
      throw new Error(`pollBatch: handle is for '${handle.provider}', not 'anthropic'`);
    }
    const statusUrl = `${this.baseUrl}/v1/messages/batches/${handle.batchId}`;
    const res = await ctx.fetch(statusUrl, {
      method: "GET",
      headers: {
        "X-API-Key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "message-batches-2024-09-24",
      },
    });
    if (!res.ok) {
      const text = await res.text();
      return {
        status: "failed",
        error: `Anthropic batch poll ${res.status}: ${text}`,
      };
    }
    const json = (await res.json()) as {
      processing_status?: string;
      ended_at?: string | null;
      results_url?: string | null;
      request_counts?: { errored?: number; expired?: number; canceled?: number };
    };
    const status = mapBatchStatus(json.processing_status);
    if (status === "in_progress") return { status };
    if (status === "expired") return { status, error: "Batch expired before completion" };

    // status === "completed" or "failed". Anthropic flags failures
    // via request_counts.errored > 0; we still try to fetch results
    // when the URL is present so a partial-success batch surfaces
    // its content.
    const resultsUrl = json.results_url;
    if (!resultsUrl) {
      return {
        status: "failed",
        error: "Batch ended without a results_url",
      };
    }
    const fetched = await this.fetchBatchResults(resultsUrl, handle.requestId, ctx);
    if (!fetched) {
      return {
        status: "failed",
        error: "Batch results JSONL did not contain our request id",
      };
    }
    return { status, result: fetched };
  }

  /**
   * Pull the JSONL results stream and locate our request's row.
   * The stream is line-delimited; each row has shape
   * `{ custom_id, result: { type, message? | error? } }`. We
   * concatenate `text` content blocks for the assistant's reply
   * and surface `usage` so cost telemetry stays accurate.
   */
  private async fetchBatchResults(
    resultsUrl: string,
    requestId: string,
    ctx: ProjectContext,
  ): Promise<{ text: string; usage?: TokenUsage; stopReason: string } | null> {
    const res = await ctx.fetch(resultsUrl, {
      method: "GET",
      headers: {
        "X-API-Key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "message-batches-2024-09-24",
      },
    });
    if (!res.ok) {
      throw new Error(`Anthropic batch results ${res.status}: ${await res.text()}`);
    }
    const body = await res.text();
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let row: {
        custom_id?: string;
        result?: {
          type?: string;
          message?: {
            content?: Array<{ type?: string; text?: string }>;
            stop_reason?: string;
            usage?: { input_tokens?: number; output_tokens?: number };
          };
          error?: { type?: string; message?: string };
        };
      };
      try {
        row = JSON.parse(trimmed);
      } catch {
        continue; // non-JSON line — Anthropic doesn't ship them, but ignore defensively
      }
      if (row.custom_id !== requestId) continue;
      if (row.result?.type === "errored" && row.result.error) {
        throw new Error(`Anthropic batch row errored: ${row.result.error.message ?? "unknown"}`);
      }
      const message = row.result?.message;
      if (!message) continue;
      const text = (message.content ?? [])
        .filter(
          (c): c is { type: "text"; text: string } =>
            c.type === "text" && typeof c.text === "string",
        )
        .map((c) => c.text)
        .join("");
      const usage: TokenUsage | undefined = message.usage
        ? {
            inputTokens: message.usage.input_tokens ?? 0,
            outputTokens: message.usage.output_tokens ?? 0,
          }
        : undefined;
      return {
        text,
        ...(usage ? { usage } : {}),
        stopReason: message.stop_reason ?? "end_turn",
      };
    }
    return null;
  }
}

function mapBatchStatus(raw: string | undefined): BatchStatus {
  // Anthropic uses `in_progress` and `ended` for the lifecycle;
  // we widen `ended` to `completed` (or `expired` when the batch
  // hit its 24 h cutoff). `failed` is reserved for transport
  // errors that came back with a non-2xx — those land in
  // `pollBatch` directly without going through this mapper.
  switch (raw) {
    case "in_progress":
      return "in_progress";
    case "ended":
      return "completed";
    case "expired":
    case "canceling":
    case "canceled":
      return "expired";
    default:
      return "in_progress";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wire-name translation for tool identifiers.
 *
 * Anthropic enforces `^[a-zA-Z0-9_-]{1,128}$` on tool names, which
 * rejects the dots we use as namespace separators (`kb.search`,
 * `mcp.<server>.<tool>`, `agent.journal`). We translate only at the
 * Anthropic wire boundary so the rest of the system — dispatcher,
 * persona frontmatter, journals, tests, docs — keeps the dotted
 * form. Substitution is deterministic, so we don't need a per-request
 * lookup table: any encoded tool name decodes back unambiguously as
 * long as no internal tool name contains the literal substring
 * `_dot_`. Current tools satisfy that invariant.
 *
 * Applied at three boundaries:
 *   - `convertTools` — outbound tool definitions in the request body
 *   - `convertMessages` — replayed prior `tool_use` blocks in multi-turn runs
 *   - `parseSSEStream` — inbound `tool_use.name` from the model
 */
const WIRE_DOT_SUBSTITUTE = "_dot_";

export function encodeToolNameForWire(internal: string): string {
  return internal.split(".").join(WIRE_DOT_SUBSTITUTE);
}

export function decodeToolNameFromWire(wire: string): string {
  return wire.split(WIRE_DOT_SUBSTITUTE).join(".");
}

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
        content: [
          {
            type: "tool_use",
            id: msg.id,
            name: encodeToolNameForWire(msg.name),
            input: msg.input,
          },
        ],
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
    name: encodeToolNameForWire(t.name),
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
            currentToolName = decodeToolNameFromWire(block.name as string);
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
            // No-arg tools (e.g. `kb.lint_orphans`) emit zero
            //  `input_json_delta` events, leaving currentToolInput as
            //  the empty string. Anthropic's wire schema requires
            //  `tool_use.input` to be an object on replay, so fall
            //  back to `{}` rather than to the raw string. The
            //  earlier code passed `""` through, which the *next*
            //  turn rejected with `Input should be an object` (400)
            //  the moment any subsequent tool call replayed history.
            const trimmed = currentToolInput.trim();
            let input: unknown = {};
            if (trimmed.length > 0) {
              try {
                input = JSON.parse(trimmed);
              } catch {
                // Malformed JSON for a tool that genuinely sent
                //  partial input — surface as a string envelope
                //  rather than `{}` so the error is debuggable, but
                //  wrap so it stays a valid object on replay.
                input = { _malformedToolInput: currentToolInput };
              }
            }
            // Anthropic also requires `tool_use.input` to be a JSON
            //  object specifically (not an array, not a primitive).
            //  If the model parsed a non-object (rare, but a
            //  partial-input edge case can produce it), wrap it.
            if (input === null || typeof input !== "object" || Array.isArray(input)) {
              input = { _value: input };
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
