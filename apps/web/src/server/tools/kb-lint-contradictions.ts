import type { SearchIndex } from "../search-index.js";
import type { ToolCallContext, ToolImplementation } from "./types.js";

/**
 * kb.lint_contradictions — surface every typed wiki-link that
 * flags a disagreement between two pages.
 *
 * Backs the §3 "Contradiction flags" section in the Wiki
 * Gardener's `lint.md` workflow skill. Phase 1 of contradiction
 * detection is the trivially-correct rule-based pass: if the
 * author wrote `[[other | contradicts]]` (or `disagrees`,
 * `refutes`), it's a contradiction; if they didn't, the lint
 * report says "None." A future Phase 2 LLM detector can layer on
 * top — emit candidate pairs, run them through a model, surface
 * the ones the model agrees disagree.
 *
 * Read-only. The gardener pipes the result into the
 * "Contradiction flags" table in its lint report; resolution
 * (which side is right) is for the human reviewer.
 */
export function createKbLintContradictions(searchIndex: SearchIndex): ToolImplementation {
  return {
    definition: {
      name: "kb.lint_contradictions",
      description:
        "Find typed wiki-links flagging a contradiction between two pages " +
        "(`[[target | contradicts]]`, `disagrees`, or `refutes`). " +
        "Returns `{ count, contradictions: Array<{ sourcePath, targetPath, rel, linkText }> }`. " +
        "Read-only. Call this before composing the 'Contradiction flags' section of a lint report.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    async execute(_args: unknown, _ctx: ToolCallContext): Promise<string> {
      const contradictions = searchIndex.findContradictions();
      if (contradictions.length === 0) {
        return JSON.stringify({ count: 0, contradictions: [] });
      }
      return JSON.stringify({ count: contradictions.length, contradictions });
    },
  };
}
