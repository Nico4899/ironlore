import { ArrowUp } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAgentSession } from "../hooks/useAgentSession.js";
import { type AgentConfigResponse, fetchAgentConfig } from "../lib/api.js";
import { type ContextPill, useAIPanelStore } from "../stores/ai-panel.js";
import { useAppStore } from "../stores/app.js";
import { useEditorStore } from "../stores/editor.js";
import { ContextBudgetChip } from "./ai-composer/ContextBudgetChip.js";
import { type MentionCandidate, MentionPicker } from "./ai-composer/MentionPicker.js";
import { MicButton } from "./ai-composer/MicButton.js";
import { OpenedFileToggle } from "./ai-composer/OpenedFileToggle.js";
import { PlusMenu } from "./ai-composer/PlusMenu.js";
import { type SlashAction, SlashMenu } from "./ai-composer/SlashMenu.js";
import { CostEstimateDialog } from "./CostEstimateDialog.js";
import { AgentPulse } from "./primitives/index.js";

/**
 * Reusable AI composer — extracted from `AIPanel.tsx` so the same
 * surface can render in two places:
 *
 * 1. The AI panel (when no markdown file is open — fallback so the
 *    user always has a way to start a conversation).
 * 2. Inline below the editor surface
 *    ([`InlineAIComposerLauncher`](./editor/InlineAIComposerLauncher.tsx)),
 *    which is the primary entry point when a file is open per the
 *    "panel = conversation only, composer = at the file" UX in
 *    docs/03-editor.md §Inline AI composer.
 *
 * The component is self-contained:
 * - Reads composer state from `useAIPanelStore` (single source of truth
 *   shared across both surfaces).
 * - Reads `selectedBlockIds` / `filePath` / `markdown` from `useEditorStore`
 *   for selection-as-AI-context per docs/03-editor.md.
 * - Calls `useAgentSession.sendMessage()` directly — no callback wiring
 *   required by the host.
 * - Owns the cost-estimate gate (sessionStorage-backed first-run
 *   acknowledgement) so the dialog moves with the composer.
 *
 * `onAfterSubmit` fires once per successful send (i.e. after the
 * cost dialog if it was shown, OR immediately if it wasn't). Hosts
 * use this to collapse a launcher / open the AI panel / animate
 * focus elsewhere. Cancellation of the cost dialog does **not** fire
 * the callback.
 */

interface AIComposerProps {
  /**
   * Called once per successful send, after `sendMessage()` fires
   * and the composer's local state has been reset. The inline
   * launcher uses this to auto-collapse + open the AI panel; the
   * AI-panel surface ignores it.
   */
  onAfterSubmit?: () => void;
}

const COST_ACK_KEY = (slug: string) => `ironlore.costEstimate.acknowledged.${slug}`;

