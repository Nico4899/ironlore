import { useCallback, useEffect, useRef } from "react";
import { useAIPanelStore } from "../stores/ai-panel.js";
import { useAppStore } from "../stores/app.js";

const BASE = "/api/projects/main";

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

  const sendMessage = useCallback(async (text: string) => {
    const store = useAIPanelStore.getState();
    const slug = store.activeAgent;

    // Add user message immediately.
    store.addMessage({ type: "user", text, attachments: [] });
    store.setIsStreaming(true);

    try {
      const res = await fetch(`${BASE}/agents/${slug}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text, mode: "interactive" }),
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

      // Start polling for events.
      startPolling(jobId);
    } catch (err) {
      store.addMessage({
        type: "error",
        text: `Connection error: ${err instanceof Error ? err.message : String(err)}`,
      });
      store.setIsStreaming(false);
    }
  }, []);

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
        const res = await fetch(`${BASE}/jobs/${jobId}/events?since=${store.lastSeq}`);
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
        }
      } catch {
        // Network error — keep polling, it'll recover.
      }
    }, 500);
  }, []);

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
      activeJobIdRef.current = store.jobId;
      startPolling(store.jobId);
    }
  }, [startPolling]);

  return { sendMessage };
}

/**
 * Map a raw job event into a ConversationMessage.
 */
function processJobEvent(event: { seq: number; kind: string; data: string }): void {
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
      const msgs = store.messages;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        if (msg?.type === "tool_call" && msg.result === undefined) {
          (msg as { result?: unknown }).result = data.result;
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
          (msg as { result?: unknown }).result = `Error: ${data.error}`;
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

    case "usage":
      // Token usage — could surface in UI later; skip for now.
      break;

    case "session.paused":
      // Interactive session paused (client disconnected).
      break;
  }
}
