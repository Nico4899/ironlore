import { create } from "zustand";

/**
 * Canonical budget cap shared with the server executor
 * (apps/web/src/server/agents/executor.ts line 113). The
 * composer's context-budget chip divides `tokensUsed` by this
 * number so the % reads against the same limit that ultimately
 * trips `budget.exhausted`.
 */
export const AGENT_TOKEN_BUDGET = 100_000;

export type EffortLevel = "low" | "medium" | "high";

/** LocalStorage keys — follow the `ironlore.<setting>` prefix pattern. */
const EFFORT_KEY = "ironlore.aiPanel.effort";
const INCLUDE_ACTIVE_FILE_KEY = "ironlore.aiPanel.includeActiveFile";

function loadEffort(): EffortLevel {
  try {
    const raw = window.localStorage.getItem(EFFORT_KEY);
    if (raw === "low" || raw === "medium" || raw === "high") return raw;
  } catch {
    /* storage denied */
  }
  return "medium";
}

function persistEffort(value: EffortLevel): void {
  try {
    window.localStorage.setItem(EFFORT_KEY, value);
  } catch {
    /* storage denied */
  }
}

/**
 * Initial `activeAgent`. Reads the persisted `defaultAgent` the user
 * set in Settings → General; falls back to `"general"` on a fresh
 * install. Kept as a plain helper (not a store import) so we can
 * read localStorage directly without pulling the app store into a
 * circular dep.
 */
function loadInitialActiveAgent(): string {
  try {
    const raw = window.localStorage.getItem("ironlore.defaultAgent");
    if (raw && raw.length > 0) return raw;
  } catch {
    /* storage denied */
  }
  return "general";
}

function loadIncludeActiveFile(): boolean {
  try {
    const raw = window.localStorage.getItem(INCLUDE_ACTIVE_FILE_KEY);
    if (raw === "0") return false;
    if (raw === "1") return true;
  } catch {
    /* storage denied */
  }
  return true;
}

function persistIncludeActiveFile(value: boolean): void {
  try {
    window.localStorage.setItem(INCLUDE_ACTIVE_FILE_KEY, value ? "1" : "0");
  } catch {
    /* storage denied */
  }
}

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
      /**
       * Milliseconds between the call's start (`timestamp`) and the
       * moment the result landed. Stamped once by `useAgentSession`
       * when the tool-call result message arrives over the WS stream;
       * the `ToolCallCard` surfaces it as the StatusPip's right-edge
       * label (`180ms`).
       */
      durationMs?: number;
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
  | {
      /**
       * Phase-11 Airlock — emitted when `kb.global_search` returns a
       * foreign-project hit and the run's egress is downgraded to
       * offline for the rest of the conversation. Subsequent
       * provider + connector calls throw `EgressDowngradedError`. The
       * banner is one-shot per run — duplicate `egress.downgraded`
       * events fold into the existing card.
       */
      type: "egress_downgraded";
      reason: string;
      at: string | null;
      timestamp?: number;
    }
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
  /**
   * Cumulative tokens consumed by the current run. Reset at the start
   * of each send, incremented each time a provider `usage` event
   * arrives (see useAgentSession.ts). The composer's context-budget
   * chip divides by AGENT_TOKEN_BUDGET for the % remaining readout.
   */
  tokensUsed: number;
  /**
   * Effort level forwarded to the agent run. Persisted in localStorage
   * so user preference survives reloads.
   */
  effort: EffortLevel;
  /**
   * When true, the currently-open editor file is auto-attached as a
   * context pill on send. Toggle lives in the composer toolbar (eye
   * icon + filename). Persisted.
   */
  includeActiveFileAsContext: boolean;
  /**
   * Per-conversation runtime override pinned by the user via the
   * composer's `/model` / `/provider` slash commands. Lives next to
   * the persona/global resolution chain — see
   * [provider-resolution.ts](../../../packages/core/src/provider-resolution.ts)
   * for the precedence rules. Cleared on agent switch.
   */
  runtimeOverride: {
    provider?: "anthropic" | "ollama" | "openai" | "claude-cli";
    model?: string;
  };
  /**
   * Last `provider.resolved` event from the executor. Drives the
   * "resolved as: <model> (from <level>)" chip in the AI panel
   * header so the user can see exactly which override fired.
   * Cleared on agent switch and on each new send.
   */
  lastResolution: {
    provider: string;
    model: string;
    effort: string;
    source: { provider: string; model: string; effort: string };
    notes: string[];
  } | null;

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
  incrementTokens: (n: number) => void;
  resetTokens: () => void;
  setEffort: (effort: EffortLevel) => void;
  setIncludeActiveFileAsContext: (value: boolean) => void;
  setRuntimeOverride: (override: AIPanelStore["runtimeOverride"]) => void;
  setLastResolution: (r: AIPanelStore["lastResolution"]) => void;
}

export const useAIPanelStore = create<AIPanelStore>((set) => ({
  jobId: null,
  messages: [],
  lastSeq: 0,
  inputDraft: "",
  isStreaming: false,
  activeAgent: loadInitialActiveAgent(),
  contexts: [],
  tokensUsed: 0,
  effort: loadEffort(),
  includeActiveFileAsContext: loadIncludeActiveFile(),
  runtimeOverride: {},
  lastResolution: null,

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
  setActiveAgent: (agent) =>
    set({ activeAgent: agent, runtimeOverride: {}, lastResolution: null }),
  setLastSeq: (seq) => set({ lastSeq: seq }),
  clearMessages: () => set({ messages: [], lastSeq: 0 }),
  addContext: (ctx) => set((s) => ({ contexts: [...s.contexts, ctx] })),
  removeContext: (index) => set((s) => ({ contexts: s.contexts.filter((_, i) => i !== index) })),
  clearContexts: () => set({ contexts: [] }),
  incrementTokens: (n) => set((s) => ({ tokensUsed: s.tokensUsed + n })),
  resetTokens: () => set({ tokensUsed: 0 }),
  setEffort: (effort) => {
    persistEffort(effort);
    set({ effort });
  },
  setIncludeActiveFileAsContext: (value) => {
    persistIncludeActiveFile(value);
    set({ includeActiveFileAsContext: value });
  },
  setRuntimeOverride: (override) => set({ runtimeOverride: override }),
  setLastResolution: (r) => set({ lastResolution: r }),
}));
