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
import { useWorkspaceActivity } from "../hooks/useWorkspaceActivity.js";
import { getApiProject, revertJob, submitDryRunVerdict } from "../lib/api.js";
import { type ContextPill, useAIPanelStore } from "../stores/ai-panel.js";
import { useAppStore } from "../stores/app.js";
import { CostEstimateDialog } from "./CostEstimateDialog.js";
import { DiffPreview } from "./DiffPreview.js";
import {
  AgentPulse,
  Blockref,
  Key,
  Meta,
  ProvenanceStrip,
  StatusPip,
} from "./primitives/index.js";

/**
 * Storage key pattern for cost-estimate acknowledgement per agent slug.
 * Once the user confirms the estimate for an agent, the dialog skips
 * for the rest of the session — the intent is a heads-up on first
 * use, not a ceremony on every message.
 */
const COST_ACK_KEY = (slug: string) => `ironlore.costEstimate.acknowledged.${slug}`;

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

  // Cost-estimate dialog state. The first user send of each session
  // for a given agent gates through this dialog; subsequent sends
  // skip it. sessionStorage clears on tab close, so reopening the
  // app re-shows the estimate — intentional since pricing could
  // change between sessions.
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [costDialogOpen, setCostDialogOpen] = useState(false);

  const doSend = useCallback(
    (fullPrompt: string) => {
      sendMessage(fullPrompt);
      setInputDraft("");
      useAIPanelStore.getState().clearContexts();
    },
    [sendMessage, setInputDraft],
  );

  const handleSend = useCallback(() => {
    const draft = inputDraft.trim();
    if (!draft && contexts.length === 0) return;
    // Build the full prompt including any context pills.
    const contextBlock =
      contexts.length > 0
        ? `${contexts.map((c) => `[${c.kind}: ${c.label}]\n${c.body}`).join("\n\n")}\n\n`
        : "";
    const fullPrompt = contextBlock + draft;

    // Cost-estimate gate: show on the first send per agent per
    // session. Any read/write failure of sessionStorage just skips
    // the dialog — estimate is informational, not a safety rail.
    let alreadyAcknowledged = false;
    try {
      alreadyAcknowledged = window.sessionStorage.getItem(COST_ACK_KEY(activeAgent)) === "1";
    } catch {
      alreadyAcknowledged = true;
    }

    if (!alreadyAcknowledged) {
      setPendingPrompt(fullPrompt);
      setCostDialogOpen(true);
      return;
    }

    doSend(fullPrompt);
  }, [inputDraft, contexts, activeAgent, doSend]);

  const handleCostConfirm = useCallback(() => {
    try {
      window.sessionStorage.setItem(COST_ACK_KEY(activeAgent), "1");
    } catch {
      /* storage denied — don't block the send */
    }
    setCostDialogOpen(false);
    if (pendingPrompt !== null) {
      doSend(pendingPrompt);
      setPendingPrompt(null);
    }
  }, [activeAgent, pendingPrompt, doSend]);

  const handleCostCancel = useCallback(() => {
    setCostDialogOpen(false);
    setPendingPrompt(null);
  }, []);

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

  // Pull the step label for the active agent from the shared workspace
  //  poller so the header counter tracks the same "step NN" value the
  //  sidebar and Home's Active runs see. `stepLabel` is null when the
  //  agent isn't running — we only render the Meta cluster then.
  const { agents } = useWorkspaceActivity();
  const stepLabel = agents.find((a) => a.slug === activeAgent)?.stepLabel ?? null;

  return (
    <aside
      className="flex shrink-0 flex-col border-l border-border bg-ironlore-slate-elevated"
      style={{
        width: "380px",
        boxShadow: "inset 1px 0 0 var(--color-border), -4px 0 12px oklch(0 0 0 / 0.15)",
      }}
      aria-label="AI panel"
    >
      {/* Header — matches screen-editor.jsx AI panel header:
       *   · StatusPip (Reuleaux inside) for running/idle state
       *   · agent slug as a button → opens detail page
       *   · Meta k="step" v="NN" while streaming, pulled from
       *     useWorkspaceActivity so it matches sidebar + Home counters
       *   · right-aligned ⌘⇧A Key chip as the discoverability hint for
       *     the global AI-panel toggle shortcut
       * Wrapped in AgentPulse so the 3.2 s sweep rides the bottom rule
       * while the agent streams. */}
      <AgentPulse active={isStreaming}>
        <div
          className="flex items-center gap-2 border-b border-border"
          style={{ height: 36, padding: "0 14px" }}
        >
          <StatusPip state={isStreaming ? "running" : "idle"} size={11} />
          <button
            type="button"
            onClick={() => useAppStore.getState().setActiveAgentSlug(activeAgent)}
            className="il-ai-slug rounded border border-transparent px-1 py-0.5 outline-none transition-colors hover:border-border hover:bg-ironlore-slate-hover focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
            title={`Open ${activeAgent} detail page`}
          >
            {activeAgent}
          </button>
          {stepLabel && <Meta k="step" v={stepLabel.replace(/^step\s+/, "")} />}
          <span className="flex-1" />
          <Key>⌘⇧A</Key>
        </div>
      </AgentPulse>

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

      {/*
       * Composer — wrapped in AgentPulse so the 3.2s sweep runs across
       * the input box while the agent streams. Per
       * docs/09-ui-and-brand.md §Signature motifs / Agent pulse, the
       * composer is the canonical "live surface" during streaming.
       * `.il-pulse::before` is an absolute overlay so it needs a
       * position-relative + overflow-hidden host — the pulse wrapper
       * is that host, the border wrapper sits inside it unchanged.
       */}
      <AgentPulse active={isStreaming} className="border-t border-border p-3">
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
      </AgentPulse>
      {costDialogOpen && (
        <CostEstimateDialog
          agentSlug={activeAgent}
          onConfirm={handleCostConfirm}
          onCancel={handleCostCancel}
        />
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Empty state — three cards laid out 2 + 1.
// ---------------------------------------------------------------------------

function AgentPauseBanner({ slug }: { slug: string }) {
  const [paused, setPaused] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  // Re-check whenever a run ends — a fresh failure streak may have
  // tripped the pause rail mid-session. The original version only
  // fetched on mount, so users saw a stale "active" banner until
  // they refreshed.
  const isStreaming = useAIPanelStore((s) => s.isStreaming);

  // biome-ignore lint/correctness/useExhaustiveDependencies: isStreaming is the trigger, not a value read inside
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${getApiProject()}/agents/${slug}/state`)
      .then((r) => r.json())
      .then((data: { canRun: boolean; reason: string | null }) => {
        if (cancelled) return;
        if (!data.canRun) {
          setPaused(true);
          setReason(data.reason);
        } else {
          setPaused(false);
          setReason(null);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [slug, isStreaming]);

  const handleResume = useCallback(async () => {
    if (resuming) return;
    setResuming(true);
    try {
      const res = await fetch(`/api/projects/${getApiProject()}/agents/${slug}/state`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: false }),
      });
      if (res.ok) {
        setPaused(false);
        setReason(null);
      }
    } catch {
      // Resume failed — keep the banner visible, user can retry.
    } finally {
      setResuming(false);
    }
  }, [slug, resuming]);

  if (!paused) return null;

  return (
    <div className="flex items-center gap-2 border-b border-signal-amber/30 bg-signal-amber/10 px-4 py-2 text-xs text-signal-amber">
      <span className="font-semibold">Agent paused</span>
      {reason && <span className="text-secondary">— {reason}</span>}
      <button
        type="button"
        onClick={handleResume}
        disabled={resuming}
        className="ml-auto rounded border border-signal-amber/50 px-2 py-0.5 text-[10px] font-medium text-signal-amber hover:bg-signal-amber/15 disabled:opacity-50"
      >
        {resuming ? "Resuming\u2026" : "Resume"}
      </button>
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
                const jobId = useAIPanelStore.getState().jobId;
                if (!jobId || !msg.toolCallId) return;
                // Mark locally before the round-trip so the buttons
                // hide immediately; the server call is best-effort,
                // because if the bridge has already timed out there's
                // nothing the user can do to un-timeout it.
                const msgs = useAIPanelStore.getState().messages;
                const target = msgs[i];
                if (target?.type === "diff_preview") {
                  (target as { approved: boolean | null }).approved = true;
                  useAIPanelStore.setState({ messages: [...msgs] });
                }
                void submitDryRunVerdict(jobId, msg.toolCallId, "approve").catch(() => {
                  // Swallow — the verdict is a best-effort unblock.
                });
              }}
              onReject={() => {
                const jobId = useAIPanelStore.getState().jobId;
                if (!jobId || !msg.toolCallId) return;
                const msgs = useAIPanelStore.getState().messages;
                const target = msgs[i];
                if (target?.type === "diff_preview") {
                  (target as { approved: boolean | null }).approved = false;
                  useAIPanelStore.setState({ messages: [...msgs] });
                }
                void submitDryRunVerdict(jobId, msg.toolCallId, "reject").catch(() => {});
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
 *
 * Renders a ProvenanceStrip above the card body — this is the one
 * conversation message where we have all four inputs the strip needs:
 * the agent slug, a landing moment (we treat receipt of the message
 * as the timestamp), the list of changed files (as sources), and an
 * implicit trust state (`stale` once reverted, `fresh` otherwise).
 * Per docs/09-ui-and-brand.md §Signature motifs / Provenance strip.
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

  const sourceChips = msg.filesChanged.slice(0, 4).map((f) => {
    // Show basename only — full paths push the trust badge off the strip.
    const base = f.split("/").pop() ?? f;
    return base;
  });
  const extraFiles = Math.max(0, msg.filesChanged.length - sourceChips.length);
  if (extraFiles > 0) sourceChips.push(`+${extraFiles}`);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-ironlore-slate-hover text-xs">
      <ProvenanceStrip
        agent={msg.agentSlug}
        timestamp="just now"
        sources={sourceChips}
        trust={reverted ? "stale" : "fresh"}
      />
      <div className="px-3 py-2">
        <div className="flex items-center justify-between">
          <div className="font-semibold text-primary">Run finalized</div>
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
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: deterministic regex split
            key={i}
            className="mx-0.5 inline-flex"
          >
            <Blockref
              page={p.page}
              block={p.blockId || undefined}
              onClick={() => useAppStore.getState().openProvenance(p.page, p.blockId)}
              title={`Open ${p.page}${p.blockId ? `#${p.blockId}` : ""}`}
            />
          </span>
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
