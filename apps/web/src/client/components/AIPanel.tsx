import {
  ArrowUp,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Highlighter,
  Lightbulb,
  Paperclip,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAgentSession } from "../hooks/useAgentSession.js";
import { revertJob } from "../lib/api.js";
import { type ContextPill, useAIPanelStore } from "../stores/ai-panel.js";
import { useAppStore } from "../stores/app.js";
import { DiffPreview } from "./DiffPreview.js";

export function AIPanel() {
  const messages = useAIPanelStore((s) => s.messages);
  const activeAgent = useAIPanelStore((s) => s.activeAgent);
  const inputDraft = useAIPanelStore((s) => s.inputDraft);
  const setInputDraft = useAIPanelStore((s) => s.setInputDraft);
  const isStreaming = useAIPanelStore((s) => s.isStreaming);
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

  const { sendMessage } = useAgentSession();

  const handleSend = useCallback(() => {
    const draft = inputDraft.trim();
    if (!draft && contexts.length === 0) return;
    // Build the full prompt including any context pills.
    const contextBlock =
      contexts.length > 0
        ? `${contexts.map((c) => `[${c.kind}: ${c.label}]\n${c.body}`).join("\n\n")}\n\n`
        : "";
    const fullPrompt = contextBlock + draft;
    sendMessage(fullPrompt);
    setInputDraft("");
    useAIPanelStore.getState().clearContexts();
  }, [inputDraft, contexts, setInputDraft, sendMessage]);

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
      className="flex shrink-0 flex-col border-l border-border bg-ironlore-slate-elevated"
      style={{
        width: "380px",
        boxShadow: "inset 1px 0 0 var(--color-border), -4px 0 12px oklch(0 0 0 / 0.15)",
      }}
      aria-label="AI panel"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Sparkles
            className={`h-4 w-4 ${isStreaming ? "animate-pulse text-ironlore-blue-strong" : "text-ironlore-blue"}`}
          />
          <span className="text-sm font-semibold tracking-tight">AI</span>
          {isStreaming && (
            <span className="text-[10px] font-medium text-ironlore-blue">thinking…</span>
          )}
        </div>
        <span className="text-xs font-medium text-secondary">{activeAgent}</span>
      </div>

      {/* Auto-pause banner */}
      <AgentPauseBanner slug={activeAgent} />

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

function AgentPauseBanner({ slug }: { slug: string }) {
  const [paused, setPaused] = useState(false);
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/projects/main/agents/${slug}/state`)
      .then((r) => r.json())
      .then((data: { canRun: boolean; reason: string | null }) => {
        if (!data.canRun) {
          setPaused(true);
          setReason(data.reason);
        } else {
          setPaused(false);
        }
      })
      .catch(() => {});
  }, [slug]);

  if (!paused) return null;

  return (
    <div className="flex items-center gap-2 border-b border-signal-amber/30 bg-signal-amber/10 px-4 py-2 text-xs text-signal-amber">
      <span className="font-semibold">Agent paused</span>
      {reason && <span className="text-secondary">— {reason}</span>}
    </div>
  );
}

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
            <div className="px-1 leading-relaxed text-primary">
              <CitationText text={msg.text} />
            </div>
          )}
          {msg.type === "tool_call" && <ToolCallCard msg={msg} />}
          {msg.type === "journal" && (
            <div className="rounded-lg border border-ironlore-blue/30 bg-ironlore-blue/5 px-3 py-2">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-ironlore-blue">
                <BookOpen className="h-3.5 w-3.5" />
                Journal
              </div>
              <div className="text-xs leading-relaxed text-primary">{msg.text}</div>
            </div>
          )}
          {msg.type === "diff_preview" && (
            <DiffPreview
              pageId={msg.pageId}
              diff={msg.diff}
              approved={msg.approved}
              onApprove={() => {
                const msgs = useAIPanelStore.getState().messages;
                const target = msgs[i];
                if (target?.type === "diff_preview") {
                  (target as { approved: boolean | null }).approved = true;
                  useAIPanelStore.setState({ messages: [...msgs] });
                }
              }}
              onReject={() => {
                const msgs = useAIPanelStore.getState().messages;
                const target = msgs[i];
                if (target?.type === "diff_preview") {
                  (target as { approved: boolean | null }).approved = false;
                  useAIPanelStore.setState({ messages: [...msgs] });
                }
              }}
            />
          )}
          {msg.type === "error" && (
            <div className="rounded-lg bg-signal-red/10 px-3 py-2 text-signal-red">{msg.text}</div>
          )}
          {msg.type === "run_finalized" && <RunFinalizedCard msg={msg} />}
          {msg.type === "resume_divider" && (
            <div className="flex items-center gap-2 py-1 text-[10px] text-secondary">
              <div className="h-px flex-1 bg-border" />
              Resuming conversation
              <div className="h-px flex-1 bg-border" />
            </div>
          )}
        </div>
      ))}
    </>
  );
}

/**
 * Collapsible tool-call card. Shows tool name + collapsed args by
 * default; clicking expands to show the full args JSON + result.
 */
function ToolCallCard({
  msg,
}: {
  msg: { tool: string; args: unknown; result?: unknown; collapsed: boolean };
}) {
  const [expanded, setExpanded] = useState(!msg.collapsed);
  const hasResult = msg.result !== undefined;

  return (
    <div className="rounded-lg border border-border bg-ironlore-slate-hover/50 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-secondary" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-secondary" />
        )}
        <Wrench className="h-3.5 w-3.5 shrink-0 text-accent-violet" />
        <span className="font-semibold text-primary">{msg.tool}</span>
        {hasResult && <span className="ml-auto text-[10px] text-signal-green">done</span>}
      </button>
      {expanded && (
        <div className="border-t border-border px-3 py-2">
          <div className="mb-1 text-[10px] font-medium uppercase text-secondary">Args</div>
          <pre className="mb-2 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-secondary">
            {typeof msg.args === "string" ? msg.args : JSON.stringify(msg.args, null, 2)}
          </pre>
          {hasResult && (
            <>
              <div className="mb-1 text-[10px] font-medium uppercase text-secondary">Result</div>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-primary">
                {typeof msg.result === "string" ? msg.result : JSON.stringify(msg.result, null, 2)}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context chip above the prompt input.
// ---------------------------------------------------------------------------

interface ContextChipProps {
  ctx: ContextPill;
  onRemove: () => void;
}

/**
 * Run-finalized card with optional Revert button.
 */
function RunFinalizedCard({
  msg,
}: {
  msg: {
    runId: string;
    agentSlug: string;
    commitShaStart: string;
    commitShaEnd: string;
    filesChanged: string[];
    revertedAt: number | null;
  };
}) {
  const [reverting, setReverting] = useState(false);
  const [reverted, setReverted] = useState(msg.revertedAt !== null);
  const [revertError, setRevertError] = useState<string | null>(null);

  const handleRevert = async () => {
    if (reverting || reverted) return;
    setReverting(true);
    setRevertError(null);
    try {
      const result = await revertJob(msg.runId);
      if (result.success) {
        setReverted(true);
      } else {
        setRevertError(result.error ?? "Revert failed");
      }
    } catch (err) {
      setRevertError((err as Error).message);
    } finally {
      setReverting(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-ironlore-slate-hover px-3 py-2 text-xs">
      <div className="flex items-center justify-between">
        <div className="font-semibold text-primary">Run finalized · {msg.agentSlug}</div>
        {!reverted && msg.commitShaStart && msg.commitShaEnd && (
          <button
            type="button"
            disabled={reverting}
            onClick={handleRevert}
            className="rounded border border-border px-2 py-0.5 text-[10px] text-secondary hover:bg-ironlore-slate hover:text-primary disabled:opacity-50"
          >
            {reverting ? "Reverting\u2026" : "Revert this run"}
          </button>
        )}
      </div>
      <div className="mt-0.5 text-secondary">
        {msg.filesChanged.length} file{msg.filesChanged.length === 1 ? "" : "s"}
        {" \u00B7 "}
        <code className="font-mono">{msg.commitShaStart.slice(0, 7)}</code>
        {"\u2026"}
        <code className="font-mono">{msg.commitShaEnd.slice(0, 7)}</code>
        {reverted && " \u00B7 reverted"}
      </div>
      {revertError && <div className="mt-1 text-signal-red">{revertError}</div>}
    </div>
  );
}

/**
 * Render text with clickable `[[Page#blk_…]]` citations.
 * Clicking a citation opens the provenance pane scrolled to that block.
 */
function CitationText({ text }: { text: string }) {
  const CITATION_RE = /\[\[([^\]#]+)(?:#(blk_[A-Za-z0-9]+))?\]\]/g;

  const parts: Array<
    { kind: "text"; value: string } | { kind: "citation"; page: string; blockId: string }
  > = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null = CITATION_RE.exec(text);

  while (match !== null) {
    if (match.index > lastIndex) {
      parts.push({ kind: "text", value: text.slice(lastIndex, match.index) });
    }
    parts.push({ kind: "citation", page: match[1] ?? "", blockId: match[2] ?? "" });
    lastIndex = match.index + match[0].length;
    match = CITATION_RE.exec(text);
  }
  if (lastIndex < text.length) {
    parts.push({ kind: "text", value: text.slice(lastIndex) });
  }

  if (parts.length === 0) return <>{text}</>;

  return (
    <>
      {parts.map((p, i) =>
        p.kind === "text" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: deterministic regex split
          <span key={i}>{p.value}</span>
        ) : (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: deterministic regex split
            key={i}
            type="button"
            className="mx-0.5 inline rounded bg-ironlore-blue/15 px-1 py-0.5 text-xs font-medium text-ironlore-blue hover:bg-ironlore-blue/25"
            onClick={() => useAppStore.getState().openProvenance(p.page, p.blockId)}
            title={`Open ${p.page}${p.blockId ? `#${p.blockId}` : ""}`}
          >
            {p.page}
            {p.blockId ? `#${p.blockId.slice(0, 10)}…` : ""}
          </button>
        ),
      )}
    </>
  );
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
      <span className="max-w-45 truncate font-medium text-primary">{ctx.label}</span>
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
