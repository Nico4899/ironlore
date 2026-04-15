import { create } from "zustand";

export type ConversationMessage =
  | { type: "user"; text: string; attachments: string[] }
  | { type: "assistant"; text: string }
  | { type: "tool_call"; tool: string; args: unknown; result?: unknown; collapsed: boolean }
  | { type: "journal"; text: string }
  | { type: "diff_preview"; pageId: string; diff: string; approved: boolean | null }
  | {
      type: "run_finalized";
      runId: string;
      agentSlug: string;
      commitShaStart: string;
      commitShaEnd: string;
      filesChanged: string[];
      revertedAt: number | null;
    }
  | { type: "error"; text: string };

interface AIPanelStore {
  jobId: string | null;
  messages: ConversationMessage[];
  lastSeq: number;
  inputDraft: string;
  isStreaming: boolean;
  activeAgent: "general" | "editor" | string;

  setJobId: (jobId: string | null) => void;
  addMessage: (message: ConversationMessage) => void;
  setInputDraft: (draft: string) => void;
  setIsStreaming: (streaming: boolean) => void;
  setActiveAgent: (agent: string) => void;
  setLastSeq: (seq: number) => void;
  clearMessages: () => void;
}

export const useAIPanelStore = create<AIPanelStore>((set) => ({
  jobId: null,
  messages: [],
  lastSeq: 0,
  inputDraft: "",
  isStreaming: false,
  activeAgent: "general",

  setJobId: (jobId) => set({ jobId }),
  addMessage: (message) => set((s) => ({ messages: [...s.messages, message] })),
  setInputDraft: (draft) => set({ inputDraft: draft }),
  setIsStreaming: (streaming) => set({ isStreaming: streaming }),
  setActiveAgent: (agent) => set({ activeAgent: agent }),
  setLastSeq: (seq) => set({ lastSeq: seq }),
  clearMessages: () => set({ messages: [], lastSeq: 0 }),
}));
