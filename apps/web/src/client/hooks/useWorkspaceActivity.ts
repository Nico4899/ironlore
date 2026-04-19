import { useEffect, useState } from "react";
import {
  type AgentListEntry,
  type AgentRunRecord,
  fetchAgentRuns,
  fetchAgents,
  fetchInbox,
} from "../lib/api.js";

/**
 * Cross-surface live workspace counters — used by the sidebar active-
 * agents strip, the HomePanel hero, and any other place that wants to
 * display "N running, M queued, K pending review" without duplicating
 * the fetch logic.
 *
 * Polls lightly (10s) rather than subscribing to WS because:
 *  · These numbers are informational, not action-driving
 *  · One global poll keeps the WS channel focused on edits + diffs
 *  · The numbers lag by <10s, which is fine for a hero strip
 */
export interface ActiveAgent {
  slug: string;
  status: "active" | "paused";
  /**
   * Whether a run is in flight right now — derived from the agent's
   * recent-runs list (top row status === "running"). Not a perfect
   * signal (there can be a brief race on the enqueue → claim window),
   * but tight enough for live chrome.
   */
  running: boolean;
  /**
   * Step label for the current run ("step 04 / 12" etc.) or null when
   * the agent isn't running. Pulled from the recent-runs stepCount —
   * we don't have a total planned-steps count until the executor
   * emits one, so this surfaces as a plain "step N" for now.
   */
  stepLabel: string | null;
  /**
   * One-line note from the most-recent run (`jobs.result.outcome` /
   * last `agent.journal`). `null` when the agent has no runs yet.
   * Home's §01 Active runs surfaces this as the card's action line;
   * the Agent-detail page surfaces it per-row in §01 Recent runs.
   */
  lastNote: string | null;
}

export interface WorkspaceActivity {
  agents: ActiveAgent[];
  /** Count of agents whose most recent run is still running. */
  runningCount: number;
  /** Pending inbox entries awaiting review. */
  inboxCount: number;
  loaded: boolean;
}

const POLL_MS = 10_000;

export function useWorkspaceActivity(): WorkspaceActivity {
  const [state, setState] = useState<WorkspaceActivity>({
    agents: [],
    runningCount: 0,
    inboxCount: 0,
    loaded: false,
  });

  useEffect(() => {
    let cancelled = false;

    async function refresh(): Promise<void> {
      try {
        const [agentList, inbox] = await Promise.all([
          fetchAgents().catch(() => [] as AgentListEntry[]),
          fetchInbox().catch(() => ({ entries: [] as { status: string }[] })),
        ]);

        // For each agent, ask for the most-recent run. Limit=1 so this
        //  is N tiny queries rather than one aggregate; the server
        //  joins agent_runs ⨝ jobs via an index so each is fast.
        const runs = await Promise.all(
          agentList.map((a) => fetchAgentRuns(a.slug, 1).catch(() => [] as AgentRunRecord[])),
        );

        if (cancelled) return;
        const agents: ActiveAgent[] = agentList.map((a, i) => {
          const last = runs[i]?.[0];
          const running = last?.status === "running";
          return {
            slug: a.slug,
            status: a.status,
            running,
            stepLabel: running && last ? `step ${last.stepCount}` : null,
            lastNote: last?.note ?? null,
          };
        });
        const runningCount = agents.filter((a) => a.running).length;
        // Spec: "pending" covers entries awaiting review. Inbox statuses
        //  we treat as pending: anything that isn't "approved" or
        //  "rejected".
        const inboxCount = inbox.entries.filter(
          (e) => e.status !== "approved" && e.status !== "rejected",
        ).length;
        setState({ agents, runningCount, inboxCount, loaded: true });
      } catch {
        if (!cancelled) setState((prev) => ({ ...prev, loaded: true }));
      }
    }

    refresh();
    const id = window.setInterval(refresh, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return state;
}
