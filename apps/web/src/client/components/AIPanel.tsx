import { useAIPanelStore } from "../stores/ai-panel.js";

export function AIPanel() {
  const messages = useAIPanelStore((s) => s.messages);
  const activeAgent = useAIPanelStore((s) => s.activeAgent);
  const inputDraft = useAIPanelStore((s) => s.inputDraft);
  const setInputDraft = useAIPanelStore((s) => s.setInputDraft);

  return (
    <aside
      className="flex shrink-0 flex-col border-l border-border bg-ironlore-slate"
      style={{ width: "380px" }}
      aria-label="AI panel"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <span className="text-sm font-medium">AI</span>
        <span className="text-xs text-secondary">{activeAgent}</span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3" role="log" aria-live="polite">
        {messages.length === 0 ? (
          <p className="text-xs text-secondary">Ask about your knowledge base...</p>
        ) : (
          messages.map((msg, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: messages are append-only, no stable ID yet
            <div key={i} className="mb-3 text-sm">
              {msg.type === "user" && (
                <div className="rounded bg-ironlore-blue/10 px-3 py-2">{msg.text}</div>
              )}
              {msg.type === "assistant" && <div className="px-1">{msg.text}</div>}
              {msg.type === "error" && (
                <div className="rounded bg-signal-red/10 px-3 py-2 text-signal-red">{msg.text}</div>
              )}
              {msg.type === "run_finalized" && (
                <div className="rounded border border-border bg-ironlore-slate-hover px-3 py-2 text-xs text-secondary">
                  <div className="font-medium text-primary">
                    Run finalized · {msg.agentSlug}
                  </div>
                  <div className="mt-0.5">
                    {msg.filesChanged.length} file{msg.filesChanged.length === 1 ? "" : "s"}
                    {" · "}
                    <code className="font-mono">{msg.commitShaStart.slice(0, 7)}</code>
                    {"…"}
                    <code className="font-mono">{msg.commitShaEnd.slice(0, 7)}</code>
                    {msg.revertedAt !== null && " · reverted"}
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Input */}
      <div className="border-t border-border p-3">
        <input
          type="text"
          className="w-full rounded border border-border bg-transparent px-3 py-2 text-sm placeholder:text-secondary focus:border-ironlore-blue focus:outline-none"
          placeholder="Ask about your knowledge base..."
          value={inputDraft}
          onChange={(e) => setInputDraft(e.target.value)}
        />
      </div>
    </aside>
  );
}
