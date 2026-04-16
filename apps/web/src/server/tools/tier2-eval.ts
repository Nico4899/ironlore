/**
 * Tier 2 tool-protocol eval — nightly, against a real model.
 *
 * The same scenarios as the Tier 1 Vitest suite
 * (dispatcher.test.ts) but run against the live provider. Gated by
 * `IRONLORE_EVAL=1` so CI never hits the API. Failures ticket but
 * do not block CI.
 *
 * This catches model-side regressions that a scripted mock cannot:
 *   - A new model release that forgets the retry protocol
 *   - A prompt change that no longer elicits the right recovery
 *   - Tool-call format drift from the provider
 *
 * See docs/04-ai-and-agents.md §Tool protocol testing — Tier 2.
 */

export interface Tier2Scenario {
  name: string;
  description: string;
  /** Set up the fixture KB state for this scenario. */
  setup: () => Promise<void>;
  /** The initial prompt that triggers the scenario. */
  prompt: string;
  /** Assert on the agent's tool calls and final state. */
  validate: (events: Array<{ kind: string; data: unknown }>) => {
    passed: boolean;
    details: string;
  };
}

/**
 * Built-in Tier 2 scenarios. Same as Tier 1 but the model drives
 * the tool-call sequence, not a script.
 */
export const TIER2_SCENARIOS: Tier2Scenario[] = [
  {
    name: "stale-etag-recovery",
    description:
      "Agent reads a page, a concurrent edit changes the ETag, " +
      "agent's replace_block gets 409, agent re-reads and retries.",
    setup: async () => {
      // Fixture setup would create a page and simulate concurrent edit.
    },
    prompt:
      "Read the page 'test.md' and replace the second paragraph with 'Updated by Tier 2 eval.'",
    validate: (events) => {
      const toolCalls = events.filter((e) => e.kind === "tool.call");
      const hasReRead = toolCalls.some(
        (e) => (e.data as Record<string, unknown>).tool === "kb.read_page",
      );
      return {
        passed: toolCalls.length >= 2 && hasReRead,
        details: `${toolCalls.length} tool calls, re-read: ${hasReRead}`,
      };
    },
  },
  {
    name: "hallucinated-block-recovery",
    description:
      "Agent uses a non-existent block ID, gets 404, re-reads to " +
      "discover valid IDs, retries with the correct one.",
    setup: async () => {},
    prompt:
      "Read 'test.md' and replace the block with ID 'blk_FAKEFAKEFAKEFAKEFAKEFAKE' " +
      "with 'This should fail then recover.'",
    validate: (events) => {
      const errors = events.filter((e) => e.kind === "tool.error");
      const reads = events.filter(
        (e) =>
          e.kind === "tool.call" && (e.data as Record<string, unknown>).tool === "kb.read_page",
      );
      return {
        passed: errors.length >= 1 && reads.length >= 2,
        details: `${errors.length} errors, ${reads.length} reads`,
      };
    },
  },
  {
    name: "budget-exhaustion",
    description: "Agent hits the tool-call cap and stops gracefully with a journal entry.",
    setup: async () => {},
    prompt:
      "Search for every topic in the knowledge base and read each page. " +
      "Continue until you run out of budget.",
    validate: (events) => {
      const budgetEvents = events.filter(
        (e) => e.kind === "budget.exhausted" || e.kind === "budget.warning",
      );
      const journals = events.filter((e) => e.kind === "agent.journal");
      return {
        passed: budgetEvents.length >= 1 || journals.length >= 1,
        details: `budget events: ${budgetEvents.length}, journals: ${journals.length}`,
      };
    },
  },
];

/**
 * Run Tier 2 eval. Returns results for each scenario.
 * Only callable when IRONLORE_EVAL=1 is set.
 */
export async function runTier2Eval(): Promise<
  Array<{ scenario: string; passed: boolean; details: string }>
> {
  if (process.env.IRONLORE_EVAL !== "1") {
    return [{ scenario: "gate", passed: false, details: "IRONLORE_EVAL=1 not set" }];
  }

  // TODO: wire real provider + fixture KB + agent executor per scenario.
  // For now, return scaffold results.
  return TIER2_SCENARIOS.map((s) => ({
    scenario: s.name,
    passed: false,
    details: "Tier 2 scaffold — real-model execution not yet wired.",
  }));
}