export function AIComposer({ onAfterSubmit }: AIComposerProps) {
  const activeAgent = useAIPanelStore((s) => s.activeAgent);
  const inputDraft = useAIPanelStore((s) => s.inputDraft);
  const setInputDraft = useAIPanelStore((s) => s.setInputDraft);
  const isStreaming = useAIPanelStore((s) => s.isStreaming);
  const contexts = useAIPanelStore((s) => s.contexts);
  const removeContext = useAIPanelStore((s) => s.removeContext);
  // Selection-as-AI-context per docs/03-editor.md §Selection as AI
  //  context. Block IDs covered by the current ProseMirror selection
  //  ride forward as a `[[<path>#<blockId>]]` highlight pill on the
  //  next send.
  const selectedBlockIds = useEditorStore((s) => s.selectedBlockIds);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [plusOpen, setPlusOpen] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionRange, setMentionRange] = useState<[number, number] | null>(null);

  const { sendMessage } = useAgentSession();

  const [costDialogOpen, setCostDialogOpen] = useState(false);
  const [pendingSend, setPendingSend] = useState<{
    display: string;
    server: string;
    attachments: string[];
  } | null>(null);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const insertAtCaret = useCallback(
    (ch: string) => {
      const el = textareaRef.current;
      if (!el) {
        setInputDraft(inputDraft + ch);
        return;
      }
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const next = inputDraft.slice(0, start) + ch + inputDraft.slice(end);
      setInputDraft(next);
      queueMicrotask(() => {
        el.focus();
        el.setSelectionRange(start + ch.length, start + ch.length);
      });
    },
    [inputDraft, setInputDraft],
  );

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
    e.target.value = "";
  }, []);

  const doSend = useCallback(
    (displayText: string, serverPrompt: string, attachmentLabels: string[]) => {
      sendMessage(displayText, serverPrompt, attachmentLabels);
      setInputDraft("");
      useAIPanelStore.getState().clearContexts();
      onAfterSubmit?.();
    },
    [sendMessage, setInputDraft, onAfterSubmit],
  );

  const handleSend = useCallback(() => {
    const draft = inputDraft.trim();
    if (!draft && contexts.length === 0) return;

    const { filePath, markdown, selectedBlockIds: ids } = useEditorStore.getState();
    const include = useAIPanelStore.getState().includeActiveFileAsContext;
    const sendContexts: ContextPill[] = [...contexts];
    if (include && filePath) {
      const baseName = filePath.split("/").pop() ?? filePath;
      sendContexts.push({
        kind: "file",
        label: baseName,
        body: markdown,
        path: filePath,
      });
    }
    if (ids.length > 0 && filePath) {
      sendContexts.push({
        kind: "highlight",
        label: `${ids.length} block${ids.length === 1 ? "" : "s"} selected`,
        body: ids.map((id) => `[[${filePath}#${id}]]`).join(", "),
        path: filePath,
      });
    }

    const contextBlock =
      sendContexts.length > 0
        ? `${sendContexts.map((c) => `[${c.kind}: ${c.label}]\n${c.body}`).join("\n\n")}\n\n`
        : "";
    const serverPrompt = contextBlock + draft;
    const attachmentLabels = sendContexts.map((c) => c.label);

    let alreadyAcknowledged = false;
    try {
      alreadyAcknowledged = window.sessionStorage.getItem(COST_ACK_KEY(activeAgent)) === "1";
    } catch {
      alreadyAcknowledged = true;
    }

    if (!alreadyAcknowledged) {
      setPendingSend({ display: draft, server: serverPrompt, attachments: attachmentLabels });
      setCostDialogOpen(true);
      return;
    }

    doSend(draft, serverPrompt, attachmentLabels);
  }, [inputDraft, contexts, activeAgent, doSend]);

  const handleCostConfirm = useCallback(() => {
    try {
      window.sessionStorage.setItem(COST_ACK_KEY(activeAgent), "1");
    } catch {
      /* storage denied — don't block the send */
    }
    setCostDialogOpen(false);
    if (pendingSend !== null) {
      doSend(pendingSend.display, pendingSend.server, pendingSend.attachments);
      setPendingSend(null);
    }
  }, [activeAgent, pendingSend, doSend]);

  const handleCostCancel = useCallback(() => {
    setCostDialogOpen(false);
    setPendingSend(null);
  }, []);

  const updateMentionFromCaret = useCallback(() => {
    const el = textareaRef.current;
    if (!el) {
      setMentionOpen(false);
      return;
    }
    const caret = el.selectionStart;
    const upto = inputDraft.slice(0, caret);
    const atIdx = upto.lastIndexOf("@");
    if (atIdx === -1) {
      setMentionOpen(false);
      return;
    }
    const prevChar = atIdx === 0 ? " " : inputDraft[atIdx - 1];
    if (prevChar !== " " && prevChar !== "\n" && prevChar !== "\t") {
      setMentionOpen(false);
      return;
    }
    const between = inputDraft.slice(atIdx + 1, caret);
    if (/\s/.test(between)) {
      setMentionOpen(false);
      return;
    }
    setMentionOpen(true);
    setMentionQuery(between);
    setMentionRange([atIdx, caret]);
  }, [inputDraft]);

  useEffect(() => {
    updateMentionFromCaret();
  }, [updateMentionFromCaret]);

  const onPromptKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSend();
        return;
      }
      if (inputDraft.length === 0 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === "+") {
          e.preventDefault();
          setPlusOpen(true);
          return;
        }
        if (e.key === "/") {
          e.preventDefault();
          setSlashOpen(true);
          return;
        }
      }
    },
    [handleSend, inputDraft.length],
  );

  const onMentionPick = useCallback(
    (c: MentionCandidate) => {
      const range = mentionRange;
      if (!range) {
        setMentionOpen(false);
        return;
      }
      const [from, to] = range;
      const next = inputDraft.slice(0, from) + inputDraft.slice(to);
      setInputDraft(next);

      if (c.kind === "agent") {
        const label = `@${c.path}`;
        useAIPanelStore.getState().addContext({
          kind: "page",
          label,
          body: `Reference to agent @${c.path} — loading capabilities…`,
          path: c.path,
        });
        const pillIndex = useAIPanelStore.getState().contexts.length - 1;
        fetchAgentConfig(c.path)
          .then((cfg) => {
            const body = buildAgentContextBody(c.path, cfg);
            const state = useAIPanelStore.getState();
            const pills = state.contexts.slice();
            const target = pills[pillIndex];
            if (target && target.path === c.path) {
              pills[pillIndex] = { ...target, body };
              useAIPanelStore.setState({ contexts: pills });
            }
          })
          .catch(() => {
            /* keep the seed body */
          });
      } else {
        useAIPanelStore.getState().addContext({
          kind: "page",
          label: c.label,
          body: `Reference to page ${c.path}`,
          path: c.path,
        });
      }

      setMentionOpen(false);
      setMentionQuery("");
      setMentionRange(null);
      queueMicrotask(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(from, from);
        }
      });
    },
    [inputDraft, mentionRange, setInputDraft],
  );

  const onSlashAction = useCallback(
    (action: SlashAction) => {
      switch (action) {
        case "attach-file":
          openFilePicker();
          break;
        case "mention":
          insertAtCaret("@");
          break;
        case "clear-conversation":
        case "slash.clear": {
          const ok = window.confirm("Clear the conversation? This can't be undone.");
          if (!ok) return;
          useAIPanelStore.getState().clearMessages();
          useAIPanelStore.getState().resetTokens();
          break;
        }
        case "switch-model":
          useAppStore.getState().toggleSettings("general");
          break;
        case "account-usage":
          useAppStore.getState().toggleSettings("security");
          break;
        case "slash.summarize":
          setInputDraft(
            "Summarize the conversation so far in five bullets, then propose the next step.",
          );
          queueMicrotask(() => textareaRef.current?.focus());
          break;
        case "slash.retry":
          setInputDraft("Retry the last turn.");
          queueMicrotask(() => textareaRef.current?.focus());
          break;
        case "slash.continue":
          setInputDraft("Continue.");
          queueMicrotask(() => textareaRef.current?.focus());
          break;
      }
    },
    [openFilePicker, insertAtCaret, setInputDraft],
  );

  const canSend = inputDraft.trim().length > 0 || contexts.length > 0;

  return (
    <>
      <AgentPulse active={isStreaming} className="border-t border-border p-3">
        {(contexts.length > 0 || selectedBlockIds.length > 0) && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {contexts.map((ctx, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: pills are append-only and never reorder
              <ContextChip key={i} ctx={ctx} onRemove={() => removeContext(i)} />
            ))}
            {selectedBlockIds.length > 0 && (
              <span
                className="font-mono"
                title="Highlight a different range or click outside to clear."
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "2px 8px",
                  fontSize: 10.5,
                  letterSpacing: "0.04em",
                  background: "color-mix(in oklch, var(--il-amber) 14%, transparent)",
                  border: "1px solid color-mix(in oklch, var(--il-amber) 30%, transparent)",
                  color: "var(--il-amber)",
                  borderRadius: 3,
                }}
              >
                <span aria-hidden="true">◆</span>
                {selectedBlockIds.length} block{selectedBlockIds.length === 1 ? "" : "s"} selected
              </span>
            )}
          </div>
        )}
        <div
          className="relative rounded-lg border border-border bg-background focus-within:border-ironlore-blue"
          style={{ padding: "6px 8px" }}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={onFilesPicked}
          />

          <div className="relative flex items-start">
            <textarea
              ref={textareaRef}
              data-ai-composer-textarea
              className="flex-1 resize-none bg-transparent py-1 text-sm text-primary placeholder:text-secondary focus:outline-none"
              placeholder={`Ask ${activeAgent} to…`}
              value={inputDraft}
              rows={1}
              onChange={(e) => setInputDraft(e.target.value)}
              onKeyDown={onPromptKeyDown}
              onSelect={updateMentionFromCaret}
              style={{ minHeight: "24px", maxHeight: "160px" }}
            />
            <MicButton />
          </div>

          <div className="flex items-center" style={{ gap: 4, marginTop: 4, height: 24 }}>
            <div className="relative">
              <ToolbarIconButton
                glyph="+"
                ariaLabel="Add to prompt"
                title="Add to prompt (+)"
                active={plusOpen}
                onClick={() => {
                  setPlusOpen((v) => !v);
                  setSlashOpen(false);
                }}
              />
              <PlusMenu
                open={plusOpen}
                onClose={() => setPlusOpen(false)}
                onUpload={openFilePicker}
                onAddContext={() => insertAtCaret("@")}
              />
            </div>
            <div className="relative">
              <ToolbarIconButton
                glyph="/"
                ariaLabel="Commands"
                title="Commands (/)"
                active={slashOpen}
                onClick={() => {
                  setSlashOpen((v) => !v);
                  setPlusOpen(false);
                }}
              />
              <SlashMenu
                open={slashOpen}
                onClose={() => setSlashOpen(false)}
                onAction={onSlashAction}
              />
            </div>

            <span
              aria-hidden="true"
              style={{
                width: 1,
                height: 14,
                background: "var(--il-border-soft)",
                marginLeft: 2,
                marginRight: 4,
              }}
            />
            <OpenedFileToggle />

            <span className="flex-1" />

            <ContextBudgetChip />

            <button
              type="button"
              onClick={handleSend}
              disabled={!canSend}
              aria-label="Send message"
              title="Send (⌘↵)"
              className="flex shrink-0 items-center justify-center bg-ironlore-blue text-white shadow-sm transition-opacity hover:bg-ironlore-blue-strong disabled:cursor-not-allowed disabled:opacity-30"
              style={{ width: 20, height: 20, borderRadius: 9999, marginLeft: 4 }}
            >
              <ArrowUp style={{ width: 12, height: 12 }} strokeWidth={2.5} />
            </button>
          </div>

          <MentionPicker
            open={mentionOpen && !plusOpen && !slashOpen}
            query={mentionQuery}
            onPick={onMentionPick}
            onClose={() => setMentionOpen(false)}
          />
        </div>
      </AgentPulse>
      {costDialogOpen && (
        <CostEstimateDialog
          agentSlug={activeAgent}
          onConfirm={handleCostConfirm}
          onCancel={handleCostCancel}
        />
      )}
    </>
  );
}

