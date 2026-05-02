import { ArrowUp, ChevronDown, Highlighter, Lightbulb, Settings, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgentSession } from "../hooks/useAgentSession.js";
import { useWorkspaceActivity } from "../hooks/useWorkspaceActivity.js";
import {
  type AgentConfigResponse,
  fetchAgentConfig,
  fetchAgents,
  fetchProviders,
  getApiProject,
  revertJob,
  submitDryRunVerdict,
} from "../lib/api.js";
import { type ContextPill, type ConversationMessage, useAIPanelStore } from "../stores/ai-panel.js";
import { useAppStore } from "../stores/app.js";
import { useEditorStore } from "../stores/editor.js";
import { ContextBudgetChip } from "./ai-composer/ContextBudgetChip.js";
import { type MentionCandidate, MentionPicker } from "./ai-composer/MentionPicker.js";
import { MicButton } from "./ai-composer/MicButton.js";
import { OpenedFileToggle } from "./ai-composer/OpenedFileToggle.js";
import { PlusMenu } from "./ai-composer/PlusMenu.js";
import { type SlashAction, SlashMenu } from "./ai-composer/SlashMenu.js";
import { CostEstimateDialog } from "./CostEstimateDialog.js";
import { DiffPreview } from "./DiffPreview.js";
import {
  AgentPulse,
  Blockref,
  Key,
  ProvenanceStrip,
  Reuleaux,
  StatusPip,
} from "./primitives/index.js";
import { SaveAsWikiDialog } from "./SaveAsWikiDialog.js";

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
  // Block IDs covered by the current ProseMirror selection — fires
  //  whenever the user highlights paragraphs in the editor. Drives
  //  the "N blocks selected" pill in the composer and the
  //  highlight-context payload sent on the next prompt
  //  (docs/03-editor.md §Selection as AI context).
  const selectedBlockIds = useEditorStore((s) => s.selectedBlockIds);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Composer popover visibility. Opened on button click AND on
  //  first-char keystroke (`+` / `/`) from an empty draft. Typing
  //  `@` anywhere opens the mention picker instead.
  const [plusOpen, setPlusOpen] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  // Mention picker state — active when the caret is inside an
  //  `@query` token. `mentionRange` stores the `[start, end]` char
  //  offsets of the token so we can replace it on pick.
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionRange, setMentionRange] = useState<[number, number] | null>(null);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  /**
   * Insert `@` at the caret and open the mention picker. Used by
   * the `+` menu's "Add context" item and the `/` menu's "Mention"
   * item. The picker's keystroke detection will pick up the new
   * `@` token on the next render.
   */
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
      // Restore caret to the char immediately after the insert.
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
    // Reset so selecting the same file again re-triggers onChange.
    e.target.value = "";
  }, []);

  const { sendMessage } = useAgentSession();

  // Cost-estimate dialog state. The first user send of each session
  // for a given agent gates through this dialog; subsequent sends
  // skip it. sessionStorage clears on tab close, so reopening the
  // app re-shows the estimate — intentional since pricing could
  // change between sessions.
  const [costDialogOpen, setCostDialogOpen] = useState(false);

  const doSend = useCallback(
    (displayText: string, serverPrompt: string, attachmentLabels: string[]) => {
      sendMessage(displayText, serverPrompt, attachmentLabels);
      setInputDraft("");
      useAIPanelStore.getState().clearContexts();
    },
    [sendMessage, setInputDraft],
  );

  // Cost-estimate gate stashes the entire send payload (display +
  // server + attachments) so handleCostConfirm can replay all three
  // after the user acknowledges the price.
  const [pendingSend, setPendingSend] = useState<{
    display: string;
    server: string;
    attachments: string[];
  } | null>(null);

  const handleSend = useCallback(() => {
    const draft = inputDraft.trim();
    if (!draft && contexts.length === 0) return;

    // If the opened-file toggle is on, append the active file as a
    //  transient context pill for this send only. We read from the
    //  editor store at send time (not via subscription) so the
    //  composer doesn't re-render every time the user edits.
    const { filePath, markdown, selectedBlockIds: ids } = useEditorStore.getState();
    const include = useAIPanelStore.getState().includeActiveFileAsContext;
    const sendContexts: ContextPill[] = [...contexts];
    if (include && filePath) {
      const baseName = filePath.split("/").pop() ?? filePath;
      sendContexts.push({
        kind: "file",
        label: baseName,
        // Body is the live markdown buffer; the agent sees the
        //  user's working copy, not the on-disk snapshot.
        body: markdown,
        path: filePath,
      });
    }
    // Selection-as-AI-context (docs/03-editor.md §Selection as AI
    //  context). When the editor has block-IDed paragraphs selected,
    //  send their IDs so the agent can call `kb.read_block` to scope
    //  its answer to specific paragraphs without re-reading the
    //  whole page.
    if (ids.length > 0 && filePath) {
      sendContexts.push({
        kind: "highlight",
        label: `${ids.length} block${ids.length === 1 ? "" : "s"} selected`,
        body: ids.map((id) => `[[${filePath}#${id}]]`).join(", "),
        path: filePath,
      });
    }

    // Build the server-bound prompt including all context pills —
    // the agent needs the full file body etc. to reason about it.
    // The locally-displayed message stays as just the typed draft so
    // the chat transcript doesn't become a wall of inlined files;
    // attachment labels render as chips alongside the bubble.
    const contextBlock =
      sendContexts.length > 0
        ? `${sendContexts.map((c) => `[${c.kind}: ${c.label}]\n${c.body}`).join("\n\n")}\n\n`
        : "";
    const serverPrompt = contextBlock + draft;
    const attachmentLabels = sendContexts.map((c) => c.label);

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

  /**
   * Scan the textarea around the caret for an `@mention` token. If
   * the caret is inside an `@…` run (no whitespace after the `@`),
   * open the mention picker with the current query; otherwise close
   * it. Re-invoked on every input change + selection shift.
   */
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
    // The `@` must be at start of line or preceded by whitespace.
    const prevChar = atIdx === 0 ? " " : inputDraft[atIdx - 1];
    if (prevChar !== " " && prevChar !== "\n" && prevChar !== "\t") {
      setMentionOpen(false);
      return;
    }
    const between = inputDraft.slice(atIdx + 1, caret);
    // Close if the user has crossed whitespace — the `@token` is complete.
    if (/\s/.test(between)) {
      setMentionOpen(false);
      return;
    }
    setMentionOpen(true);
    setMentionQuery(between);
    setMentionRange([atIdx, caret]);
  }, [inputDraft]);

  // Re-scan whenever the draft changes.
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
      // First-char triggers — typing `+` or `/` into an empty draft
      //  opens the corresponding popover INSTEAD of inserting the
      //  character. The mention `@` picker is handled reactively via
      //  `updateMentionFromCaret` in the onChange branch, so the
      //  user does see `@` in the textarea.
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

  /**
   * Commit a chosen mention — replace the `@query` range with a
   * pill in `contexts` (not inline text) so the downstream prompt
   * sees a first-class context block, not a freeform `@slug`
   * sprinkled in the body. Consistent with how highlight/upload
   * attachments ride as pills.
   */
  const onMentionPick = useCallback(
    (c: MentionCandidate) => {
      const range = mentionRange;
      if (!range) {
        setMentionOpen(false);
        return;
      }
      const [from, to] = range;
      // Strip the `@query` — we don't want double-reference with a pill.
      const next = inputDraft.slice(0, from) + inputDraft.slice(to);
      setInputDraft(next);

      if (c.kind === "agent") {
        // Agent mention — fetch the mentioned agent's persona
        //  summary and drop a *context pill* that carries the
        //  description / tools / scope. The active agent (still in
        //  control of the turn) then has the mentioned agent's
        //  capabilities as reference material, without the
        //  conversation silently handing off. See the chunk-6 brief:
        //  "mentions are context, not handoffs."
        const label = `@${c.path}`;
        // Seed the pill immediately with a terse body so the user
        //  sees instant feedback, then upgrade it once the config
        //  comes back from the server.
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
            // Mutate the pill in place — store exposes array-index
            //  helpers but no per-index replace; reach in through
            //  the current state and reassign.
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

  /**
   * Dispatch a slash-menu action. `attach-file` / `mention` share
   * handlers with the `+` menu; `clear-conversation` and the actual
   * `/slash` commands mutate the conversation via store actions.
   * Settings links open the settings dialog (category-specific
   * deep-linking is a follow-up once the dialog grows tabs beyond
   * Appearance/Security).
   */
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
          // Deep-link into Settings → General where "Switch model"
          //  controls will land. Today the tab houses provider
          //  preferences; model selection grows here.
          useAppStore.getState().toggleSettings("general");
          break;
        case "account-usage":
          // Per-agent scope audit + rate caps live on Security.
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
          {/*
           * Raw Reuleaux per screen-editor.jsx AIPanel header — not
           * the StatusPip wrapper. Size 10 matches the brand doc
           * cards/rows anchor (nearest to spec's 9). Spins while the
           * agent streams.
           */}
          <Reuleaux size={10} color="var(--il-blue)" spin={isStreaming} />
          <AgentPicker activeAgent={activeAgent} />
          {stepLabel && (
            <span
              className="font-mono"
              style={{
                fontSize: 10.5,
                color: "var(--il-text3)",
                letterSpacing: "0.04em",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {stepLabel.replace(/^step\s+/, "")}
            </span>
          )}
          <span className="flex-1" />
          <ResolutionChip />
          <NetworkLockedBadge />
          <Key>⌘⇧A</Key>
        </div>
      </AgentPulse>

      {/* Auto-pause banner */}
      <AgentPauseBanner slug={activeAgent} />

      {/* Messages or empty state */}
      <div className="flex-1 overflow-y-auto px-4 py-4" role="log" aria-live="polite">
        {messages.length === 0 ? <AIEmptyState /> : <MessageList />}
      </div>

      {/*
       * Composer region — two-row well per the redesign brief:
       *   Row 1: textarea + mic placeholder
       *   Row 2: [+][/] · opened-file toggle · flex · context-%
       *          chip · send ↑
       * Pills (context chips) sit above the well. The `+` and `/`
       * popovers anchor to their trigger buttons; the mention
       * picker anchors to the textarea.
       * AgentPulse wraps everything so the 3.2s sweep crosses the
       * whole composer while streaming.
       */}
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
          {/* Hidden file input — triggered by the `+` menu and the
           *  `/` menu's Attach file item. Accepts multi-select. */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={onFilesPicked}
          />

          {/* Row 1 — textarea + mic placeholder. */}
          <div className="relative flex items-start">
            <textarea
              ref={textareaRef}
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

          {/* Row 2 — toolbar strip. */}
          <div className="flex items-center" style={{ gap: 4, marginTop: 4, height: 24 }}>
            {/* Left cluster — `+` and `/` triggers. */}
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

            {/* Divider · mono 10.5 dim — separates triggers from the
             *  opened-file toggle. */}
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

            {/* Send pill — 20×20 blue rounded-full with an up-arrow.
             *  Matches the JSX schematic. */}
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

          {/* Mention picker — anchored to the composer well so it
           *  floats above Row 1 when active. Only one popover may
           *  be open at a time; we dismiss the others when the
           *  picker opens. */}
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
    </aside>
  );
}

/**
 * Toolbar trigger — 22×22 slate-elevated cell rendering a single
 * mono glyph (`+` or `/`). Matches the chrome grammar used by the
 * prior `@` chip: mono 12 text3 on slate-elev with a soft border.
 * When `active` is true (its popover is open), the cell brightens
 * to `--il-text` so the user sees which menu owns focus.
 */
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
      className="flex items-center justify-center outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
      style={{
        width: 22,
        height: 22,
        background: active ? "var(--il-slate-elev)" : "transparent",
        border: `1px solid ${active ? "var(--il-border)" : "var(--il-border-soft)"}`,
        borderRadius: 3,
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        color: active ? "var(--il-text)" : "var(--il-text3)",
        lineHeight: 1,
        cursor: "pointer",
      }}
    >
      {glyph}
    </button>
  );
}

/**
 * Agent picker — replaces the static slug button in the panel
 * header with a dropdown. Click the slug → popover anchored below
 * lists every installed agent; selecting one calls
 * `useAIPanelStore.setActiveAgent`. A trailing "Open <slug>
 * detail →" row keeps the prior one-click affordance for jumping
 * to the agent's detail page.
 *
 * Agents loaded lazily when the popover opens — session-scoped;
 * we don't need to keep this list fresh after the first open.
 */
function AgentPicker({ activeAgent }: { activeAgent: string }) {
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<Array<{ slug: string; status: "active" | "paused" }>>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || agents.length > 0) return;
    let cancelled = false;
    fetchAgents()
      .then((list) => {
        if (!cancelled) setAgents(list);
      })
      .catch(() => {
        /* silent — the active agent stays pinned even if list fails */
      });
    return () => {
      cancelled = true;
    };
  }, [open, agents.length]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const root = rootRef.current;
      if (!root) return;
      if (!root.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const t = setTimeout(() => window.addEventListener("mousedown", onClick), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Active agent goes first so the eye lands on the current
  //  selection; everything else alphabetic.
  const ordered = useMemo(() => {
    const rest = agents
      .filter((a) => a.slug !== activeAgent)
      .sort((a, b) => a.slug.localeCompare(b.slug));
    const head = agents.find((a) => a.slug === activeAgent);
    return head ? [head, ...rest] : rest;
  }, [agents, activeAgent]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="il-ai-slug inline-flex items-center gap-1 rounded border border-transparent px-1 py-0.5 outline-none transition-colors hover:border-border hover:bg-ironlore-slate-hover focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
        title="Switch agent"
      >
        {activeAgent}
        <ChevronDown className="h-3 w-3" style={{ color: "var(--il-text3)" }} />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            minWidth: 220,
            background: "var(--il-bg-raised)",
            border: "1px solid var(--il-border-soft)",
            borderRadius: 6,
            boxShadow: "0 6px 20px oklch(0 0 0 / 0.35)",
            padding: 4,
            zIndex: 40,
            animation: "ilSnapIn var(--motion-snap) ease-out",
          }}
        >
          {ordered.length === 0 ? (
            <div
              style={{
                padding: "8px 10px",
                fontSize: 12,
                color: "var(--il-text3)",
                fontStyle: "italic",
              }}
            >
              Loading agents…
            </div>
          ) : (
            ordered.map((a) => {
              const active = a.slug === activeAgent;
              const paused = a.status === "paused";
              return (
                <button
                  key={a.slug}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    useAIPanelStore.getState().setActiveAgent(a.slug);
                    setOpen(false);
                  }}
                  className="il-popover-item flex w-full items-center gap-2 rounded text-left"
                  data-selected={active ? "true" : undefined}
                  style={{
                    padding: "6px 8px",
                    background: "transparent",
                    color: "var(--il-text)",
                    fontSize: 12.5,
                    cursor: "pointer",
                  }}
                >
                  <Reuleaux size={7} color={paused ? "var(--il-amber)" : "var(--il-blue)"} />
                  <span style={{ flex: 1 }}>{a.slug}</span>
                  {active && (
                    <span
                      className="font-mono uppercase"
                      style={{
                        fontSize: 10.5,
                        letterSpacing: "0.06em",
                        color: "var(--il-blue)",
                      }}
                    >
                      current
                    </span>
                  )}
                </button>
              );
            })
          )}
          <div
            style={{
              borderTop: "1px solid var(--il-border-soft)",
              marginTop: 4,
              paddingTop: 4,
            }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                useAppStore.getState().setActiveAgentSlug(activeAgent);
                setOpen(false);
              }}
              className="il-popover-item flex w-full items-center gap-2 rounded text-left"
              style={{
                padding: "6px 8px",
                background: "transparent",
                color: "var(--il-text2)",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              <span style={{ flex: 1 }}>Open {activeAgent} detail</span>
              <span className="font-mono" style={{ fontSize: 10.5, color: "var(--il-text4)" }}>
                →
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
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
  // Probe provider connectivity so the empty state can branch:
  //  - any provider connected → existing tip-card layout
  //  - none connected → "configure AI" card with clickable links to
  //    Settings → Providers + a pointer at Ollama for the
  //    no-API-key path.
  // Stays a hint, not a hard block — sending a prompt with no
  // provider still hits the existing "No AI provider configured"
  // error path the executor emits, so the panel never silently
  // pretends to work.
  const [hasProvider, setHasProvider] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchProviders()
      .then((rows) => {
        if (cancelled) return;
        setHasProvider(rows.some((r) => r.status === "connected"));
      })
      .catch(() => {
        // Endpoint failure (rare) → fall through to the prompt
        // cards rather than nag the user.
        if (!cancelled) setHasProvider(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (hasProvider === false) {
    return <AIEmptyStateNoProvider />;
  }

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

/**
 * Empty-state shown when no AI provider has connected. Replaces the
 * usual tip-cards so a non-technical user lands on a clear path:
 * either install Ollama (zero-key local AI) or paste a Claude /
 * OpenAI key in Settings → Providers. The "Open Settings" button
 * jumps straight to the providers tab via the existing
 * `toggleSettings("providers")` action.
 */
function AIEmptyStateNoProvider() {
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  return (
    <div className="mx-auto flex h-full max-w-[320px] flex-col justify-center gap-3">
      <EmptyCard
        icon={<Settings className="h-4 w-4 text-ironlore-blue" />}
        title="Connect an AI provider"
        body={
          <>
            <p className="mt-1 text-secondary">
              Ironlore works without AI — but the panel only comes alive once a provider is
              configured.
            </p>
            <ul className="mt-2 space-y-1.5 text-secondary">
              <li>
                <span className="font-medium text-primary">Local · free.</span> Install{" "}
                <a
                  href="https://ollama.com/download"
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-dotted underline-offset-2 hover:text-ironlore-blue"
                >
                  Ollama
                </a>{" "}
                and run a model — Ironlore auto-detects it.
              </li>
              <li>
                <span className="font-medium text-primary">Cloud · BYOK.</span> Paste an Anthropic
                or OpenAI key into Settings → Providers.
              </li>
            </ul>
            <button
              type="button"
              onClick={() => toggleSettings("providers")}
              className="mt-3 rounded border border-ironlore-blue/40 bg-ironlore-blue/10 px-2.5 py-1 text-[11px] font-medium text-ironlore-blue hover:bg-ironlore-blue/20"
            >
              Open Settings → Providers
            </button>
          </>
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
            <UserBubble text={msg.text} attachments={msg.attachments} timestamp={msg.timestamp} />
          )}
          {msg.type === "assistant" && <AssistantReply text={msg.text} />}
          {msg.type === "tool_call" && <ToolCallCard msg={msg} />}
          {msg.type === "journal" && (
            <JournalCard text={msg.text} step={msg.step} totalSteps={msg.totalSteps} />
          )}
          {msg.type === "diff_preview" && <DiffPreviewItem msg={msg} index={i} />}
          {msg.type === "error" && (
            <div className="rounded-lg bg-signal-red/10 px-3 py-2 text-signal-red">{msg.text}</div>
          )}
          {msg.type === "run_finalized" && <RunFinalizedCard msg={msg} />}
          {msg.type === "egress_downgraded" && (
            <EgressDowngradedBanner reason={msg.reason} at={msg.at} />
          )}
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
 * Wraps the AI-panel `DiffPreview` card with the approve/reject + open-page
 * affordances. Phase-11 inline-diff plugin (docs/03-editor.md §Pending-edit
 * decorations) routes diff_preview events to the editor when the target
 * page is open; this component only renders when the page is NOT open
 * OR the run is older than the structured-fields rollout. The "Open
 * page" button bridges the two surfaces — clicking it sets the active
 * path so ContentArea remounts the editor on the target file, and the
 * pending-edit re-fires through `useAgentSession` because the underlying
 * `diff_preview` message is still pinned to the conversation; on next
 * render the inline plugin picks it up.
 */
function DiffPreviewItem({
  msg,
  index,
}: {
  msg: Extract<ConversationMessage, { type: "diff_preview" }>;
  index: number;
}) {
  const editorFilePath = useEditorStore((s) => s.filePath);
  const pageIsOpen = msg.pageId.length > 0 && editorFilePath === msg.pageId;
  return (
    <DiffPreview
      pageId={msg.pageId}
      blockId={msg.blockId}
      commitSha={msg.commitSha}
      diff={msg.diff}
      approved={msg.approved}
      showOpenPageButton={!pageIsOpen && msg.pageId.length > 0 && msg.approved === null}
      onOpenPage={() => {
        // Switch the active path; ContentArea remounts the editor
        //  on the target file and the diff_preview event already in
        //  the conversation will route to the inline plugin once
        //  `useEditorStore.filePath` matches. We also push the edit
        //  to the editor store directly so the user doesn't have to
        //  wait for a fresh round-trip.
        if (msg.op !== undefined && msg.blockId !== undefined && msg.toolCallId.length > 0) {
          useEditorStore.getState().pushPendingEdit({
            toolCallId: msg.toolCallId,
            op: msg.op,
            blockId: msg.blockId,
            pageId: msg.pageId,
            currentMd: msg.currentMd,
            proposedMd: msg.proposedMd,
            agentSlug: useAIPanelStore.getState().activeAgent,
          });
        }
        useAppStore.getState().setActivePath(msg.pageId);
      }}
      onApprove={() => {
        const jobId = useAIPanelStore.getState().jobId;
        if (!jobId || !msg.toolCallId) return;
        // Mark locally before the round-trip so the buttons hide
        //  immediately; the server call is best-effort, because if
        //  the bridge has already timed out there's nothing the
        //  user can do to un-timeout it.
        const msgs = useAIPanelStore.getState().messages;
        const target = msgs[index];
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
        const target = msgs[index];
        if (target?.type === "diff_preview") {
          (target as { approved: boolean | null }).approved = false;
          useAIPanelStore.setState({ messages: [...msgs] });
        }
        void submitDryRunVerdict(jobId, msg.toolCallId, "reject").catch(() => {});
      }}
    />
  );
}

/**
 * User bubble per docs/09-ui-and-brand.md §AI panel user bubble:
 * right-aligned (max-width 85 %), 16 % blue tint, 28 % blue border,
 * `3px 3px 0 3px` corner radii so the bottom-right corner forms a
 * conversation-bubble tail. The mono timestamp under the bubble
 * uses `Intl.DateTimeFormat` so we always show local-time HH:MM,
 * rendered only when the message carries a `timestamp`.
 */
function UserBubble({
  text,
  attachments,
  timestamp,
}: {
  text: string;
  attachments: string[];
  timestamp?: number;
}) {
  return (
    <div className="flex flex-col items-end gap-1">
      {/* Attachments ride above the bubble as compact chips so the
       *  user can see what context was sent (file body, selection
       *  block-refs) without the entire body inlined into the
       *  message text. The `attachments` field carries just labels;
       *  the full bodies were sent only to the agent (via the
       *  serverPrompt arg of sendMessage). */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1" style={{ maxWidth: "85%" }}>
          {attachments.map((label, idx) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: labels can repeat (same file attached twice); index is the only stable identity within a single message
              key={`${label}-${idx}`}
              className="font-mono"
              style={{
                fontSize: 11,
                letterSpacing: "0.02em",
                padding: "1px 6px",
                background: "color-mix(in oklch, var(--il-blue) 8%, transparent)",
                border: "1px solid color-mix(in oklch, var(--il-blue) 22%, transparent)",
                borderRadius: 2,
                color: "var(--il-text3)",
              }}
              title={`Attached: ${label}`}
            >
              📎 {label}
            </span>
          ))}
        </div>
      )}
      <div
        style={{
          maxWidth: "85%",
          padding: "6px 10px",
          background: "color-mix(in oklch, var(--il-blue) 16%, transparent)",
          border: "1px solid color-mix(in oklch, var(--il-blue) 28%, transparent)",
          borderRadius: "3px 3px 0 3px",
          color: "var(--il-text)",
          lineHeight: 1.5,
        }}
      >
        {text}
      </div>
      {timestamp != null && (
        <span
          className="font-mono"
          style={{
            fontSize: 10.5,
            letterSpacing: "0.04em",
            color: "var(--il-text4)",
          }}
        >
          {formatClockShort(timestamp)}
        </span>
      )}
    </div>
  );
}

/**
 * Assistant reply per docs/09-ui-and-brand.md §AI panel assistant
 * reply: mono uppercase `ASSISTANT` overline with a static Reuleaux
 * prefix, then Inter 13 / 1.55 body. No border, no background — the
 * model's voice is the unmarked default. Citation parsing stays in
 * `CitationText` so `[[Page#blk_…]]` still becomes a Blockref.
 */
function AssistantReply({ text }: { text: string }) {
  // Phase-11 query-to-wiki affordance — small "Save as wiki" link
  // in the assistant header. Only shown when there's enough text
  // to be worth saving (skip the streaming-empty case where the
  // header renders before the first token lands).
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const showSave = text.trim().length > 24;

  return (
    <div className="leading-relaxed text-primary" style={{ fontSize: 13, lineHeight: 1.55 }}>
      <div className="mb-1 flex items-center gap-1.5">
        <Reuleaux size={7} color="var(--il-blue)" aria-label="Assistant" />
        <span
          className="font-mono uppercase"
          style={{
            fontSize: 10.5,
            letterSpacing: "0.08em",
            color: "var(--il-text3)",
          }}
        >
          assistant
        </span>
        <span className="flex-1" />
        {showSave && (
          <button
            type="button"
            onClick={() => setSaveDialogOpen(true)}
            title="Save this reply as a kind: wiki page"
            className="rounded font-mono uppercase hover:text-ironlore-blue"
            style={{
              fontSize: 9.5,
              letterSpacing: "0.06em",
              padding: "1px 4px",
              color: "var(--il-text4)",
            }}
          >
            save as wiki
          </button>
        )}
      </div>
      <CitationText text={text} />
      {saveDialogOpen && (
        <SaveAsWikiDialog markdown={text} onClose={() => setSaveDialogOpen(false)} />
      )}
    </div>
  );
}

/**
 * JournalCard per docs/09-ui-and-brand.md §AI panel journal: 7 %
 * blue tint + 2 px blue left border + mono
 * `→ journal · step NN / NN` overline + Inter 12.5 body that can
 * carry italic emphasis for quoted source names. Step + total are
 * optional — when the executor omits them the overline degrades to
 * `→ journal` alone.
 */
function JournalCard({
  text,
  step,
  totalSteps,
}: {
  text: string;
  step?: number;
  totalSteps?: number;
}) {
  const stepPart =
    step != null && totalSteps != null
      ? ` · step ${String(step).padStart(2, "0")} / ${String(totalSteps).padStart(2, "0")}`
      : step != null
        ? ` · step ${String(step).padStart(2, "0")}`
        : "";
  return (
    <div
      style={{
        // Padding 9/11 per screen-editor.jsx JournalCard (was 8/10).
        padding: "9px 11px",
        borderLeft: "2px solid var(--il-blue)",
        background: "color-mix(in oklch, var(--il-blue) 7%, transparent)",
        borderRadius: "0 3px 3px 0",
      }}
    >
      <div
        className="font-mono uppercase"
        style={{
          fontSize: 10.5,
          letterSpacing: "0.06em",
          // Overline is blue per spec — signals "agent's own voice,
          //  not chrome." text3 reads as generic metadata.
          color: "var(--il-blue)",
          marginBottom: 4,
        }}
      >
        → journal{stepPart}
      </div>
      {/* Body text2 per spec so the prose reads as a quiet aside,
       *  not primary content. */}
      <div style={{ fontSize: 12.5, lineHeight: 1.5, color: "var(--il-text2)" }}>{text}</div>
    </div>
  );
}

/**
 * Compact HH:MM clock — the only timestamp shape user bubbles carry
 * (day rollovers are implicit because the full log resets per run).
 */
function formatClockShort(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Compose the context-pill body for an agent mention. The body is
 * the text the active agent receives as context on send — we keep
 * it terse (first-line description, canonical tools list, scope
 * globs) so it costs few tokens but still conveys "who this other
 * agent is + what it's allowed to do." The mentioned agent stays a
 * reference, not a handoff: the active agent replies with this
 * context in mind, it doesn't forward the turn.
 */
function buildAgentContextBody(slug: string, cfg: AgentConfigResponse): string {
  const lines: string[] = [`Agent @${slug}`];
  const desc = cfg.persona?.description?.trim();
  if (desc) lines.push(desc);
  const tools = cfg.persona?.tools;
  if (tools && tools.length > 0) {
    lines.push(`Tools: ${tools.join(", ")}`);
  }
  const pages = cfg.persona?.scope?.pages;
  if (pages && pages.length > 0) {
    lines.push(`Scope: ${pages.slice(0, 4).join(", ")}${pages.length > 4 ? ", …" : ""}`);
  }
  const review = cfg.persona?.reviewMode;
  if (review) lines.push(`Review mode: ${review}`);
  return lines.join("\n");
}

/**
 * Compact duration label for the ToolCallCard StatusPip — `180ms`,
 * `4.2s`, `1m12s`. Sub-second latencies are the common case for
 * `kb.read_page` / `kb.replace_block`, so we keep ms precision up to
 * 1 000; everything longer rounds to 1-decimal seconds or composite
 * minutes. Mirrors screen-editor.jsx's `StatusPip label="180ms"`.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m${String(s).padStart(2, "0")}s`;
}

/**
 * Derive the `(page · #block)` / `("query")` target-label for a
 * tool-call header from its `args` payload.
 *
 * Resolution order (first match wins):
 *   1. `{ page / pageId / path } + blockId` → `page · #block` (kb mutations)
 *   2. `{ page / pageId / path }` alone     → bare path (kb.read_page etc.)
 *   3. `blockId` alone                       → `#block`
 *   4. `{ query }`                           → `"query"` (kb.search,
 *      kb.semantic_search, kb.global_search)
 *   5. `{ text }`                            → `"text snippet"` (agent.journal)
 *
 * Without #4/#5, repeat `kb.search` calls in the AI panel were
 * indistinguishable — every row read just `kb.search` with no hint
 * of what was being searched for. The user couldn't tell five
 * identical calls apart without expanding each one.
 */
function deriveToolTarget(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const bag = args as Record<string, unknown>;
  const page =
    typeof bag.page === "string"
      ? bag.page
      : typeof bag.pageId === "string"
        ? bag.pageId
        : typeof bag.path === "string"
          ? bag.path
          : null;
  const block = typeof bag.blockId === "string" ? bag.blockId : null;
  if (page && block) return `${truncate(page, 22)} · #${block}`;
  if (page) return truncate(page, 28);
  if (block) return `#${block}`;
  if (typeof bag.query === "string" && bag.query.length > 0) {
    return `"${truncate(bag.query, 36)}"`;
  }
  if (typeof bag.text === "string" && bag.text.length > 0) {
    // Strip newlines so multi-line journals don't break the row.
    const single = bag.text.replace(/\s+/g, " ");
    return `"${truncate(single, 36)}"`;
  }
  return null;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `…${s.slice(-(max - 1))}` : s;
}

/**
 * Heuristic for the error state of a tool-call result. Executor
 * payloads aren't a typed union, so we check a few conventional
 * shapes: `{ error: … }`, `{ ok: false }`, or the string prefix
 * `Error:`. Everything else counts as healthy success.
 */
function isErrorResult(result: unknown): boolean {
  if (result == null) return false;
  if (typeof result === "string") return result.startsWith("Error:") || result.startsWith("error:");
  if (typeof result === "object") {
    const bag = result as Record<string, unknown>;
    if ("error" in bag && bag.error) return true;
    if ("ok" in bag && bag.ok === false) return true;
  }
  return false;
}

/**
 * Collapsible tool-call card per docs/09-ui-and-brand.md §AI panel
 * tool-call: mono `kb.replace_block (page · #block)` header + a
 * `StatusPip` reading `running` / `healthy` / `error` + the caret
 * glyph. Args + result remain in the expandable drawer so power
 * users can still inspect the raw payload.
 */
function ToolCallCard({
  msg,
}: {
  msg: {
    tool: string;
    args: unknown;
    result?: unknown;
    collapsed: boolean;
    durationMs?: number;
  };
}) {
  const [expanded, setExpanded] = useState(!msg.collapsed);
  const hasResult = msg.result !== undefined;
  const target = deriveToolTarget(msg.args);
  const pipState: "running" | "healthy" | "error" = !hasResult
    ? "running"
    : isErrorResult(msg.result)
      ? "error"
      : "healthy";
  // Duration — rendered alongside the right-edge pip per
  //  screen-editor.jsx. Omitted while in-flight (no finishedAt yet).
  const durationLabel = msg.durationMs != null ? formatDuration(msg.durationMs) : undefined;

  return (
    <div
      style={{
        // Radius 3 per screen-editor.jsx ToolCallCard (was 4).
        borderRadius: 3,
        border: "1px solid var(--il-border-soft)",
        background: "var(--il-slate-elev)",
        fontSize: 12,
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
        style={{ padding: "7px 10px" }}
      >
        <span
          aria-hidden="true"
          className="font-mono shrink-0"
          style={{ color: "var(--il-text3)", fontSize: 10.5, width: 10 }}
        >
          {expanded ? "▾" : "▸"}
        </span>
        {/* Tool name + `(page · #block)` target split into two mono
         *  spans per screen-editor.jsx — the tool in `--il-text`, the
         *  target in `--il-text3` so the eye reads the verb first. */}
        <span
          className="font-mono truncate"
          style={{ fontSize: 11, letterSpacing: "0.01em", color: "var(--il-text)" }}
        >
          {msg.tool}
        </span>
        {target && (
          <span className="font-mono truncate" style={{ fontSize: 10.5, color: "var(--il-text3)" }}>
            ({target})
          </span>
        )}
        <span className="ml-auto">
          <StatusPip state={pipState} label={durationLabel} size={7} />
        </span>
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
          {/* Only show the revert button when there's actually
            * something to revert: a real commit range (start \u2260 end)
            * AND at least one changed file. A chat-only turn that
            * produced zero commits used to render "Revert this run"
            * even though clicking it would have nothing to undo. */}
          {!reverted &&
            msg.commitShaStart &&
            msg.commitShaEnd &&
            msg.commitShaStart !== msg.commitShaEnd &&
            msg.filesChanged.length > 0 && (
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
          {msg.commitShaStart === msg.commitShaEnd || msg.filesChanged.length === 0 ? (
            // No commits produced \u2014 saying "0 files \u00B7 version abc\u2026abc"
            // was misleading (suggested a frozen empty version). Just
            // say what actually happened.
            "no files changed"
          ) : (
            <>
              {msg.filesChanged.length} file{msg.filesChanged.length === 1 ? "" : "s"}
              {" \u00B7 version "}
              <code className="font-mono">{msg.commitShaStart.slice(0, 7)}</code>
              {"\u2026"}
              <code className="font-mono">{msg.commitShaEnd.slice(0, 7)}</code>
              {reverted && " \u00B7 reverted"}
            </>
          )}
        </div>
        {revertError && <div className="mt-1 text-signal-red">{revertError}</div>}
      </div>
    </div>
  );
}

/**
 * Phase-11 Airlock affordance — rendered once per run when
 * `kb.global_search` returned a foreign-project hit and the
 * executor's airlock session flipped egress to offline. After
 * this point every provider call + connector fetch in the run
 * throws `EgressDowngradedError` (HTTP 451).
 *
 * The card is informational, not actionable: the downgrade is
 * one-way per run, so there's no "undo." The user's recourse is
 * to start a new run if they need network access.
 *
 * Visual posture: amber instead of red — this is a deliberate,
 * documented containment, not a failure. Mirrors the
 * `signal-amber` rail used elsewhere for "intentional limit
 * reached."
 */
/**
 * Persistent chrome-level "network locked" badge. Visible the
 * moment a Phase-11 Airlock downgrade lands, and stays visible
 * for the rest of the conversation — until the user clears the
 * messages or starts a new run. Mirrors the inline
 * `EgressDowngradedBanner` (which fires once per run as a
 * conversation card) at a higher visual altitude so the user can
 * always see the security state without scrolling.
 *
 * Reads off the same `egress_downgraded` store message the inline
 * banner uses, so any future change to event handling stays
 * coherent across both surfaces. Renders nothing pre-downgrade.
 */
/**
 * Resolution chip — surfaces the per-run provider/model/effort triple
 * that the four-level resolver chose for the current turn, plus the
 * source level (action / runtime / persona / global) for each field.
 *
 * Renders nothing until the first `provider.resolved` event lands —
 * before that there's nothing to display. The tooltip carries the
 * full breakdown so a glance reads "haiku" while a hover reveals
 * "model from action; effort from persona; provider from global +
 * note: 'effort dropped on Haiku'".
 *
 * Wired through `useAIPanelStore.lastResolution` — see
 * `useAgentSession`'s `provider.resolved` handler.
 */
function ResolutionChip() {
  const resolution = useAIPanelStore((s) => s.lastResolution);
  if (!resolution) return null;
  const { model, source, notes, provider, effort } = resolution;
  // Compact display — full model name in mono, with a small badge
  //  marking which level set the model. Tooltip carries the full
  //  three-field breakdown + any normalization notes.
  const sourceBadge = source.model.charAt(0).toUpperCase(); // A / R / P / G
  const tooltip = [
    `provider: ${provider} (from ${source.provider})`,
    `model: ${model} (from ${source.model})`,
    `effort: ${effort} (from ${source.effort})`,
    ...notes.map((n) => `note: ${n}`),
  ].join("\n");
  return (
    <span
      role="status"
      aria-label={`Resolved as ${provider} ${model} ${effort}; model source ${source.model}`}
      title={tooltip}
      className="flex items-center gap-1 rounded-sm font-mono"
      style={{
        fontSize: 10,
        letterSpacing: "0.04em",
        padding: "2px 6px",
        background: "color-mix(in oklch, var(--il-blue) 10%, transparent)",
        border: "1px solid color-mix(in oklch, var(--il-blue) 25%, transparent)",
        color: "var(--il-text2)",
        maxWidth: 180,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden="true" style={{ color: "var(--il-blue)", fontSize: 9, letterSpacing: 0 }}>
        {sourceBadge}
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{shortModelName(model)}</span>
    </span>
  );
}

/**
 * Trim a long model name down to the chip's width budget without
 * losing the recognizable family/version. `claude-sonnet-4-20250514`
 * → `sonnet-4`. `llama3.2:latest` → `llama3.2`. Provider-specific
 * heuristics — keeping it small and explicit beats a generic
 * truncation that hides the part the user actually cares about.
 */
function shortModelName(model: string): string {
  // Anthropic: claude-<family>-<version>-<date> → <family>-<version>
  const claudeMatch = /^claude-([^-]+)-([^-]+)/.exec(model);
  if (claudeMatch?.[1] && claudeMatch[2]) return `${claudeMatch[1]}-${claudeMatch[2]}`;
  // OpenAI: gpt-4o-mini → gpt-4o-mini (already short)
  if (model.startsWith("gpt-") && model.length <= 16) return model;
  // Ollama: llama3.2:latest → llama3.2 (drop the tag)
  const colonIdx = model.indexOf(":");
  if (colonIdx > 0) return model.slice(0, colonIdx);
  return model.length <= 16 ? model : `${model.slice(0, 14)}…`;
}

function NetworkLockedBadge() {
  const downgraded = useAIPanelStore((s) => s.messages.some((m) => m.type === "egress_downgraded"));
  if (!downgraded) return null;
  return (
    <span
      role="status"
      aria-label="Network locked: cross-project content entered this run; outbound network calls are blocked for the rest of the conversation"
      title="Cross-project content entered this run. Outbound network calls are blocked for the rest of the conversation."
      className="flex items-center gap-1 rounded-sm font-mono uppercase"
      style={{
        fontSize: 9.5,
        letterSpacing: "0.06em",
        padding: "2px 6px",
        background: "color-mix(in oklch, var(--il-amber) 12%, transparent)",
        border: "1px solid color-mix(in oklch, var(--il-amber) 35%, transparent)",
        color: "var(--il-amber)",
      }}
    >
      <Reuleaux size={6} color="var(--il-amber)" />
      Network locked
    </span>
  );
}

function EgressDowngradedBanner({ reason, at }: { reason: string; at: string | null }) {
  const formattedAt = (() => {
    if (!at) return null;
    try {
      return new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(at));
    } catch {
      return null;
    }
  })();

  return (
    <div
      className="rounded-lg border px-3 py-2 text-xs"
      role="status"
      aria-live="polite"
      style={{
        borderColor: "color-mix(in oklch, var(--il-amber) 35%, transparent)",
        background: "color-mix(in oklch, var(--il-amber) 8%, transparent)",
        color: "var(--il-text)",
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold" style={{ color: "var(--il-amber)" }}>
          Egress downgraded
        </div>
        {formattedAt && <div className="font-mono text-secondary">{formattedAt}</div>}
      </div>
      <div className="mt-0.5 text-secondary">{reason}</div>
      <div className="mt-1 text-secondary opacity-80">
        Cross-project content entered this run, so outbound network calls are blocked for the rest
        of the conversation. Start a new run to restore network access.
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

/**
 * ContextChip per screen-editor.jsx ContextPill:
 *   · slate-elevated background, `--il-border-soft` border, 2 px
 *     radius (a rect, not a pill — pills are only for counters)
 *   · mono 10.5 text2 0.02em
 *   · leading `@` glyph in `var(--il-blue)` — the mention cue that
 *     the JSX carries in place of kind-specific Lucide icons. Drops
 *     the prior Highlighter / Paperclip / Sparkles trio.
 *   · trailing `×` close keeps the existing dismiss affordance.
 */
function ContextChip({ ctx, onRemove }: ContextChipProps) {
  return (
    <div
      className="inline-flex max-w-full items-center gap-1"
      style={{
        padding: "2px 6px 2px 7px",
        background: "var(--il-slate-elev)",
        border: "1px solid var(--il-border-soft)",
        borderRadius: 2,
        fontFamily: "var(--font-mono)",
        fontSize: 10.5,
        letterSpacing: "0.02em",
        color: "var(--il-text2)",
      }}
    >
      <span aria-hidden="true" style={{ color: "var(--il-blue)" }}>
        @
      </span>
      <span className="truncate" title={ctx.label} style={{ maxWidth: 180 }}>
        {ctx.label}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove context: ${ctx.label}`}
        className="flex h-4 w-4 items-center justify-center rounded text-secondary outline-none hover:bg-ironlore-slate-hover hover:text-primary focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
