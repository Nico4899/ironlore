/**
 * Dry-run approval bridge.
 *
 * For agents whose persona declares `review_mode: dry_run`, destructive
 * tool calls (`kb.replace_block`, `kb.insert_after`, `kb.delete_block`)
 * don't execute immediately. The dispatcher:
 *
 *   1. Computes a unified diff of the proposed change.
 *   2. Emits a `diff_preview` event on the job's event stream with
 *      `{ toolCallId, pageId, diff }` so the AI panel can render a
 *      DiffPreview card.
 *   3. Awaits the user's verdict via this bridge.
 *   4. On `approve` → runs the tool normally. On `reject` → returns a
 *      synthetic "skipped by user" result. On `timeout` → rejects.
 *
 * The HTTP endpoint `POST /jobs/:jobId/approve` with
 * `{ toolCallId, verdict }` is the user's side of the handshake. A
 * single bridge instance lives at the server level so the endpoint and
 * the dispatcher can find each other by toolCallId.
 *
 * See docs/04-ai-and-agents.md §Dry-run diff preview.
 */

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — long enough for a human to review.

export type Verdict = "approve" | "reject" | "timeout";

interface PendingVerdict {
  resolve: (verdict: Verdict) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class DryRunBridge {
  private pending = new Map<string, PendingVerdict>();

  /**
   * Wait for the user to approve or reject a pending mutation. Resolves
   * with `timeout` if no verdict arrives within `timeoutMs` — the
   * dispatcher treats that as a reject so we don't leak a running
   * agent on a closed browser.
   */
  awaitVerdict(toolCallId: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<Verdict> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(toolCallId);
        resolve("timeout");
      }, timeoutMs);

      // An unreferenced timer — if the process is shutting down we
      // don't want to keep the event loop alive on a pending verdict.
      if (timer.unref) timer.unref();

      this.pending.set(toolCallId, { resolve, timer });
    });
  }

  /**
   * Deliver a user verdict. Returns `true` when a matching pending
   * wait was found; `false` when the toolCallId is unknown or already
   * resolved (double-approve, stale tab, etc).
   */
  submitVerdict(toolCallId: string, verdict: "approve" | "reject"): boolean {
    const entry = this.pending.get(toolCallId);
    if (!entry) return false;
    this.pending.delete(toolCallId);
    clearTimeout(entry.timer);
    entry.resolve(verdict);
    return true;
  }

  /**
   * Cancel every pending wait (server shutdown). All resolve with
   * `timeout` so the dispatchers return to their error paths rather
   * than hanging.
   */
  cancelAll(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve("timeout");
    }
    this.pending.clear();
  }

  /** Test-only: number of pending verdicts. */
  get pendingCount(): number {
    return this.pending.size;
  }
}