/**
 * Public helper: focus the composer's textarea programmatically.
 * Used by `InlineAIComposerLauncher` after expanding from the bar
 * to the full composer — the keyboard shortcut path needs the
 * textarea to already be focused so the user can start typing
 * without an extra click.
 */
export function focusAIComposerTextarea(): void {
  // The composer's textarea is the only `[data-ai-composer-textarea]`
  //  in the doc. We expose the focus path through a marker attribute
  //  rather than a ref forward so the inline launcher doesn't need to
  //  thread refs through the parent component tree.
  const el = document.querySelector<HTMLTextAreaElement>("[data-ai-composer-textarea]");
  el?.focus();
}

// ---------------------------------------------------------------------------
// Internal — ToolbarIconButton + ContextChip + buildAgentContextBody
// ---------------------------------------------------------------------------

function ToolbarIconButton({
  glyph,
  ariaLabel,
  title,
  active,
  onClick,
}: {
  glyph: string;
  ariaLabel: string;
  title: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-expanded={active}
      title={title}
      className="font-mono outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 22,
        height: 22,
        fontSize: 12,
        background: "var(--il-slate-elev)",
        border: "1px solid var(--il-border-soft)",
        borderRadius: 3,
        color: active ? "var(--il-text)" : "var(--il-text3)",
        transition: "color var(--motion-snap)",
      }}
    >
      {glyph}
    </button>
  );
}

