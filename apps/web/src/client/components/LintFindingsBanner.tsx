import { ClipboardList, X } from "lucide-react";
import { useEffect, useState } from "react";
import { wsClient } from "../lib/ws.js";
import { useAppStore } from "../stores/app.js";

interface LintFinding {
  reportPath: string;
  counts: {
    orphans: number;
    stale: number;
    contradictions: number;
    coverageGaps: number;
    provenanceGaps: number;
  };
  agent: string;
  runId: string;
}

/**
 * Banner shown when the wiki-gardener (or any other lint workflow)
 * finalizes a run with a `lint:findings` WebSocket event.
 *
 * Mirrors the `RecoveryBanner` pattern — same dismissible chrome,
 * same per-event re-show, same WS subscription model. The message
 * here is informational, not an error: the report is already
 * written to disk; this banner just tells the user it's there and
 * gives them one click to open it.
 *
 * Per-session dedup: keyed on `runId` so a second `lint:findings`
 * for the same job (e.g. retry replay after a reconnect) doesn't
 * un-dismiss a banner the user already closed.
 */
export function LintFindingsBanner() {
  const [finding, setFinding] = useState<LintFinding | null>(null);
  const [dismissedRunIds, setDismissedRunIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const unsubscribe = wsClient.onEvent((event) => {
      if (event.type !== "lint:findings") return;
      // Skip if the user already dismissed this exact run — prevents
      // a reconnect replay from re-showing the same banner.
      if (dismissedRunIds.has(event.runId)) return;
      setFinding({
        reportPath: event.reportPath,
        counts: event.counts,
        agent: event.agent,
        runId: event.runId,
      });
    });
    return unsubscribe;
  }, [dismissedRunIds]);

  if (!finding) return null;

  const headline = formatHeadline(finding.counts);
  const dismiss = () => {
    setDismissedRunIds((prev) => {
      const next = new Set(prev);
      next.add(finding.runId);
      return next;
    });
    setFinding(null);
  };
  const openReport = () => {
    useAppStore.getState().setActivePath(finding.reportPath);
    dismiss();
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 border-b border-ironlore-blue/40 bg-ironlore-blue/10 px-4 py-2 text-xs text-primary"
    >
      <ClipboardList
        className="mt-0.5 h-4 w-4 shrink-0"
        style={{ color: "var(--il-blue)" }}
      />
      <div className="flex-1">
        <p className="font-semibold">
          <span style={{ color: "var(--il-blue)" }}>{finding.agent}</span> · {headline}
        </p>
        <p className="mt-0.5 font-mono text-[11px] text-secondary truncate" title={finding.reportPath}>
          {finding.reportPath}
        </p>
      </div>
      <button
        type="button"
        onClick={openReport}
        className="rounded border border-ironlore-blue/50 px-2 py-0.5 font-medium text-ironlore-blue hover:bg-ironlore-blue/20"
      >
        View report
      </button>
      <button
        type="button"
        aria-label="Dismiss lint findings banner"
        onClick={dismiss}
        className="flex h-5 w-5 items-center justify-center rounded hover:bg-ironlore-blue/20"
      >
        <X className="h-3.5 w-3.5" style={{ color: "var(--il-text3)" }} />
      </button>
    </div>
  );
}

/**
 * Build the "3 stale pages, 1 contradiction" headline. Drops zero
 * counts so a clean run shows "no issues" instead of "0 stale, 0
 * contradictions, 0 …" noise.
 */
function formatHeadline(c: LintFinding["counts"]): string {
  const parts: string[] = [];
  if (c.orphans > 0) parts.push(`${c.orphans} orphan${c.orphans === 1 ? "" : "s"}`);
  if (c.stale > 0) parts.push(`${c.stale} stale page${c.stale === 1 ? "" : "s"}`);
  if (c.contradictions > 0)
    parts.push(`${c.contradictions} contradiction${c.contradictions === 1 ? "" : "s"}`);
  if (c.coverageGaps > 0)
    parts.push(`${c.coverageGaps} coverage gap${c.coverageGaps === 1 ? "" : "s"}`);
  if (c.provenanceGaps > 0)
    parts.push(`${c.provenanceGaps} provenance gap${c.provenanceGaps === 1 ? "" : "s"}`);
  if (parts.length === 0) return "lint complete · no findings";
  return `${parts.join(", ")} · view report`;
}
