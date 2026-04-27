import { describe, expect, it } from "vitest";
import { OllamaEmbeddingProvider } from "./ollama-embedding.js";
import type { ProjectContext } from "./types.js";

/**
 * Ollama embedding provider — unit coverage. The real /api/embed
 * round-trip is exercised by the integration suite when a local
 * Ollama is running; this file pins the request shape, response
 * parsing, and the dimensionality guard.
 */

function makeCtx(fetchFn: typeof globalThis.fetch): ProjectContext {
  return {
    projectId: "main",
    fetch: fetchFn,
  };
}

describe("OllamaEmbeddingProvider", () => {
  it("defaults to nomic-embed-text at 768 dims", () => {
    const provider = new OllamaEmbeddingProvider();
    expect(provider.name).toBe("ollama");
    expect(provider.model).toBe("nomic-embed-text");
    expect(provider.dimensions).toBe(768);
  });

  it("accepts model + dimensions overrides", () => {
    const provider = new OllamaEmbeddingProvider({
      model: "mxbai-embed-large",
      dimensions: 1024,
    });
    expect(provider.model).toBe("mxbai-embed-large");
    expect(provider.dimensions).toBe(1024);
  });

  it("returns an empty array for an empty input — no network call", async () => {
    let called = 0;
    const provider = new OllamaEmbeddingProvider();
    const result = await provider.embed(
      [],
      makeCtx(async () => {
        called++;
        return new Response("{}");
      }),
    );
    expect(result).toEqual([]);
    expect(called).toBe(0);
  });

  it("posts to /api/embed with model + input array", async () => {
    const captured: { url: string; init: RequestInit }[] = [];
    const provider = new OllamaEmbeddingProvider({ baseUrl: "http://localhost:99999" });
    await provider.embed(
      ["hello", "world"],
      makeCtx(async (url, init) => {
        captured.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({ embeddings: [new Array(768).fill(0.1), new Array(768).fill(0.2)] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    expect(captured).toHaveLength(1);
    const entry = captured[0];
    expect(entry?.url).toBe("http://localhost:99999/api/embed");
    expect(entry?.init.method).toBe("POST");
    const body = JSON.parse(String(entry?.init.body)) as {
      model: string;
      input: string[];
    };
    expect(body.model).toBe("nomic-embed-text");
    expect(body.input).toEqual(["hello", "world"]);
  });

  it("returns embeddings in input order", async () => {
    const provider = new OllamaEmbeddingProvider();
    const result = await provider.embed(
      ["a", "b"],
      makeCtx(
        async () =>
          new Response(
            JSON.stringify({
              embeddings: [new Array(768).fill(0.1), new Array(768).fill(0.2)],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    expect(result).toHaveLength(2);
    expect(result[0]?.[0]).toBeCloseTo(0.1);
    expect(result[1]?.[0]).toBeCloseTo(0.2);
  });

  it("throws when Ollama returns a non-200 response", async () => {
    const provider = new OllamaEmbeddingProvider();
    await expect(
      provider.embed(
        ["x"],
        makeCtx(async () => new Response("model not found", { status: 404 })),
      ),
    ).rejects.toThrow(/Ollama embeddings 404/);
  });

  it("throws when the response is missing the embeddings array", async () => {
    const provider = new OllamaEmbeddingProvider();
    await expect(
      provider.embed(
        ["x"],
        makeCtx(
          async () =>
            new Response(JSON.stringify({}), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        ),
      ),
    ).rejects.toThrow(/missing.*embeddings/i);
  });

  it("throws on length mismatch — silent corruption guard", async () => {
    const provider = new OllamaEmbeddingProvider();
    await expect(
      provider.embed(
        ["a", "b"],
        makeCtx(
          async () =>
            new Response(JSON.stringify({ embeddings: [new Array(768).fill(0)] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        ),
      ),
    ).rejects.toThrow(/returned 1 embeddings for 2 inputs/);
  });

  it("throws on dimensionality mismatch — model-swap detector", async () => {
    // Provider configured for 768 dims but Ollama returns 1024 —
    // the user installed `mxbai-embed-large` over the same name.
    // Silently accepting would corrupt chunk_vectors; throw loudly.
    const provider = new OllamaEmbeddingProvider({ dimensions: 768 });
    await expect(
      provider.embed(
        ["x"],
        makeCtx(
          async () =>
            new Response(JSON.stringify({ embeddings: [new Array(1024).fill(0.5)] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        ),
      ),
    ).rejects.toThrow(/1024-dim vectors; provider configured for 768/);
  });

  describe("detectEmbeddingModel", () => {
    it("returns null when /api/tags is unreachable", async () => {
      const result = await OllamaEmbeddingProvider.detectEmbeddingModel(async () => {
        throw new Error("ECONNREFUSED");
      });
      expect(result).toBeNull();
    });

    it("returns the first matching embedding-model family present in the registry", async () => {
      const result = await OllamaEmbeddingProvider.detectEmbeddingModel(
        async () =>
          new Response(
            JSON.stringify({
              models: [
                { name: "llama3:latest" },
                { name: "nomic-embed-text:latest" },
                { name: "mxbai-embed-large" },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      );
      // nomic-embed-text wins on the bias toward retrieval quality.
      expect(result).toBe("nomic-embed-text:latest");
    });

    it("returns null when no embedding-model family is installed", async () => {
      const result = await OllamaEmbeddingProvider.detectEmbeddingModel(
        async () =>
          new Response(JSON.stringify({ models: [{ name: "llama3:latest" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      expect(result).toBeNull();
    });
  });
});
