import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "./anthropic.js";
import type { BatchHandle, ProjectContext } from "./types.js";

/**
 * Anthropic Message Batches API — provider-level tests against a
 * mock fetch. Covers the three round-trips the executor takes
 * once the worker hands off a batch-eligible run:
 *
 *   1. `submitBatch` → POST /v1/messages/batches
 *   2. `pollBatch` → GET /v1/messages/batches/<id>     (in_progress)
 *   3. `pollBatch` → GET /v1/messages/batches/<id>     (ended)
 *      → GET <results_url>                            (JSONL stream)
 *
 * The wire format is documented at
 * https://docs.anthropic.com/en/api/messages-batches.
 */

function ctxWith(fetchFn: typeof globalThis.fetch): ProjectContext {
  return {
    projectId: "main",
    fetch: fetchFn as ProjectContext["fetch"],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AnthropicProvider — submitBatch", () => {
  const provider = new AnthropicProvider({
    apiKey: "sk-test",
    baseUrl: "https://api.example.com",
  });

  it("declares supportsBatch = true", () => {
    expect(provider.supportsBatch).toBe(true);
  });

  it("POSTs a single-request payload with a custom_id we can demultiplex on later", async () => {
    const captured: { url: string; init?: RequestInit }[] = [];
    const result = await provider.submitBatch(
      {
        model: "claude-sonnet-4-6",
        systemPrompt: "you are a helper",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 1024,
      },
      ctxWith(async (url, init) => {
        captured.push({ url: String(url), init });
        return jsonResponse({ id: "msgbatch_01abc", processing_status: "in_progress" });
      }),
    );

    expect(result.provider).toBe("anthropic");
    expect(result.batchId).toBe("msgbatch_01abc");
    expect(result.requestId).toMatch(/^req_/);

    expect(captured).toHaveLength(1);
    const call = captured[0];
    expect(call?.url).toBe("https://api.example.com/v1/messages/batches");
    expect(call?.init?.method).toBe("POST");

    const headers = call?.init?.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-beta"]).toBe("message-batches-2024-09-24");

    const body = JSON.parse(String(call?.init?.body)) as {
      requests: Array<{ custom_id: string; params: Record<string, unknown> }>;
    };
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]?.custom_id).toBe(result.requestId);
    expect(body.requests[0]?.params.model).toBe("claude-sonnet-4-6");
    expect(body.requests[0]?.params.max_tokens).toBe(1024);
  });

  it("captures results_url into _provider when the submit response includes one", async () => {
    const result = await provider.submitBatch(
      {
        model: "claude-sonnet-4-6",
        systemPrompt: "x",
        messages: [{ role: "user", content: "y" }],
      },
      ctxWith(async () =>
        jsonResponse({
          id: "msgbatch_02xyz",
          processing_status: "in_progress",
          results_url: "https://api.example.com/v1/messages/batches/msgbatch_02xyz/results",
        }),
      ),
    );
    expect(result._provider?.resultsUrl).toBe(
      "https://api.example.com/v1/messages/batches/msgbatch_02xyz/results",
    );
  });

  it("throws on non-2xx with a server-side error", async () => {
    await expect(
      provider.submitBatch(
        {
          model: "claude-sonnet-4-6",
          systemPrompt: "x",
          messages: [{ role: "user", content: "y" }],
        },
        ctxWith(async () => new Response("rate limited", { status: 429 })),
      ),
    ).rejects.toThrow(/Anthropic batch submit 429/);
  });

  it("throws when the response body lacks a batch id", async () => {
    await expect(
      provider.submitBatch(
        {
          model: "claude-sonnet-4-6",
          systemPrompt: "x",
          messages: [{ role: "user", content: "y" }],
        },
        ctxWith(async () => jsonResponse({})),
      ),
    ).rejects.toThrow(/missing batch id/i);
  });
});

