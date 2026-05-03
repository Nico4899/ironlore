import type { ChatEvent, ChatOptions, ProjectContext, Provider } from "./types.js";

/**
 * Ollama provider — auto-detected local model runner.
 *
 * On startup, probes `http://127.0.0.1:11434/api/tags` to check if
 * Ollama is running. If it responds, the provider is registered as
 * available and the list of installed models is cached. Chat goes
 * through `/api/chat` with streaming.
 *
 * Tool support is model-dependent; defaults to `supportsTools: false`
 * so the General agent's Ask mode falls back to plain text generation.
 * Re-ranking is feature-flagged off for local providers (see
 * docs/04-ai-and-agents.md §Retrieval pipeline).
 */
export class OllamaProvider implements Provider {
  readonly name = "ollama" as const;
  readonly supportsTools = false;
  readonly supportsPromptCache = false;

  private baseUrl: string;

  constructor(opts?: { baseUrl?: string }) {
    this.baseUrl = opts?.baseUrl ?? "http://127.0.0.1:11434";
  }

  /**
   * Probe the Ollama API to check if it's running and what models are
   * installed. Returns null if Ollama isn't reachable.
   *
   * Per docs/07-tech-stack.md §First-launch provider selection, the
   * probe must time out at 300 ms — a hung Ollama process (e.g. one
   * stuck loading a model) shouldn't block server startup. Override
   * via `IRONLORE_OLLAMA_DETECT_TIMEOUT_MS` for slow-loopback envs
   * (rare; mostly Docker-on-Docker setups). Both abort and any other
   * fetch error degrade to `null` (the existing fail-soft contract).
   */
  static async detect(
    fetchFn: (url: string, init?: RequestInit) => Promise<Response> = globalThis.fetch,
  ): Promise<{ models: string[] } | null> {
    const timeoutMs = Number(process.env.IRONLORE_OLLAMA_DETECT_TIMEOUT_MS ?? 300);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn("http://127.0.0.1:11434/api/tags", {
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { models?: Array<{ name: string }> };
      const models = (body.models ?? []).map((m) => m.name);
      return { models };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async *chat(opts: ChatOptions, ctx: ProjectContext): AsyncIterable<ChatEvent> {
    const url = `${this.baseUrl}/api/chat`;

    const messages = [
      { role: "system", content: opts.systemPrompt },
      ...opts.messages.map((m) => {
        if (m.role === "tool_use") {
          // Ollama doesn't support tool-use natively; flatten to assistant text.
          return {
            role: "assistant" as const,
            content: JSON.stringify({ tool: m.name, input: m.input }),
          };
        }
        if (m.role === "tool_result") {
          return { role: "user" as const, content: m.content };
        }
        return { role: m.role, content: m.content };
      }),
    ];

    const body = {
      model: opts.model,
      messages,
      stream: true,
      options: {
        num_predict: opts.maxTokens ?? 4096,
        temperature: opts.temperature ?? 0.7,
      },
    };

    let res: Response;
    try {
      res = await ctx.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      yield { type: "error", message: `Ollama connection failed: ${err}` };
      return;
    }

    if (!res.ok) {
      const text = await res.text();
      yield { type: "error", message: `Ollama API ${res.status}: ${text}` };
      return;
    }

    if (!res.body) {
      yield { type: "error", message: "Ollama API returned no body" };
      return;
    }

    // Ollama streams newline-delimited JSON (not SSE).
    yield* parseNDJSON(res.body);
  }
}

async function* parseNDJSON(body: ReadableStream<Uint8Array>): AsyncIterable<ChatEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let totalTokens = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }

        const msg = event.message as Record<string, unknown> | undefined;
        if (msg?.content && typeof msg.content === "string") {
          yield { type: "text", text: msg.content };
        }

        if (event.done === true) {
          totalTokens = (event.eval_count as number) ?? totalTokens;
          yield {
            type: "done",
            stopReason: "end_turn",
            usage: {
              inputTokens: (event.prompt_eval_count as number) ?? 0,
              outputTokens: totalTokens,
            },
          };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
