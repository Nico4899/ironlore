import { describe, expect, it } from "vitest";
import { InteractiveBridge } from "./interactive-bridge.js";

/**
 * InteractiveBridge tests.
 *
 * Verifies the async handoff between WebSocket handler and executor:
 *   - waitForUserMessage blocks until pushUserMessage is called
 *   - onDisconnect resolves pending wait with null
 *   - onReconnect resets the disconnect flag
 *   - Consecutive messages flow correctly
 */

describe("InteractiveBridge", () => {
  it("pushUserMessage resolves a pending waitForUserMessage", async () => {
    const bridge = new InteractiveBridge();
    const p = bridge.waitForUserMessage();
    bridge.pushUserMessage("hello");
    await expect(p).resolves.toBe("hello");
  });

  it("onDisconnect resolves pending wait with null", async () => {
    const bridge = new InteractiveBridge();
    const p = bridge.waitForUserMessage();
    bridge.onDisconnect();
    await expect(p).resolves.toBeNull();
  });

  it("waitForUserMessage returns null immediately if already disconnected", async () => {
    const bridge = new InteractiveBridge();
    bridge.onDisconnect();
    await expect(bridge.waitForUserMessage()).resolves.toBeNull();
  });

  it("onReconnect unblocks future waitForUserMessage calls", async () => {
    const bridge = new InteractiveBridge();
    bridge.onDisconnect();
    bridge.onReconnect();
    const p = bridge.waitForUserMessage();
    bridge.pushUserMessage("reconnected");
    await expect(p).resolves.toBe("reconnected");
  });

  it("isWaiting reflects pending state", async () => {
    const bridge = new InteractiveBridge();
    expect(bridge.isWaiting).toBe(false);
    const p = bridge.waitForUserMessage();
    expect(bridge.isWaiting).toBe(true);
    bridge.pushUserMessage("x");
    await p;
    expect(bridge.isWaiting).toBe(false);
  });

  it("multiple messages flow through sequentially", async () => {
    const bridge = new InteractiveBridge();
    const p1 = bridge.waitForUserMessage();
    bridge.pushUserMessage("one");
    expect(await p1).toBe("one");

    const p2 = bridge.waitForUserMessage();
    bridge.pushUserMessage("two");
    expect(await p2).toBe("two");
  });

  it("pushUserMessage when nothing is waiting is a no-op", () => {
    const bridge = new InteractiveBridge();
    // Should not throw.
    bridge.pushUserMessage("unanswered");
    expect(bridge.isWaiting).toBe(false);
  });
});
