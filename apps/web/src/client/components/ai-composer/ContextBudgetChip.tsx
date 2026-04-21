import { AGENT_TOKEN_BUDGET, useAIPanelStore } from "../../stores/ai-panel.js";

/**
 * Context-budget chip — mono `NN% left` readout backed by the run's
 * accumulated `tokensUsed` / `AGENT_TOKEN_BUDGET`. Clicking
 * "compacts now" by clearing the conversation log (local-only;
 * matches the spec intent: free up context by discarding older
 * turns). Tooltip explains the trade.
 *
 * Colour palette matches the spec's status language: green while we
 * have plenty of headroom, amber once we drop below 30 %, red below
 * 10 % — every tone drawn from the `--il-*` OKLCh tokens so the
 * chip never strays from the brand palette.
 */

export function ContextBudgetChip() {
  const tokensUsed = useAIPanelStore((s) => s.tokensUsed);
  const clearMessages = useAIPanelStore((s) => s.clearMessages);
  const resetTokens = useAIPanelStore((s) => s.resetTokens);

  const pctLeft = Math.max(0, Math.min(100, 100 - (tokensUsed / AGENT_TOKEN_BUDGET) * 100));
  const pctRounded = Math.round(pctLeft);

  // Three-band palette — green → amber → red. Threshold picks at
  //  30% and 10% mirror the server's warn/exhaust language so the
  //  chip's color change lands at the same moment as the upstream
  //  `budget.warning` event would fire.
  const color =
    pctLeft >= 30 ? "var(--il-green)" : pctLeft >= 10 ? "var(--il-amber)" : "var(--il-red)";

  const handleCompact = () => {
    if (tokensUsed === 0) return;
    const ok = window.confirm(
      "Compact now will clear the current conversation from this view and reset the context gauge. Continue?",
    );
    if (!ok) return;
    clearMessages();
    resetTokens();
  };

  return (
    <button
      type="button"
      onClick={handleCompact}
      title={`${pctRounded}% of context window remaining until auto-compact. Click to compact now.`}
      className="font-mono uppercase"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 6px",
        background: "transparent",
        border: "1px solid var(--il-border-soft)",
        borderRadius: 3,
        fontSize: 10.5,
        letterSpacing: "0.06em",
        color,
        cursor: tokensUsed === 0 ? "default" : "pointer",
      }}
    >
      <span>{pctRounded}%</span>
      <span style={{ color: "var(--il-text4)" }}>left</span>
    </button>
  );
}