describe("AnthropicProvider — pollBatch", () => {
  const provider = new AnthropicProvider({
    apiKey: "sk-test",
    baseUrl: "https://api.example.com",
  });

  const handle: BatchHandle = {
    provider: "anthropic",
    batchId: "msgbatch_01abc",
    requestId: "req_test_abc",
  };

  it("returns status:in_progress while the batch is still running", async () => {
    const result = await provider.pollBatch(
      handle,
      ctxWith(async () => jsonResponse({ processing_status: "in_progress" })),
    );
    expect(result.status).toBe("in_progress");
    expect(result.result).toBeUndefined();
  });

  it("returns the assembled message + usage once status is `ended`", async () => {
    let call = 0;
    const result = await provider.pollBatch(
      handle,
      ctxWith(async () => {
        call++;
        if (call === 1) {
          return jsonResponse({
            processing_status: "ended",
            ended_at: "2026-04-25T12:00:00Z",
            results_url: "https://api.example.com/v1/messages/batches/msgbatch_01abc/results",
          });
        }
        // Second call → JSONL results stream. Two rows, only one
        // matches our request id; the other belongs to a sibling
        // request (defensive — we never submit > 1 in a single
        // batch today, but the demultiplexer should still pick out
        // the right one).
        const lines = [
          JSON.stringify({
            custom_id: "req_unrelated",
            result: {
              type: "succeeded",
              message: {
                content: [{ type: "text", text: "wrong reply" }],
                stop_reason: "end_turn",
                usage: { input_tokens: 10, output_tokens: 20 },
              },
            },
          }),
          JSON.stringify({
            custom_id: handle.requestId,
            result: {
              type: "succeeded",
              message: {
                content: [
                  { type: "text", text: "hello " },
                  { type: "text", text: "world" },
                ],
                stop_reason: "end_turn",
                usage: { input_tokens: 100, output_tokens: 50 },
              },
            },
          }),
        ];
        return new Response(`${lines.join("\n")}\n`, {
          status: 200,
          headers: { "Content-Type": "application/x-jsonl" },
        });
      }),
    );

    expect(result.status).toBe("completed");
    expect(result.result?.text).toBe("hello world");
    expect(result.result?.stopReason).toBe("end_turn");
    expect(result.result?.usage?.inputTokens).toBe(100);
    expect(result.result?.usage?.outputTokens).toBe(50);
  });

  it("flags expired batches with status:expired + error", async () => {
    const result = await provider.pollBatch(
      handle,
      ctxWith(async () => jsonResponse({ processing_status: "expired" })),
    );
    expect(result.status).toBe("expired");
    expect(result.error).toMatch(/expired/i);
  });

  it("returns status:failed with body on a non-2xx poll", async () => {
    const result = await provider.pollBatch(
      handle,
      ctxWith(async () => new Response("not found", { status: 404 })),
    );
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/Anthropic batch poll 404/);
  });

  it("rejects a handle from a different provider", async () => {
    await expect(
      provider.pollBatch(
        { provider: "openai", batchId: "batch_x", requestId: "r" },
        ctxWith(async () => jsonResponse({})),
      ),
    ).rejects.toThrow(/handle is for 'openai'/);
  });

  it("returns failed when an ended batch has no results_url", async () => {
    const result = await provider.pollBatch(
      handle,
      ctxWith(async () => jsonResponse({ processing_status: "ended" })),
    );
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/results_url/);
  });

  it("returns failed when the JSONL stream lacks our request id", async () => {
    let call = 0;
    const result = await provider.pollBatch(
      handle,
      ctxWith(async () => {
        call++;
        if (call === 1) {
          return jsonResponse({
            processing_status: "ended",
            results_url: "https://api.example.com/v1/messages/batches/msgbatch_01abc/results",
          });
        }
        // Stream that only contains an unrelated row.
        return new Response(
          `${JSON.stringify({
            custom_id: "req_unrelated",
            result: {
              type: "succeeded",
              message: { content: [{ type: "text", text: "x" }], stop_reason: "end_turn" },
            },
          })}\n`,
          { status: 200 },
        );
      }),
    );
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/did not contain our request id/);
  });

  it("propagates per-request errors surfaced in the result row", async () => {
    let call = 0;
    await expect(
      provider.pollBatch(
        handle,
        ctxWith(async () => {
          call++;
          if (call === 1) {
            return jsonResponse({
              processing_status: "ended",
              results_url: "https://api.example.com/v1/messages/batches/msgbatch_01abc/results",
            });
          }
          return new Response(
            `${JSON.stringify({
              custom_id: handle.requestId,
              result: {
                type: "errored",
                error: { type: "invalid_request_error", message: "bad model" },
              },
            })}\n`,
            { status: 200 },
          );
        }),
      ),
    ).rejects.toThrow(/bad model/);
  });
});
