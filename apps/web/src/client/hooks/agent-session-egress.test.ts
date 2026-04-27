import { beforeEach, describe, expect, it } from "vitest";
import { useAIPanelStore } from "../stores/ai-panel.js";
import { processJobEvent } from "./useAgentSession.js";

/**
 * Phase-11 Airlock — `egress.downgraded` job-event handling.
 *
 * The executor emits this event the first time `kb.global_search`
 * returns a foreign-project hit. The AI panel surfaces a banner
 * so the user understands why later provider calls in the run
 * fail with `EgressDowngradedError`.
 *
 * These tests pin three behaviours:
 *   1. The event maps to the right store message type.
 *   2. Duplicate events fold into the first banner — a noisy
 *      executor can't spam the panel.
 *   3. The reason / timestamp payload is preserved verbatim for
 *      audit + UI display.
 */

describe("processJobEvent — egress.downgraded", () => {
  beforeEach(() => {
    // Reset the AI-panel store before each case.
    useAIPanelStore.setState({
      jobId: null,
      messages: [],
      lastSeq: 0,
      isStreaming: false,
    });
  });

  it("renders an egress_downgraded message with the executor's reason + timestamp", () => {
    processJobEvent({
      seq: 1,
      kind: "egress.downgraded",
      data: JSON.stringify({
        reason: "kb.global_search returned cross-project hits",
        at: "2026-04-25T12:00:00.000Z",
      }),
    });

    const msgs = useAIPanelStore.getState().messages;
    expect(msgs).toHaveLength(1);
    const banner = msgs[0];
    expect(banner?.type).toBe("egress_downgraded");
    if (banner?.type === "egress_downgraded") {
      expect(banner.reason).toBe("kb.global_search returned cross-project hits");
      expect(banner.at).toBe("2026-04-25T12:00:00.000Z");
    }
  });

  it("falls back to a generic reason when the payload is empty", () => {
    processJobEvent({ seq: 1, kind: "egress.downgraded", data: "{}" });
    const msgs = useAIPanelStore.getState().messages;
    expect(msgs).toHaveLength(1);
    if (msgs[0]?.type === "egress_downgraded") {
      expect(msgs[0].reason).toMatch(/cross-project content/);
      expect(msgs[0].at).toBeNull();
    }
  });

  it("folds duplicate downgrade events into the first banner", () => {
    processJobEvent({
      seq: 1,
      kind: "egress.downgraded",
      data: JSON.stringify({ reason: "first", at: "2026-04-25T12:00:00Z" }),
    });
    processJobEvent({
      seq: 2,
      kind: "egress.downgraded",
      data: JSON.stringify({ reason: "second", at: "2026-04-25T12:00:30Z" }),
    });

    const msgs = useAIPanelStore.getState().messages.filter((m) => m.type === "egress_downgraded");
    expect(msgs).toHaveLength(1);
    if (msgs[0]?.type === "egress_downgraded") {
      // First reason wins — matches airlock.ts's idempotent
      // "first reason wins" semantics on the server side.
      expect(msgs[0].reason).toBe("first");
    }
  });
});
