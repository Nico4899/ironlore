import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatOptions, ProjectContext, Provider } from "../providers/types.js";
import { generateChunkContext } from "./contextual-retrieval.js";

/**
 * Stub provider that records the last `ChatOptions` it received and
 * returns a scripted text-stream. Errors mid-stream and timeouts are
 * the two failure modes we want to assert never escape the helper.
 */
class StubProvider implements Provider {
  readonly name = "anthropic" as const;
  readonly supportsTools = true;
  readonly supportsPromptCache = true;
  readonly supportsBatch = false;

  lastOpts: ChatOptions | null = null;
  scripted: ChatEvent[] = [];
  delayMs = 0;
  callCount = 0;

  async *chat(opts: ChatOptions, _ctx: ProjectContext): AsyncIterable<ChatEvent> {
    this.callCount++;
    this.lastOpts = opts;
    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.delayMs);
        if (typeof t.unref === "function") t.unref();
      });
    }
    for (const ev of this.scripted) yield ev;
  }
}

const noopCtx: ProjectContext = {
  projectId: "test",
  fetch: async () => new Response(),
};

describe("generateChunkContext", () => {
  it("assembles the source page + chunk into the system + user prompt and returns the streamed text", async () => {
    const provider = new StubProvider();
    provider.scripted = [
      { type: "text", text: "Introduces the comparison framework that the rest of " },
      { type: "text", text: "the page elaborates on. Establishes Q3 as the time frame." },
      { type: "done", stopReason: "end_turn" },
    ];

    const out = await generateChunkContext(provider, noopCtx, {
      sourcePage: "# Title\n\nQ3 results follow.\n\n[chunk-here]",
      chunkText: "Revenue grew 12% year-over-year.",
      timeoutMs: 1_000,
    });

    expect(out).toBe(
      "Introduces the comparison framework that the rest of the page elaborates on. Establishes Q3 as the time frame.",
    );
    expect(provider.callCount).toBe(1);
    expect(provider.lastOpts?.systemPrompt).toContain("Q3 results follow.");
    expect(provider.lastOpts?.systemPrompt).toContain("Source document begins");
    expect(provider.lastOpts?.messages[0]?.content).toContain("Revenue grew 12%");
    // Prompt-cache flag follows the provider's capability.
    expect(provider.lastOpts?.cacheSystemPrompt).toBe(true);
  });

  it("returns empty string on a provider-emitted error event (never throws)", async () => {
    const provider = new StubProvider();
    provider.scripted = [
      { type: "text", text: "partial..." },
      { type: "error", message: "rate limited" },
    ];

    const out = await generateChunkContext(provider, noopCtx, {
      sourcePage: "page",
      chunkText: "chunk",
      timeoutMs: 1_000,
    });
    expect(out).toBe("");
  });

  it("returns empty string when the provider call times out", async () => {
    const provider = new StubProvider();
    provider.delayMs = 200;
    provider.scripted = [
      { type: "text", text: "should not arrive" },
      { type: "done", stopReason: "end_turn" },
    ];

    const out = await generateChunkContext(provider, noopCtx, {
      sourcePage: "page",
      chunkText: "chunk",
      timeoutMs: 50,
    });
    expect(out).toBe("");
  });

  it("trims an oversized source page so the cache prefix stays bounded", async () => {
    const provider = new StubProvider();
    provider.scripted = [{ type: "done", stopReason: "end_turn" }];

    const huge = "x".repeat(60_000);
    await generateChunkContext(provider, noopCtx, {
      sourcePage: huge,
      chunkText: "chunk",
      timeoutMs: 1_000,
    });
    const sys = provider.lastOpts?.systemPrompt ?? "";
    expect(sys).toContain("[…page truncated for context-prefix budget]");
    // Truncation is at the 40k character budget, not the original 60k.
    expect(sys.length).toBeLessThan(huge.length);
  });

  it("returns empty when no done event arrives but the stream ends naturally", async () => {
    const provider = new StubProvider();
    provider.scripted = []; // empty stream
    const out = await generateChunkContext(provider, noopCtx, {
      sourcePage: "page",
      chunkText: "chunk",
      timeoutMs: 1_000,
    });
    expect(out).toBe("");
  });

  it("disables prompt cache for providers that don't support it", async () => {
    const provider = new StubProvider();
    Object.defineProperty(provider, "supportsPromptCache", { value: false });
    provider.scripted = [
      { type: "text", text: "context" },
      { type: "done", stopReason: "end_turn" },
    ];
    await generateChunkContext(provider, noopCtx, {
      sourcePage: "page",
      chunkText: "chunk",
      timeoutMs: 1_000,
    });
    expect(provider.lastOpts?.cacheSystemPrompt).toBe(false);
  });
});
