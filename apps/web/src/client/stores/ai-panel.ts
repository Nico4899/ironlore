import { create } from "zustand";

/**
 * Every message carries an optional millisecond `timestamp` so the
 * conversation log can surface a mono time tag beneath the bubble
 * (per docs/09-ui-and-brand.md §AI panel user bubble). The field is
 * stamped at `addMessage` time — it's client-wall-clock, not a
 * server field, which keeps the receive path unchanged.
 */
export type ConversationMessage =
  | { type: "user"; text: string; attachments: string[]; timestamp?: number }
  | { type: "assistant"; text: string; timestamp?: number }
  | {
      type: "tool_call";
      tool: string;
      args: unknown;
      result?: unknown;
      collapsed: boolean;
      timestamp?: number;
    }
  | { type: "journal"; text: string; step?: number; totalSteps?: number; timestamp?: number }
  | {
      type: "diff_preview";
      /** The tool-call ID the dispatcher is waiting on. */
      toolCallId: string;
      /** Tool name for display (kb.replace_block, kb.insert_after, kb.delete_block). */
      tool: string;
      pageId: string;
      diff: string;
      approved: boolean | null;
      /** Block id so the collapsed summary can render `file · blk_…`. */
      blockId?: string;
      /** Commit SHA once the approved edit has landed. */
      commitSha?: string;
      timestamp?: number;
    }
  | {
      type: "run_finalized";
      runId: string;
      agentSlug: string;
      commitShaStart: string;
      commitShaEnd: string;
      filesChanged: string[];
      revertedAt: number | null;
      timestamp?: number;
    }
  | { type: "error"; text: string; timestamp?: number }
  | { type: "resume_divider" };

/**
 * Context pill shown above the prompt field — e.g. the highlighted text
 * the user chose to "Ask AI" about. The user can dismiss it with the X
 * before sending.
 */
export interface ContextPill {
  kind: "highlight" | "file" | "page";
  /** Short label for the pill (e.g. truncated highlight text). */
  label: string;
  /** Full text handed to the agent when the prompt is submitted. */
  body: string;
  /** Optional source path for provenance (filename for "file", page path for "page"). */
  path?: string;
}

interface AIPanelStore {
  jobId: string | null;
  messages: ConversationMessage[];
  lastSeq: number;
  inputDraft: string;
  isStreaming: boolean;
  activeAgent: "general" | "editor" | string;
  /** Pending contexts shown as pills above the prompt input. */
  contexts: ContextPill[];

  setJobId: (jobId: string | null) => void;
  addMessage: (message: ConversationMessage) => void;
  setInputDraft: (draft: string) => void;
  setIsStreaming: (streaming: boolean) => void;
  setActiveAgent: (agent: string) => void;
  setLastSeq: (seq: number) => void;
  clearMessages: () => void;
  addContext: (ctx: ContextPill) => void;
  removeContext: (index: number) => void;
  clearContexts: () => void;
}

export const useAIPanelStore = create<AIPanelStore>((set) => ({
  jobId: null,
  messages: [],
  lastSeq: 0,
  inputDraft: "",
  isStreaming: false,
  activeAgent: "general",
  contexts: [],

  setJobId: (jobId) => set({ jobId }),
  // Stamp every inbound message with the current wall clock unless
  //  the caller already provided one. The AI panel's `mono` timestamp
  //  row under each user bubble reads this field; missing fields are
  //  tolerated so older stream events don't crash the log.
  addMessage: (message) =>
    set((s) => ({
      messages: [
        ...s.messages,
        message.type === "resume_divider" || (message as { timestamp?: number }).timestamp != null
          ? message
          : ({ ...(message as object), timestamp: Date.now() } as ConversationMessage),
      ],
    })),
  setInputDraft: (draft) => set({ inputDraft: draft }),
  setIsStreaming: (streaming) => set({ isStreaming: streaming }),
  setActiveAgent: (agent) => set({ activeAgent: agent }),
  setLastSeq: (seq) => set({ lastSeq: seq }),
  clearMessages: () => set({ messages: [], lastSeq: 0 }),
  addContext: (ctx) => set((s) => ({ contexts: [...s.contexts, ctx] })),
  removeContext: (index) => set((s) => ({ contexts: s.contexts.filter((_, i) => i !== index) })),
  clearContexts: () => set({ contexts: [] }),
}));
