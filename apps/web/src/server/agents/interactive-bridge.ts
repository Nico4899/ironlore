/**
 * Interactive session bridge.
 *
 * Connects the AI panel's WebSocket to the agent executor's
 * conversation loop. The executor calls `waitForUserMessage()` between
 * turns; the WS handler calls `pushUserMessage()` when the user sends
 * a new prompt.
 *
 * On disconnect: the bridge pauses — the executor's `waitForUserMessage`
 * resolves with `null`, signaling the executor to persist its state and
 * yield the worker lease (but NOT finalize the job — it stays `running`
 * with a long lease that the reconnecting client picks back up).
 *
 * On reconnect: the client re-subscribes to the job's event stream
 * (via JobEventsBridge) with its `lastSeq`, gets the full replay, then
 * sends a new message to resume the conversation.
 *
 * See docs/04-ai-and-agents.md §Interactive vs autonomous sessions.
 */

export class InteractiveBridge {
  private pendingResolve: ((msg: string | null) => void) | null = null;
  private disconnected = false;

  /**
   * Called by the executor between turns. Blocks until the user sends
   * a message or the WS disconnects (returns null).
   */
  waitForUserMessage(): Promise<string | null> {
    if (this.disconnected) return Promise.resolve(null);
    return new Promise<string | null>((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  /**
   * Called by the WS handler when the user sends a new prompt.
   */
  pushUserMessage(text: string): void {
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve(text);
    }
  }

  /**
   * Called when the WS disconnects. Unblocks the executor so it can
   * yield its lease gracefully.
   */
  onDisconnect(): void {
    this.disconnected = true;
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve(null);
    }
  }

  /**
   * Called when a client reconnects. Resets the disconnect flag so
   * future `waitForUserMessage` calls block again.
   */
  onReconnect(): void {
    this.disconnected = false;
  }

  /**
   * Whether the bridge is waiting for user input.
   */
  get isWaiting(): boolean {
    return this.pendingResolve !== null;
  }
}
