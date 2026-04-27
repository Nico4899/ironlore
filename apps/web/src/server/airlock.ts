/**
 * Airlock Protocol — dynamic egress downgrade for cross-project
 * agent search.
 *
 * Per docs/05-jobs-and-security.md §Threat-model boundaries (1.0
 * vs Airlock) and the Phase-11 roadmap entry: an agent that
 * reads a block from a *different* project must lose the ability
 * to make outbound network calls for the rest of the run.
 *
 * The threat: a malicious page in project B (read into the
 * agent's context via `kb.global_search`) directs the agent to
 * exfiltrate B's content to an attacker-controlled host. Today's
 * `fetchForProject` honours project A's egress allowlist — but
 * project A's author never anticipated B's content reaching the
 * agent's context. The downgrade closes the gap by forcing
 * `egress: offline` once any cross-project block enters the
 * transcript.
 *
 * Mechanism:
 *
 *   1. `createAirlockSession(baseFetch)` returns a triple of
 *      `{ fetch, downgrade, getStatus }`.
 *   2. The agent run uses the returned `fetch` everywhere a
 *      `ProjectContext.fetch` was used before.
 *   3. The `downgrade(reason)` callback is exposed to the
 *      `kb.global_search` tool via `ToolCallContext`. Calling it
 *      flips a one-way flag on the session.
 *   4. After downgrade, every subsequent call through the
 *      session's fetch throws `EgressDowngradedError`.
 *
 * The flag is one-way + per-run. A new agent run gets a fresh
 * session so a previous run's downgrade doesn't leak. The flag
 * isn't persisted to the job row — once the run ends the
 * session goes away. (Persisting it to `jobs.egress_downgraded`
 * is a roadmap follow-up for runs that resume across restarts;
 * with the current synchronous executor it's not needed.)
 */

export interface AirlockStatus {
  downgraded: boolean;
  /** Why we downgraded (audit field; surfaced in the UI affordance). */
  reason: string | null;
  /** ISO timestamp; unset until downgrade. */
  at: string | null;
}

export class EgressDowngradedError extends Error {
  readonly status = 451 as const; // "Unavailable for Legal Reasons" — closest semantic match
  readonly reason: string;
  constructor(reason: string) {
    super(`Egress downgraded: ${reason}`);
    this.name = "EgressDowngradedError";
    this.reason = reason;
  }
}

export interface AirlockSession {
  /**
   * Drop-in replacement for `ProjectContext.fetch`. Pre-downgrade
   * it forwards to the wrapped base fetch unchanged; post-downgrade
   * it throws `EgressDowngradedError` *before* the network is
   * touched, so the offending request never leaves the host.
   */
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
  /**
   * One-way flip. Idempotent — re-calling with a different reason
   * keeps the *first* reason (so the UI sees the trigger that
   * started the lockdown, not a later cascade).
   */
  downgrade(reason: string): void;
  /** Read-only snapshot for the UI / tool layer. */
  getStatus(): AirlockStatus;
}

/**
 * Build a per-run airlock session around an existing
 * `ProjectContext.fetch`. Call once per `executeAgentRun`; pass
 * the resulting `fetch` into `ProviderRegistry.buildContext` and
 * the `downgrade` callback into `ToolCallContext`.
 *
 * `onDowngrade` fires exactly once on the first downgrade — used
 * by the executor to emit a job event so the AI panel can render
 * the lockdown banner.
 */
export function createAirlockSession(
  baseFetch: (url: string | URL, init?: RequestInit) => Promise<Response>,
  onDowngrade?: (status: AirlockStatus) => void,
): AirlockSession {
  let downgraded = false;
  let reason: string | null = null;
  let at: string | null = null;

  return {
    async fetch(url, init) {
      if (downgraded) {
        throw new EgressDowngradedError(reason ?? "unknown");
      }
      return baseFetch(url, init);
    },
    downgrade(why: string) {
      if (downgraded) return; // first reason wins
      downgraded = true;
      reason = why;
      at = new Date().toISOString();
      onDowngrade?.({ downgraded: true, reason, at });
    },
    getStatus() {
      return { downgraded, reason, at };
    },
  };
}
