import { ArrowUp, Highlighter, Lightbulb, Paperclip, Sparkles, X } from "lucide-react";
import { useCallback, useRef } from "react";
import { type ContextPill, useAIPanelStore } from "../stores/ai-panel.js";

export function AIPanel() {
  const messages = useAIPanelStore((s) => s.messages);
  const activeAgent = useAIPanelStore((s) => s.activeAgent);
  const inputDraft = useAIPanelStore((s) => s.inputDraft);
  const setInputDraft = useAIPanelStore((s) => s.setInputDraft);
  const contexts = useAIPanelStore((s) => s.contexts);
  const removeContext = useAIPanelStore((s) => s.removeContext);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onFilesPicked = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const { addContext } = useAIPanelStore.getState();
    for (const file of Array.from(files)) {
      addContext({
        kind: "file",
        label: file.name,
        body: `Attached file: ${file.name}`,
        path: file.name,
      });
    }
    // Reset so selecting the same file again re-triggers onChange.
    e.target.value = "";
  }, []);

  const handleSend = useCallback(() => {
    const draft = inputDraft.trim();
    if (!draft && contexts.length === 0) return;
    const { addMessage, clearContexts } = useAIPanelStore.getState();
    const attachments = contexts.map((c) => c.label);
    addMessage({ type: "user", text: draft, attachments });
    setInputDraft("");
    clearContexts();
  }, [inputDraft, contexts, setInputDraft]);

  const onPromptKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const canSend = inputDraft.trim().length > 0 || contexts.length > 0;

  return (
    <aside
      className="flex shrink-0 flex-col border-l border-border bg-ironlore-slate"
      style={{ width: "380px" }}
      aria-label="AI panel"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-ironlore-blue" />
          <span className="text-sm font-semibold tracking-tight">AI</span>
        </div>
        <span className="text-xs font-medium text-secondary">{activeAgent}</span>
      </div>

      {/* Messages or empty state */}
      <div className="flex-1 overflow-y-auto px-4 py-4" role="log" aria-live="polite">
        {messages.length === 0 ? <AIEmptyState /> : <MessageList />}
      </div>

      {/* Context pills */}
      {contexts.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-border px-3 py-2">
          {contexts.map((ctx, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: pills are append-only and never reorder
            <ContextChip key={i} ctx={ctx} onRemove={() => removeContext(i)} />
          ))}
        </div>
      )}

      {/* Input */}
      <div className="border-t border-border p-3">
        <div className="relative flex items-end gap-2 rounded-lg border border-border bg-background px-2 py-1.5 focus-within:border-ironlore-blue">
          <button
            type="button"
            onClick={openFilePicker}
            aria-label="Attach a local file"
            title="Attach a local file"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
          >
            <Paperclip className="h-4 w-4" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={onFilesPicked}
          />
          <textarea
            className="flex-1 resize-none bg-transparent py-1.5 text-sm text-primary placeholder:text-secondary focus:outline-none"
            placeholder="Ask about your knowledge base…"
            value={inputDraft}
            rows={1}
            onChange={(e) => setInputDraft(e.target.value)}
            onKeyDown={onPromptKeyDown}
            style={{ minHeight: "28px", maxHeight: "160px" }}
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            aria-label="Send message"
            title="Send (⌘↵)"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-ironlore-blue text-white shadow-sm transition-opacity hover:bg-ironlore-blue-strong disabled:cursor-not-allowed disabled:opacity-30"
          >
            <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
          </button>
        </div>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Empty state — three cards laid out 2 + 1.
// ---------------------------------------------------------------------------

function AIEmptyState() {
  return (
    <div className="mx-auto flex h-full max-w-[320px] flex-col justify-center gap-3">
      <div className="grid grid-cols-2 gap-3">
        <EmptyCard
          icon={<Highlighter className="h-4 w-4 text-ironlore-blue" />}
          title="Highlight & Ask"
          body="Select any part of the page to ask specific questions."
        />
        <EmptyCard
          icon={<Sparkles className="h-4 w-4 text-accent-violet" />}
          title="Add Context"
          body={
            <>
              Type <code className="font-mono text-[11px]">@</code> to reference agents or other
              files and expand the discussion.
            </>
          }
        />
      </div>
      <EmptyCard
        icon={<Lightbulb className="h-4 w-4 text-signal-amber" />}
        title="Example Prompts"
        body={
          <ul className="mt-1 space-y-1 italic text-secondary">
            <li>“Summarise the Getting Started folder in five bullets.”</li>
            <li>“Find pages where we decided on the editor architecture.”</li>
            <li>“Draft a release note from yesterday's diffs.”</li>
          </ul>
        }
        wide
      />
    </div>
  );
}

interface EmptyCardProps {
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
  wide?: boolean;
}

function EmptyCard({ icon, title, body, wide }: EmptyCardProps) {
  return (
    <div
      className={`rounded-lg border border-border bg-ironlore-slate-hover/40 p-3 text-xs ${wide ? "col-span-2" : ""}`}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        {icon}
        <span className="font-semibold text-primary">{title}</span>
      </div>
      <div className="text-secondary">{body}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Messages (rendered when the conversation is non-empty).
// ---------------------------------------------------------------------------

function MessageList() {
  const messages = useAIPanelStore((s) => s.messages);
  return (
    <>
      {messages.map((msg, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: messages are append-only, no stable ID yet
        <div key={i} className="mb-3 text-sm">
          {msg.type === "user" && (
            <div className="rounded-lg bg-ironlore-blue/15 px-3 py-2 text-primary">{msg.text}</div>
          )}
          {msg.type === "assistant" && (
            <div className="px-1 leading-relaxed text-primary">{msg.text}</div>
          )}
          {msg.type === "error" && (
            <div className="rounded-lg bg-signal-red/10 px-3 py-2 text-signal-red">{msg.text}</div>
          )}
          {msg.type === "run_finalized" && (
            <div className="rounded-lg border border-border bg-ironlore-slate-hover px-3 py-2 text-xs">
              <div className="font-semibold text-primary">Run finalized · {msg.agentSlug}</div>
              <div className="mt-0.5 text-secondary">
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
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Context chip above the prompt input.
// ---------------------------------------------------------------------------

interface ContextChipProps {
  ctx: ContextPill;
  onRemove: () => void;
}

function ContextChip({ ctx, onRemove }: ContextChipProps) {
  const icon =
    ctx.kind === "highlight" ? (
      <Highlighter className="h-3 w-3 text-ironlore-blue" />
    ) : ctx.kind === "file" ? (
      <Paperclip className="h-3 w-3 text-accent-violet" />
    ) : (
      <Sparkles className="h-3 w-3 text-accent-violet" />
    );

  return (
    <div className="group flex max-w-full items-center gap-1.5 rounded-full border border-border bg-background py-0.5 pl-2 pr-1 text-[11px] text-secondary">
      {icon}
      <span className="max-w-[180px] truncate font-medium text-primary">{ctx.label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove context: ${ctx.label}`}
        className="flex h-4 w-4 items-center justify-center rounded-full text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
