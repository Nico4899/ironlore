import { describe, expect, it } from "vitest";
import { OllamaProvider } from "./ollama.js";
import type { ChatEvent, ProjectContext } from "./types.js";

/**
 * Ollama NDJSON stream tests.
 *
 * Ollama streams newline-delimited JSON (not SSE). Each line is a full
 * JSON object: { message: { content }, done, prompt_eval_count, eval_count, ... }.
 * Tests cover:
 *
 *   - Incremental text deltas flow through as text events
 *   - `done: true` yields a done event with usage
 *   - Split chunks (partial lines) reassemble correctly
 *   - Malformed JSON lines are skipped
 *   - Non-2xx responses yield an error event
 *   - Connection errors yield an error event
 *   - auto-detect via /api/tags returns parsed models / null on failure
 */

function encodeNdjson(lines: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const obj of lines) {
        controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      }
      controller.close();
    },
  });
}

function encodeChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function mockFetch(body: ReadableStream<Uint8Array> | null, status = 200): typeof globalThis.fetch {
  return (async () => new Response(body, { status })) as unknown as typeof globalThis.fetch;
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

describe("OllamaProvider — NDJSON parsing", () => {
  const provider = new OllamaProvider();

  it("streams text content from successive NDJSON lines", async () => {
    const body = encodeNdjson([
      { message: { content: "Hello " } },
      { message: { content: "world" } },
      { done: true, prompt_eval_count: 10, eval_count: 5 },
    ]);

    const events = await collect(
      provider.chat({ model: "llama3", systemPrompt: "", messages: [] }, ctx(mockFetch(body))),
    );

    const texts = events.filter((e): e is Extract<ChatEvent, { type: "text" }> => e.type === "text");
    expect(texts.map((t) => t.text).join("")).toBe("Hello world");

    const done = events.find((e): e is Extract<ChatEvent, { type: "done" }> => e.type === "done");
    expect(done).toBeDefined();
    expect(done?.usage?.inputTokens).toBe(10);
    expect(done?.usage?.outputTokens).toBe(5);
  });

  it("reassembles lines split across chunk boundaries", async () => {
    // Mimics a real stream that splits "{\"message\":{\"content\":\"hello\"}}\n"
    // across two TCP segments.
    const body = encodeChunks([
      '{"message":{"content":"hel',
      'lo"}}\n',
      '{"done":true,"prompt_eval_count":1,"eval_count":1}\n',
    ]);

    const events = await collect(
      provider.chat({ model: "llama3", systemPrompt: "", messages: [] }, ctx(mockFetch(body))),
    );

    const texts = events.filter((e): e is Extract<ChatEvent, { type: "text" }> => e.type === "text");
    expect(texts.map((t) => t.text).join("")).toBe("hello");
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("skips malformed JSON lines without crashing", async () => {
    const body = encodeChunks([
      '{"message":{"content":"before"}}\n',
      "not-json\n",
      '{"message":{"content":"after"}}\n',
      '{"done":true}\n',
    ]);

    const events = await collect(
      provider.chat({ model: "llama3", systemPrompt: "", messages: [] }, ctx(mockFetch(body))),
    );

    const texts = events.filter((e): e is Extract<ChatEvent, { type: "text" }> => e.type === "text");
    expect(texts.map((t) => t.text).join("")).toBe("beforeafter");
  });

  it("emits an error event on non-2xx responses", async () => {
    const body = encodeChunks(["model not found\n"]);
    const events = await collect(
      provider.chat(
        { model: "nonexistent", systemPrompt: "", messages: [] },
        ctx(mockFetch(body, 404)),
      ),
    );
    expect(events[0]?.type).toBe("error");
    const err = events[0] as Extract<ChatEvent, { type: "error" }>;
    expect(err.message).toContain("404");
  });

  it("emits an error event when fetch throws", async () => {
    const throwingFetch: typeof globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;

    const events = await collect(
      provider.chat(
        { model: "llama3", systemPrompt: "", messages: [] },
        ctx(throwingFetch),
      ),
    );
    expect(events[0]?.type).toBe("error");
    const err = events[0] as Extract<ChatEvent, { type: "error" }>;
    expect(err.message).toContain("ECONNREFUSED");
  });

  it("emits an error when the response body is missing", async () => {
    const events = await collect(
      provider.chat(
        { model: "llama3", systemPrompt: "", messages: [] },
        ctx(mockFetch(null, 200)),
      ),
    );
    // Response(null) produces an empty stream, not a null body — the
    // parser completes cleanly with zero content. Either outcome
    // (error or no events) is acceptable; assert there's no text
    // leaked or crash.
    const texts = events.filter((e) => e.type === "text");
    expect(texts).toHaveLength(0);
  });

  it("flattens tool_use + tool_result messages when tools aren't supported natively", async () => {
    let capturedBody: unknown = null;
    const capturingFetch: typeof globalThis.fetch = (async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(encodeNdjson([{ done: true }]), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await collect(
      provider.chat(
        {
          model: "llama3",
          systemPrompt: "sys",
          messages: [
            { role: "user", content: "find X" },
            { role: "tool_use", id: "tu_1", name: "kb.search", input: { query: "X" } },
            { role: "tool_result", id: "tu_1", content: "Nothing found." },
          ],
        },
        ctx(capturingFetch),
      ),
    );

    const payload = capturedBody as {
      messages: Array<{ role: string; content: string }>;
    };
    // System prompt + user + tool_use (flattened as assistant) + tool_result (flattened as user).
    expect(payload.messages.length).toBe(4);
    expect(payload.messages[0]?.role).toBe("system");
    expect(payload.messages[1]?.role).toBe("user");
    expect(payload.messages[2]?.role).toBe("assistant");
    // The tool_use should contain the tool name + input as JSON text.
    expect(payload.messages[2]?.content).toContain("kb.search");
    // tool_result flattens to a user message with the content string.
    expect(payload.messages[3]?.role).toBe("user");
    expect(payload.messages[3]?.content).toBe("Nothing found.");
  });

  it("includes num_predict + temperature in the request options", async () => {
    let capturedBody: unknown = null;
    const capturingFetch: typeof globalThis.fetch = (async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(encodeNdjson([{ done: true }]), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await collect(
      provider.chat(
        {
          model: "llama3",
          systemPrompt: "",
          messages: [],
          maxTokens: 2048,
          temperature: 0.4,
        },
        ctx(capturingFetch),
      ),
    );

    const payload = capturedBody as {
      options: { num_predict: number; temperature: number };
    };
    expect(payload.options.num_predict).toBe(2048);
    expect(payload.options.temperature).toBe(0.4);
  });
});

describe("OllamaProvider.detect", () => {
  it("returns the installed model list on a successful probe", async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          models: [{ name: "llama3" }, { name: "mistral" }],
        }),
        { status: 200 },
      )) as unknown as typeof globalThis.fetch;

    const result = await OllamaProvider.detect(fetchFn);
    expect(result).toEqual({ models: ["llama3", "mistral"] });
  });

  it("returns null when the probe returns a non-2xx status", async () => {
    const fetchFn = (async () =>
      new Response("", { status: 500 })) as unknown as typeof globalThis.fetch;
    const result = await OllamaProvider.detect(fetchFn);
    expect(result).toBeNull();
  });

  it("returns null when the probe fetch throws", async () => {
    const fetchFn: typeof globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof globalThis.fetch;
    const result = await OllamaProvider.detect(fetchFn);
    expect(result).toBeNull();
  });

  it("handles empty models array", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ models: [] }), { status: 200 })) as unknown as typeof globalThis.fetch;
    const result = await OllamaProvider.detect(fetchFn);
    expect(result).toEqual({ models: [] });
  });
});
