import { create } from "zustand";

export type ConversationMessage =
  | { type: "user"; text: string; attachments: string[] }
  | { type: "assistant"; text: string }
  | { type: "tool_call"; tool: string; args: unknown; result?: unknown; collapsed: boolean }
  | { type: "journal"; text: string }
  | {
      type: "diff_preview";
      /** The tool-call ID the dispatcher is waiting on. */
      toolCallId: string;
      /** Tool name for display (kb.replace_block, kb.insert_after, kb.delete_block). */
      tool: string;
      pageId: string;
      diff: string;
      approved: boolean | null;
    }
  | {
      type: "run_finalized";
      runId: string;
      agentSlug: string;
      commitShaStart: string;
      commitShaEnd: string;
      filesChanged: string[];
      revertedAt: number | null;
    }
  | { type: "error"; text: string }
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
  addMessage: (message) => set((s) => ({ messages: [...s.messages, message] })),
  setInputDraft: (draft) => set({ inputDraft: draft }),
  setIsStreaming: (streaming) => set({ isStreaming: streaming }),
  setActiveAgent: (agent) => set({ activeAgent: agent }),
  setLastSeq: (seq) => set({ lastSeq: seq }),
  clearMessages: () => set({ messages: [], lastSeq: 0 }),
  addContext: (ctx) => set((s) => ({ contexts: [...s.contexts, ctx] })),
  removeContext: (index) => set((s) => ({ contexts: s.contexts.filter((_, i) => i !== index) })),
  clearContexts: () => set({ contexts: [] }),
}));
