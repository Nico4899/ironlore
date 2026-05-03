import { describe, expect, it } from "vitest";
import { createKbCheckContradictions } from "./kb-check-contradictions.js";
import type { ToolCallContext } from "./types.js";

const NO_CTX: ToolCallContext = {
  projectId: "main",
  agentSlug: "wiki-gardener",
  jobId: "test",
  emitEvent: () => undefined,
  dataRoot: "",
  fetch: globalThis.fetch,
};

/**
 * Pin the Phase-4 no-op contract for `kb.check_contradictions` per
 * docs/04-ai-and-agents.md §Contradiction detection. The stub must
 * return a structured empty array — not throw, not 404 the dispatch
 * — so an agent that calls the tool can handle the result with the
 * same JSON.parse path it'll use once Phase 11 wires in the real
 * LLM classifier. Without this contract, "agents learn to call it
 * and handle its absence gracefully" stops being true the moment
 * any agent actually does.
 */
describe("kb.check_contradictions — Phase-4 no-op stub", () => {
  it("registers under the name kb.check_contradictions", () => {
    const tool = createKbCheckContradictions();
    expect(tool.definition.name).toBe("kb.check_contradictions");
  });

  it("declares blockId + claim as required input fields", () => {
    const tool = createKbCheckContradictions();
    const schema = tool.definition.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.properties).toHaveProperty("blockId");
    expect(schema.properties).toHaveProperty("claim");
    expect(schema.required).toEqual(["blockId", "claim"]);
  });

  it("returns a JSON-serialised empty array regardless of input", async () => {
    const tool = createKbCheckContradictions();
    const out = await tool.execute({ blockId: "blk_X", claim: "the sky is green" }, NO_CTX);
    expect(out).toBe("[]");
    expect(JSON.parse(out)).toEqual([]);
  });

  it("returns the same empty array shape with no args (defensive parse)", async () => {
    // Models occasionally call tools with empty/missing args. The
    //  no-op contract must hold regardless — the dispatcher already
    //  validates required-fields, so the underlying executor is the
    //  last line of defence here.
    const tool = createKbCheckContradictions();
    const out = await tool.execute({}, NO_CTX);
    expect(JSON.parse(out)).toEqual([]);
  });

  it("description marks the tool as a Phase-4 stub for clarity in the model's tool list", () => {
    const tool = createKbCheckContradictions();
    expect(tool.definition.description).toMatch(/Phase-4 stub/i);
  });
});
