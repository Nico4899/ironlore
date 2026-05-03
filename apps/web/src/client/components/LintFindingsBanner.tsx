import { ClipboardList, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { wsClient } from "../lib/ws.js";
import { useAppStore } from "../stores/app.js";

interface LintToast {
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
  timestamp: number;
}

const AUTO_DISMISS_MS = 20_000;

/**
 * Lint-findings toast stack.
 *
 * Each `lint:findings` WebSocket event becomes its own toast. Multiple
 * concurrent agent runs no longer clobber each other the way the prior
 * single-slot banner did — every finding gets its own row, dismissible
 * independently. Auto-dismiss after 20s; the user can always re-open
 * the report by re-running the lint workflow or by opening the path
 * directly.
 *
 * Per-runId dedup — reconnect replays of the same `lint:findings`
 * event don't push a duplicate toast onto the stack. Once a runId is
 * dismissed (or auto-expired) it stays dismissed for the session, so
 * the same toast can't reappear if the WS gap-detector triggers a
 * replay.
 */
export function LintFindingsBanner() {
  const [toasts, setToasts] = useState<LintToast[]>([]);
  const [seenRunIds, setSeenRunIds] = useState<Set<string>>(new Set());

  const dismiss = useCallback((runId: string) => {
    setToasts((prev) => prev.filter((t) => t.runId !== runId));
  }, []);

  useEffect(() => {
    const unsubscribe = wsClient.onEvent((event) => {
      if (event.type !== "lint:findings") return;
      if (seenRunIds.has(event.runId)) return;
      setSeenRunIds((prev) => {
        const next = new Set(prev);
        next.add(event.runId);
        return next;
      });
      setToasts((prev) => [
        ...prev,
        {
          reportPath: event.reportPath,
          counts: event.counts,
          agent: event.agent,
          runId: event.runId,
          timestamp: Date.now(),
        },
      ]);
    });
    return unsubscribe;
  }, [seenRunIds]);

  // Auto-dismiss each toast on its own timer so a freshly-arrived
  //  toast doesn't reset the countdown for older ones.
  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((t) =>
      setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.runId !== t.runId));
      }, AUTO_DISMISS_MS),
    );
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [toasts]);

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-16 right-4 z-50 flex max-w-sm flex-col gap-2"
    >
      {toasts.map((t) => {
        const headline = formatHeadline(t.counts);
        const empty = headline === "no findings";
        return (
          <div
            key={t.runId}
            role="status"
            className="surface-glass pointer-events-auto flex items-start gap-2 rounded-xl px-4 py-3 text-xs"
            style={{
              boxShadow: empty
                ? "var(--shadow-lg), 0 0 12px oklch(0.72 0.17 148 / 0.18)"
                : "var(--shadow-lg), 0 0 12px oklch(0.78 0.16 80 / 0.2)",
              borderLeft: `2px solid ${empty ? "var(--il-green)" : "var(--il-amber)"}`,
            }}
          >
            <ClipboardList
              className="mt-0.5 h-4 w-4 shrink-0"
              style={{ color: empty ? "var(--il-green)" : "var(--il-amber)" }}
            />
            <div className="min-w-0 flex-1">
              <div
                className="flex items-baseline gap-1.5 font-mono uppercase"
                style={{ fontSize: 10.5, letterSpacing: "0.04em", color: "var(--il-text3)" }}
              >
                <span style={{ color: "var(--il-blue)" }}>{t.agent}</span>
                <span>lint</span>
              </div>
              <p className="mt-0.5 font-medium text-primary">{headline}</p>
              {!empty && (
                <button
                  type="button"
                  onClick={() => {
                    useAppStore.getState().setActivePath(t.reportPath);
                    dismiss(t.runId);
                  }}
                  className="mt-1 underline-offset-2 hover:underline"
                  style={{ color: "var(--il-blue)" }}
                >
                  View report
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.runId)}
              aria-label="Dismiss lint finding"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-tertiary outline-none hover:bg-ironlore-slate-hover hover:text-primary focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Build the "3 stale pages, 1 contradiction" headline. Drops zero
 * counts so a clean run shows "no findings" instead of "0 stale, 0
 * contradictions, 0 …" noise.
 */
function formatHeadline(c: LintToast["counts"]): string {
  const parts: string[] = [];
  if (c.orphans > 0) parts.push(`${c.orphans} orphan${c.orphans === 1 ? "" : "s"}`);
  if (c.stale > 0) parts.push(`${c.stale} stale page${c.stale === 1 ? "" : "s"}`);
  if (c.contradictions > 0)
    parts.push(`${c.contradictions} contradiction${c.contradictions === 1 ? "" : "s"}`);
  if (c.coverageGaps > 0)
    parts.push(`${c.coverageGaps} coverage gap${c.coverageGaps === 1 ? "" : "s"}`);
  if (c.provenanceGaps > 0)
    parts.push(`${c.provenanceGaps} provenance gap${c.provenanceGaps === 1 ? "" : "s"}`);
  if (parts.length === 0) return "no findings";
  return parts.join(" · ");
}
