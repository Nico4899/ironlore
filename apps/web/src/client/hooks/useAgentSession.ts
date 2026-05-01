import { useCallback, useEffect, useRef } from "react";
import { pushAgentToast } from "../components/AgentToast.js";
import { getApiProject } from "../lib/api.js";
import { useAIPanelStore } from "../stores/ai-panel.js";
import { useEditorStore } from "../stores/editor.js";

const BASE = (): string => `/api/projects/${getApiProject()}`;

/**
 * Hook that manages the AI panel's agent session lifecycle.
 *
 * - Sends the user prompt to `POST /agents/:slug/run`
 * - Polls `GET /jobs/:id/events?since=N` for new events (will be
 *   upgraded to WS subscription when the job-events bridge is wired
 *   into the main WS upgrade handler in production — for now, polling
 *   is the reliable path that works without server changes)
 * - Maps job events to ConversationMessage entries in the store
 * - On reconnect (tab re-open), replays from `lastSeq`
 *
 * See docs/04-ai-and-agents.md §Structured conversation UI and
 * docs/05-jobs-and-security.md §Event stream.
 */
export function useAgentSession() {
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeJobIdRef = useRef<string | null>(null);

  const startPolling = useCallback((jobId: string) => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);

    pollTimerRef.current = setInterval(async () => {
      const store = useAIPanelStore.getState();
      if (store.jobId !== jobId) {
        // Job changed — stop polling this one.
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        return;
      }

      try {
        const res = await fetch(`${BASE()}/jobs/${jobId}/events?since=${store.lastSeq}`);
        if (!res.ok) return;

        const { events, jobStatus } = (await res.json()) as {
          events: Array<{ seq: number; kind: string; data: string }>;
          jobStatus: string;
        };

        for (const event of events) {
          processJobEvent(event);
          store.setLastSeq(event.seq);
        }

        // Stop polling when the job is done.
        if (jobStatus === "done" || jobStatus === "failed" || jobStatus === "cancelled") {
          store.setIsStreaming(false);
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          // Fire notification toast.
          if (jobStatus === "done" || jobStatus === "failed") {
            pushAgentToast(store.activeAgent, jobStatus as "done" | "failed");
          }
        }
      } catch {
        // Network error — keep polling, it'll recover.
      }
    }, 500);
  }, []);

  const sendMessage = useCallback(
    /**
     * Send a user prompt to the agent.
     *
     * - `displayText` is what shows in the chat bubble (just what the
     *   user typed).
     * - `serverPrompt` is what's actually sent to the agent — usually
     *   the typed draft prefixed with attached-file bodies and any
     *   selection block-refs the AI panel composer included.
     * - `attachments` are short labels (e.g. `persona.md`) that
     *   render as chips above the bubble so the user can see what
     *   file context rode along without the entire body being
     *   inlined into the visible message.
     *
     * When `serverPrompt` is omitted it defaults to `displayText`
     * (no attachments). Backwards-compatible with existing callers
     * that just want to send a plain message.
     */
    async (displayText: string, serverPrompt?: string, attachments: string[] = []) => {
      const store = useAIPanelStore.getState();
      const slug = store.activeAgent;
      const wirePrompt = serverPrompt ?? displayText;

      store.addMessage({ type: "user", text: displayText, attachments });
      // Reset the run-scoped token counter so the context-budget chip
      //  in the composer restarts from 0% used. Each `usage` event on
      //  the stream increments it via `incrementTokens` below.
      store.resetTokens();
      store.setIsStreaming(true);

      // Reset the resolution chip — the next event from the new run
      //  will set it. Keeps the header chip honest about *this* turn,
      //  not the previous one.
      store.setLastResolution(null);

      try {
        const res = await fetch(`${BASE()}/agents/${slug}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: wirePrompt,
            mode: "interactive",
            effort: store.effort,
            // Per-conversation runtime override (composer's `/model …`
            //  / `/provider …` slash commands). Sent through the same
            //  payload field the action override uses; the server
            //  resolver picks per field, so the runtime override
            //  always loses to a per-message action override if one
            //  is set in the same request.
            modelOverride: store.runtimeOverride.model,
            providerOverride: store.runtimeOverride.provider,
          }),
        });

        if (!res.ok) {
          const body = await res.text();
          store.addMessage({ type: "error", text: `Failed to start run: ${body}` });
          store.setIsStreaming(false);
          return;
        }

        const { jobId } = (await res.json()) as { jobId: string };
        store.setJobId(jobId);
        activeJobIdRef.current = jobId;
        startPolling(jobId);
      } catch (err) {
        store.addMessage({
          type: "error",
          text: `Connection error: ${err instanceof Error ? err.message : String(err)}`,
        });
        store.setIsStreaming(false);
      }
    },
    [startPolling],
  );

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  // Resume polling if the panel reopens with an active job.
  useEffect(() => {
    const store = useAIPanelStore.getState();
    if (store.jobId && store.isStreaming) {
      // Insert a visual divider so the user knows older messages are replayed.
      if (store.messages.length > 0 && store.lastSeq > 0) {
        store.addMessage({ type: "resume_divider" });
      }
      activeJobIdRef.current = store.jobId;
      startPolling(store.jobId);
    }
  }, [startPolling]);

  return { sendMessage };
}

/**
 * Map a raw job event into a ConversationMessage.
 *
 * Exported for tests — the production caller is the polling
 * timer inside `useAgentSession`.
 */
export function processJobEvent(event: { seq: number; kind: string; data: string }): void {
  const store = useAIPanelStore.getState();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(event.data) as Record<string, unknown>;
  } catch {
    data = {};
  }

  switch (event.kind) {
    case "message.text": {
      // Accumulate assistant text into the last assistant message,
      // or start a new one.
      const messages = store.messages;
      const last = messages[messages.length - 1];
      if (last?.type === "assistant") {
        // Mutate in place — the store reference is stable.
        (last as { text: string }).text += (data.text as string) ?? "";
        useAIPanelStore.setState({ messages: [...messages] });
      } else {
        store.addMessage({ type: "assistant", text: (data.text as string) ?? "" });
      }
      break;
    }

    case "message.user":
      // Already added optimistically by sendMessage — skip.
      break;

    case "message.error":
      store.addMessage({ type: "error", text: (data.text as string) ?? "Unknown error" });
      break;

    case "tool.call":
      store.addMessage({
        type: "tool_call",
        tool: (data.tool as string) ?? "unknown",
        args: data.args,
        collapsed: true,
      });
      break;

    case "tool.result": {
      // Find the last tool_call message and attach the result.
      // `durationMs` is now measured server-side by the dispatcher
      // and rides on the event payload. The previous client-side
      // computation (`Date.now() - msg.timestamp`) always read ~0ms
      // because tool.call and tool.result land in the same 500ms
      // poll batch and were stamped in the same JS tick.
      const msgs = store.messages;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        if (msg?.type === "tool_call" && msg.result === undefined) {
          const mutable = msg as { result?: unknown; durationMs?: number };
          mutable.result = data.result;
          if (typeof data.durationMs === "number") {
            mutable.durationMs = data.durationMs;
          }
          useAIPanelStore.setState({ messages: [...msgs] });
          break;
        }
      }
      break;
    }

    case "tool.error": {
      const msgs2 = store.messages;
      for (let i = msgs2.length - 1; i >= 0; i--) {
        const msg = msgs2[i];
        if (msg?.type === "tool_call" && msg.result === undefined) {
          const mutable = msg as { result?: unknown; durationMs?: number };
          mutable.result = `Error: ${data.error}`;
          if (typeof data.durationMs === "number") {
            mutable.durationMs = data.durationMs;
          }
          useAIPanelStore.setState({ messages: [...msgs2] });
          break;
        }
      }
      break;
    }

    case "agent.journal":
      store.addMessage({ type: "journal", text: (data.text as string) ?? "" });
      store.setIsStreaming(false);
      break;

    case "budget.exhausted":
    case "budget.warning":
      store.addMessage({
        type: "error",
        text: `Budget ${event.kind === "budget.exhausted" ? "exhausted" : "warning"}: ${JSON.stringify(data)}`,
      });
      break;

    case "usage": {
      // Per-chunk TokenUsage payload from the provider (see
      //  apps/web/src/server/providers/types.ts `TokenUsage`). We
      //  accumulate `input + output` into the store so the
      //  composer's context-budget chip reads `tokensUsed` /
      //  AGENT_TOKEN_BUDGET for the % remaining. Cache tokens are
      //  intentionally excluded — the server's `budget.usedTokens`
      //  counter also sums only input + output (executor.ts line
      //  195), so the UI gauge stays aligned with the server cap.
      const input = typeof data.inputTokens === "number" ? data.inputTokens : 0;
      const output = typeof data.outputTokens === "number" ? data.outputTokens : 0;
      const delta = input + output;
      if (delta > 0) store.incrementTokens(delta);
      break;
    }

    case "session.paused":
      // Interactive session paused (client disconnected).
      break;

    case "provider.resolved": {
      // Server's resolver just produced the (provider, model, effort)
      //  triple for this run. The header chip surfaces it so the
      //  user can see which override level fired (e.g. "from
      //  persona" / "from runtime" / "from action").
      const provider = typeof data.provider === "string" ? data.provider : "";
      const model = typeof data.model === "string" ? data.model : "";
      const effort = typeof data.effort === "string" ? data.effort : "";
      const source = (data.source ?? null) as {
        provider?: string;
        model?: string;
        effort?: string;
      } | null;
      const notes = Array.isArray(data.notes) ? (data.notes as string[]) : [];
      if (provider && model && effort && source) {
        store.setLastResolution({
          provider,
          model,
          effort,
          source: {
            provider: source.provider ?? "global",
            model: source.model ?? "global",
            effort: source.effort ?? "global",
          },
          notes,
        });
      }
      break;
    }

    case "diff_preview": {
      // Server is pausing on a destructive tool call pending the
      // user's verdict. Two surfaces compete here:
      //
      //   1. **In-editor inline plugin** (preferred) — when the
      //      target page is already open, push a `PendingEdit` into
      //      the editor store. The ProseMirror inline-diff plugin
      //      reads this list and renders ghost decorations keyed to
      //      `blockId`; Tab accepts via the same DryRunBridge call
      //      the AI-panel card uses.
      //   2. **AI-panel `DiffPreview` card** (fallback) — when the
      //      target isn't open, render the existing card. The card's
      //      "Open page" button bridges into surface 1 by navigating.
      //
      // The structured fields (`op`, `blockId`, `currentMd`,
      // `proposedMd`) ride alongside the legacy `diff` string so
      // both surfaces have what they need without two events.
      const pageId = (data.pageId as string) ?? "";
      const toolCallId = (data.toolCallId as string) ?? "";
      const op = data.op as "replace" | "insert" | "delete" | undefined;
      const blockId = typeof data.blockId === "string" ? data.blockId : undefined;
      const currentMd = typeof data.currentMd === "string" ? data.currentMd : undefined;
      const proposedMd = typeof data.proposedMd === "string" ? data.proposedMd : undefined;

      const editor = useEditorStore.getState();
      const targetIsOpen =
        pageId.length > 0 && editor.filePath === pageId && editor.fileType === "markdown";

      // Route to the inline plugin only when we have the structured
      //  trio AND the page is open. Older agent runs that don't emit
      //  the structured fields fall back to the card path.
      if (targetIsOpen && op !== undefined && blockId !== undefined && toolCallId.length > 0) {
        editor.pushPendingEdit({
          toolCallId,
          op,
          blockId,
          pageId,
          currentMd,
          proposedMd,
          agentSlug: store.activeAgent,
        });
        break;
      }

      store.addMessage({
        type: "diff_preview",
        toolCallId,
        tool: (data.tool as string) ?? "unknown",
        pageId,
        diff: (data.diff as string) ?? "",
        approved: null,
        ...(op !== undefined ? { op } : {}),
        ...(blockId !== undefined ? { blockId } : {}),
        ...(currentMd !== undefined ? { currentMd } : {}),
        ...(proposedMd !== undefined ? { proposedMd } : {}),
      });
      break;
    }

    case "egress.downgraded": {
      // Phase-11 Airlock — `kb.global_search` returned a foreign
      // hit and the run's egress just went offline. Render the
      // banner once per run; if the executor double-fires (it
      // shouldn't) the second card is harmless. The event payload
      // is `{ reason, at }` — see airlock.ts.
      const reason =
        typeof data.reason === "string" && data.reason.length > 0
          ? data.reason
          : "cross-project content entered the run";
      const at = typeof data.at === "string" ? data.at : null;
      // Fold duplicates into the first banner so a noisy executor
      // can't spam the panel.
      const existing = store.messages.find((m) => m.type === "egress_downgraded");
      if (!existing) {
        store.addMessage({ type: "egress_downgraded", reason, at });
      }
      break;
    }

    case "run.finalized": {
      // Server emits this at the end of an autonomous run with the
      // commit range + file list. We surface it as a finalized card
      // so the user can eyeball the commit range or hit Revert.
      const runId = (data.runId as string) ?? "";
      const agentSlug = (data.agentSlug as string) ?? store.activeAgent;
      const commitShaStart = (data.commitShaStart as string) ?? "";
      const commitShaEnd = (data.commitShaEnd as string) ?? "";
      const filesChanged = Array.isArray(data.filesChanged) ? (data.filesChanged as string[]) : [];
      if (commitShaStart && commitShaEnd) {
        store.addMessage({
          type: "run_finalized",
          runId,
          agentSlug,
          commitShaStart,
          commitShaEnd,
          filesChanged,
          revertedAt: null,
        });
      }
      break;
    }
  }
}
