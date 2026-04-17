import { describe, expect, it } from "vitest";
import { DryRunBridge } from "./dry-run-bridge.js";

/**
 * DryRunBridge tests.
 *
 * The bridge is the async handoff between the dispatcher (awaiting a
 * verdict on a pending destructive tool call) and the HTTP endpoint
 * (delivering the user's click). Tests cover:
 *   - verdict delivery: submitVerdict resolves the matching waiter
 *   - unknown ID: submitVerdict returns false without crashing
 *   - timeout: awaitVerdict resolves with "timeout" after the budget
 *   - double submit: the second call returns false
 *   - cancelAll on shutdown releases every pending wait
 */

describe("DryRunBridge", () => {
  it("submitVerdict resolves the matching pending waiter", async () => {
    const bridge = new DryRunBridge();
    const wait = bridge.awaitVerdict("tc-1");
    const delivered = bridge.submitVerdict("tc-1", "approve");
    expect(delivered).toBe(true);
    await expect(wait).resolves.toBe("approve");
  });

  it("delivers reject verdicts", async () => {
    const bridge = new DryRunBridge();
    const wait = bridge.awaitVerdict("tc-2");
    bridge.submitVerdict("tc-2", "reject");
    await expect(wait).resolves.toBe("reject");
  });

  it("returns false when submitting a verdict for an unknown tool-call ID", () => {
    const bridge = new DryRunBridge();
    expect(bridge.submitVerdict("nope", "approve")).toBe(false);
  });

  it("resolves with 'timeout' when no verdict arrives in time", async () => {
    const bridge = new DryRunBridge();
    // Use a 10ms timeout so the test doesn't actually hang for 10 min.
    const wait = bridge.awaitVerdict("tc-3", 10);
    await expect(wait).resolves.toBe("timeout");
  });

  it("a second submitVerdict after the first does nothing", async () => {
    const bridge = new DryRunBridge();
    const wait = bridge.awaitVerdict("tc-4");
    expect(bridge.submitVerdict("tc-4", "approve")).toBe(true);
    await wait;
    // Second call finds nothing pending.
    expect(bridge.submitVerdict("tc-4", "reject")).toBe(false);
  });

  it("pendingCount reflects waiting verdicts", () => {
    const bridge = new DryRunBridge();
    expect(bridge.pendingCount).toBe(0);
    bridge.awaitVerdict("tc-5", 60_000);
    bridge.awaitVerdict("tc-6", 60_000);
    expect(bridge.pendingCount).toBe(2);
    bridge.submitVerdict("tc-5", "approve");
    expect(bridge.pendingCount).toBe(1);
  });

  it("cancelAll resolves every pending wait with 'timeout'", async () => {
    const bridge = new DryRunBridge();
    const w1 = bridge.awaitVerdict("tc-7", 60_000);
    const w2 = bridge.awaitVerdict("tc-8", 60_000);
    bridge.cancelAll();
    await expect(w1).resolves.toBe("timeout");
    await expect(w2).resolves.toBe("timeout");
    expect(bridge.pendingCount).toBe(0);
  });

  it("timer cleanup on verdict prevents late timeout resolution", async () => {
    // If submitVerdict left the timeout timer running, a test that
    // awaits the promise AND sleeps past the timeout would see the
    // timer fire a second time on a stale resolve. The bridge clears
    // the timer on delivery — verify pendingCount stays at 0 and no
    // error surfaces from the underlying setTimeout handler.
    const bridge = new DryRunBridge();
    const wait = bridge.awaitVerdict("tc-9", 20);
    bridge.submitVerdict("tc-9", "approve");
    const result = await wait;
    expect(result).toBe("approve");
    // Sleep past the original timeout budget; nothing should happen.
    await new Promise((r) => setTimeout(r, 40));
    expect(bridge.pendingCount).toBe(0);
  });
});
