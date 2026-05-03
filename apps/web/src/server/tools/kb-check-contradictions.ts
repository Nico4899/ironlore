import type { ToolCallContext, ToolImplementation } from "./types.js";

/**
 * `kb.check_contradictions(blockId, claim)` — Phase-4 no-op stub.
 *
 * Per docs/04-ai-and-agents.md §Contradiction detection:
 *
 *   > Phase 4 ships `kb.check_contradictions` as a no-op tool that
 *   > returns an empty array — agents learn to call it and handle
 *   > its absence gracefully. Phase 11 wires in the real pipeline
 *   > alongside the lint workflow skill, with the deterministic
 *   > backlinks-table detector (`kb.lint_contradictions`) shipping
 *   > first.
 *
 * The deterministic detector ([`kb.lint_contradictions`](./kb-lint-contradictions.ts))
 * is what's wired into the Wiki-Gardener's lint pipeline today; it
 * walks the typed-edge backlinks (`[[other | contradicts]]` / `disagrees`
 * / `refutes`). The LLM-classifier follow-up that this stub leaves
 * room for would: (1) embed the claim, (2) hybrid-retrieve the top-N
 * semantically-similar blocks, (3) classify each candidate with a
 * single LLM call, (4) cache to `.ironlore/contradictions.sqlite`.
 * That pipeline is Phase-11 follow-up work.
 *
 * The stub exists because the doc promised "agents learn to call it
 * and handle its absence gracefully" — without a registered tool,
 * dispatcher returns an "unknown tool" error and the agent's recovery
 * loop has nothing to handle. Returning a structured empty array
 * matches the eventual signature.
 */
export function createKbCheckContradictions(): ToolImplementation {
  return {
    definition: {
      name: "kb.check_contradictions",
      description:
        "Check whether other blocks in this project supports, contradicts, or is unrelated to a claim. " +
        "Returns `Array<{ pageId, blockId, text, similarity, relationship }>`. " +
        "**Phase-4 stub**: returns an empty array. The Phase-11 LLM-classifier follow-up will " +
        "embed the claim, retrieve semantically-similar blocks, and label each as " +
        "`supports` / `contradicts` / `unrelated`. The deterministic typed-edge detector " +
        "is `kb.lint_contradictions` — call it for the lint-pipeline path.",
      inputSchema: {
        type: "object",
        properties: {
          blockId: {
            type: "string",
            description: "Block ID of the claim being verified.",
          },
          claim: {
            type: "string",
            description: "Plain-text statement of the claim to check.",
          },
        },
        required: ["blockId", "claim"],
      },
    },
    async execute(_args: unknown, _ctx: ToolCallContext): Promise<string> {
      // Phase-4 no-op contract: structured empty array. The shape
      //  must match the Phase-11 implementation so an agent that
      //  parses the result on Phase 4 keeps working unchanged on
      //  Phase 11 once the classifier lands.
      return JSON.stringify([]);
    },
  };
}
