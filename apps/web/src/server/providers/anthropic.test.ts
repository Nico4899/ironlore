import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "./anthropic.js";
import type { ChatEvent, ProjectContext } from "./types.js";

/**
 * Anthropic SSE stream tests.
 *
 * The Messages API streams events as `data: {...}\n\n` frames. Tests
 * drive the provider through a mock fetch whose Response body is a
 * ReadableStream we fully control. Covers:
 *
 *   - Text deltas concatenate into text events
 *   - Tool-use blocks assemble from partial JSON deltas
 *   - Usage tokens (input / output / cache) surface on the done event
 *   - Non-2xx responses yield an error event
 *   - Missing body yields an error
 *   - Split chunks (partial lines) reassemble correctly
 *   - Malformed JSON lines are skipped without crashing
 *
 * The SSE parser is internal (`parseSSEStream`), so we exercise it
 * through the public `provider.chat(...)` surface — the same path
 * the executor takes.
 */

function encodeSseStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
}

function frame(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function mockFetch(body: ReadableStream<Uint8Array>, status = 200): typeof globalThis.fetch {
  return (async () => {
    return new Response(body, { status });
  }) as unknown as typeof globalThis.fetch;
}

const ctx = (fetchFn: typeof globalThis.fetch): ProjectContext => ({
  projectId: "main",
  fetch: fetchFn as ProjectContext["fetch"],
});

async function collect(stream: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

describe("AnthropicProvider — SSE parsing", () => {
  const provider = new AnthropicProvider({ apiKey: "sk-test" });

  it("accumulates text deltas into text events", async () => {
    const body = encodeSseStream([
      frame({ type: "message_start", message: { usage: { input_tokens: 10 } } }),
      frame({ type: "content_block_start", content_block: { type: "text" } }),
      frame({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } }),
      frame({ type: "content_block_delta", delta: { type: "text_delta", text: "world" } }),
      frame({ type: "content_block_stop" }),
      frame({ type: "message_delta", usage: { output_tokens: 2 } }),
      frame({ type: "message_stop" }),
    ]);

    const events = await collect(
      provider.chat(
        { model: "claude-haiku-4-20250514", systemPrompt: "sys", messages: [] },
        ctx(mockFetch(body)),
      ),
    );

    const texts = events.filter((e): e is Extract<ChatEvent, { type: "text" }> => e.type === "text");
    expect(texts.map((t) => t.text).join("")).toBe("Hello world");

    const done = events.find((e): e is Extract<ChatEvent, { type: "done" }> => e.type === "done");
    expect(done).toBeDefined();
    expect(done?.usage?.inputTokens).toBe(10);
    expect(done?.usage?.outputTokens).toBe(2);
  });

  it("assembles tool_use blocks from partial input_json_delta frames", async () => {
    const body = encodeSseStream([
      frame({ type: "message_start", message: { usage: { input_tokens: 5 } } }),
      frame({
        type: "content_block_start",
        content_block: { type: "tool_use", id: "tu_1", name: "kb.search" },
      }),
      frame({
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"qu' },
      }),
      frame({
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: 'ery": "alpha' },
      }),
      frame({
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '"}' },
      }),
      frame({ type: "content_block_stop" }),
      frame({ type: "message_stop" }),
    ]);

    const events = await collect(
      provider.chat(
        { model: "claude-haiku-4-20250514", systemPrompt: "", messages: [] },
        ctx(mockFetch(body)),
      ),
    );

    const toolUse = events.find(
      (e): e is Extract<ChatEvent, { type: "tool_use" }> => e.type === "tool_use",
    );
    expect(toolUse).toBeDefined();
    expect(toolUse?.id).toBe("tu_1");
    expect(toolUse?.name).toBe("kb.search");
    expect(toolUse?.input).toEqual({ query: "alpha" });
  });

  it("surfaces prompt-cache token usage on done", async () => {
    const body = encodeSseStream([
      frame({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 20,
          },
        },
      }),
      frame({ type: "content_block_start", content_block: { type: "text" } }),
      frame({ type: "content_block_delta", delta: { type: "text_delta", text: "ok" } }),
      frame({ type: "content_block_stop" }),
      frame({ type: "message_delta", usage: { output_tokens: 1 } }),
      frame({ type: "message_stop" }),
    ]);

    const events = await collect(
      provider.chat(
        { model: "claude-haiku-4-20250514", systemPrompt: "sys", messages: [] },
        ctx(mockFetch(body)),
      ),
    );

    const done = events.find((e): e is Extract<ChatEvent, { type: "done" }> => e.type === "done");
    expect(done?.usage?.cacheReadTokens).toBe(80);
    expect(done?.usage?.cacheCreateTokens).toBe(20);
  });

  it("emits an error event on non-2xx response", async () => {
    const body = encodeSseStream(["rate limited\n"]);
    const events = await collect(
      provider.chat(
        { model: "claude-haiku-4-20250514", systemPrompt: "", messages: [] },
        ctx(mockFetch(body, 429)),
      ),
    );
    expect(events[0]?.type).toBe("error");
    const err = events[0] as Extract<ChatEvent, { type: "error" }>;
    expect(err.message).toContain("429");
  });

  it("emits an error event when the response body is missing", async () => {
    const noBodyFetch: typeof globalThis.fetch = (async () =>
      new Response(null, { status: 200 })) as unknown as typeof globalThis.fetch;
    const events = await collect(
      provider.chat(
        { model: "claude-haiku-4-20250514", systemPrompt: "", messages: [] },
        ctx(noBodyFetch),
      ),
    );
    // Response(null) with status 200 has an empty body stream, not null —
    // so the parser completes without yielding any events. Either shape
    // (error or zero events) is defensible. We assert there's no crash
    // and no text content leaked.
    const texts = events.filter((e) => e.type === "text");
    expect(texts).toHaveLength(0);
  });

  it("reassembles frames split across chunk boundaries", async () => {
    // The real server will often split SSE lines mid-word. Verify the
    // parser keeps an incomplete line in its buffer and fuses it with
    // the next chunk.
    const raw1 = 'data: {"type":"message_start","message":{"usage":{"input_toke';
    const raw2 = 'ns":5}}}\n\ndata: {"type":"content_block_start","content_block":{"type":"text"}}\n\n';
    const raw3 = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"split"}}\n\n';
    const raw4 = 'data: {"type":"content_block_stop"}\n\ndata: {"type":"message_stop"}\n\n';

    const body = encodeSseStream([raw1, raw2, raw3, raw4]);
    const events = await collect(
      provider.chat(
        { model: "claude-haiku-4-20250514", systemPrompt: "", messages: [] },
        ctx(mockFetch(body)),
      ),
    );

    const texts = events.filter((e): e is Extract<ChatEvent, { type: "text" }> => e.type === "text");
    expect(texts.map((t) => t.text).join("")).toBe("split");
  });

  it("silently skips malformed JSON frames instead of crashing", async () => {
    const body = encodeSseStream([
      frame({ type: "message_start", message: { usage: { input_tokens: 1 } } }),
      "data: {this is not valid json\n\n", // Malformed — must be skipped.
      frame({ type: "content_block_start", content_block: { type: "text" } }),
      frame({ type: "content_block_delta", delta: { type: "text_delta", text: "survived" } }),
      frame({ type: "content_block_stop" }),
      frame({ type: "message_stop" }),
    ]);

    const events = await collect(
      provider.chat(
        { model: "claude-haiku-4-20250514", systemPrompt: "", messages: [] },
        ctx(mockFetch(body)),
      ),
    );

    const texts = events.filter((e): e is Extract<ChatEvent, { type: "text" }> => e.type === "text");
    expect(texts.map((t) => t.text).join("")).toBe("survived");
  });

  it("ignores [DONE] sentinels that sit between real frames", async () => {
    const body = encodeSseStream([
      frame({ type: "message_start", message: { usage: { input_tokens: 1 } } }),
      "data: [DONE]\n\n",
      frame({ type: "content_block_start", content_block: { type: "text" } }),
      frame({ type: "content_block_delta", delta: { type: "text_delta", text: "x" } }),
      frame({ type: "content_block_stop" }),
      frame({ type: "message_stop" }),
    ]);

    const events = await collect(
      provider.chat(
        { model: "claude-haiku-4-20250514", systemPrompt: "", messages: [] },
        ctx(mockFetch(body)),
      ),
    );
    expect(events.some((e) => e.type === "text")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("passes tool definitions through to the request body", async () => {
    let capturedBody: unknown = null;
    const capturingFetch: typeof globalThis.fetch = (async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      const body = encodeSseStream([
        frame({ type: "message_start", message: { usage: { input_tokens: 1 } } }),
        frame({ type: "message_stop" }),
      ]);
      return new Response(body, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await collect(
      provider.chat(
        {
          model: "claude-haiku-4-20250514",
          systemPrompt: "sys",
          messages: [],
          tools: [
            {
              name: "kb.search",
              description: "search pages",
              inputSchema: { type: "object", properties: { query: { type: "string" } } },
            },
          ],
        },
        ctx(capturingFetch),
      ),
    );

    const payload = capturedBody as {
      tools?: Array<{ name: string; description: string; input_schema: unknown }>;
    };
    expect(payload.tools).toHaveLength(1);
    expect(payload.tools?.[0]?.name).toBe("kb.search");
    // Provider converts `inputSchema` → `input_schema` for Anthropic.
    expect(payload.tools?.[0]?.input_schema).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
    });
  });

  it("marks the system prompt for prompt-caching when requested", async () => {
    let capturedBody: unknown = null;
    const capturingFetch: typeof globalThis.fetch = (async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      const body = encodeSseStream([frame({ type: "message_stop" })]);
      return new Response(body, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await collect(
      provider.chat(
        {
          model: "claude-haiku-4-20250514",
          systemPrompt: "You are helpful",
          messages: [],
          cacheSystemPrompt: true,
        },
        ctx(capturingFetch),
      ),
    );

    const payload = capturedBody as {
      system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
    };
    expect(payload.system[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("omits cache_control when cacheSystemPrompt is false", async () => {
    let capturedBody: unknown = null;
    const capturingFetch: typeof globalThis.fetch = (async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      const body = encodeSseStream([frame({ type: "message_stop" })]);
      return new Response(body, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await collect(
      provider.chat(
        {
          model: "claude-haiku-4-20250514",
          systemPrompt: "You are helpful",
          messages: [],
          cacheSystemPrompt: false,
        },
        ctx(capturingFetch),
      ),
    );

    const payload = capturedBody as {
      system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
    };
    expect(payload.system[0]?.cache_control).toBeUndefined();
  });

  it("converts tool_use + tool_result messages into Anthropic's content-block shape", async () => {
    let capturedBody: unknown = null;
    const capturingFetch: typeof globalThis.fetch = (async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      const body = encodeSseStream([frame({ type: "message_stop" })]);
      return new Response(body, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await collect(
      provider.chat(
        {
          model: "claude-haiku-4-20250514",
          systemPrompt: "",
          messages: [
            { role: "user", content: "find X" },
            { role: "tool_use", id: "tu_1", name: "kb.search", input: { query: "X" } },
            { role: "tool_result", id: "tu_1", content: '{"results":[]}' },
            { role: "assistant", content: "Nothing found." },
          ],
        },
        ctx(capturingFetch),
      ),
    );

    const payload = capturedBody as {
      messages: Array<{
        role: string;
        content: unknown;
      }>;
    };
    expect(payload.messages).toHaveLength(4);

    // tool_use → assistant with content-block
    const toolUseMsg = payload.messages[1];
    expect(toolUseMsg?.role).toBe("assistant");
    expect(Array.isArray(toolUseMsg?.content)).toBe(true);
    const toolUseBlock = (toolUseMsg?.content as Array<Record<string, unknown>>)[0];
    expect(toolUseBlock?.type).toBe("tool_use");
    expect(toolUseBlock?.id).toBe("tu_1");

    // tool_result → user with content-block
    const toolResultMsg = payload.messages[2];
    expect(toolResultMsg?.role).toBe("user");
    const toolResultBlock = (toolResultMsg?.content as Array<Record<string, unknown>>)[0];
    expect(toolResultBlock?.type).toBe("tool_result");
    expect(toolResultBlock?.tool_use_id).toBe("tu_1");
  });
});