function ContextChip({ ctx, onRemove }: { ctx: ContextPill; onRemove: () => void }) {
  return (
    <span
      className="font-mono inline-flex items-center gap-1.5"
      style={{
        padding: "2px 8px",
        fontSize: 10.5,
        letterSpacing: "0.02em",
        background: "var(--il-slate-elev)",
        border: "1px solid var(--il-border-soft)",
        color: "var(--il-text2)",
        borderRadius: 3,
      }}
    >
      <span aria-hidden="true" style={{ color: "var(--il-blue)" }}>
        @
      </span>
      <span className="truncate" style={{ maxWidth: 200 }}>
        {ctx.label}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${ctx.label}`}
        className="ml-0.5 text-tertiary hover:text-primary"
        style={{ fontSize: 12, lineHeight: 1 }}
      >
        ×
      </button>
    </span>
  );
}

/**
 * Build the body of an agent-mention context pill — fetched via
 * `fetchAgentConfig(slug)` once the user picks an `@agent` in the
 * mention picker. Mirrors the per-AIPanel.tsx construction so the
 * extracted composer stays byte-equivalent.
 */
function buildAgentContextBody(slug: string, cfg: AgentConfigResponse | null): string {
  if (!cfg) return `Reference to agent @${slug}.`;
  const persona = cfg.persona;
  const lines = [`Reference to agent @${slug}.`];
  if (persona?.description) lines.push(`Description: ${persona.description}`);
  if (persona?.tools && persona.tools.length > 0) {
    lines.push(`Tools: ${persona.tools.join(", ")}`);
  }
  if (persona?.scope?.pages && persona.scope.pages.length > 0) {
    lines.push(`Scope: ${persona.scope.pages.join(", ")}`);
  }
  return lines.join("\n");
}
