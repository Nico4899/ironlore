import { AGENTS_DIR } from "@ironlore/core";
import { ExternalLink, Pause, Play, X, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  type AgentConfigResponse,
  type AgentHistogramResponse,
  type AgentJournalEntry,
  type AgentRunRecord,
  fetchAgentConfig,
  fetchAgentHistogram,
  fetchAgentJournal,
  fetchAgentRuns,
  fetchAgentState,
  setAgentPaused,
  startAutonomousRun,
} from "../lib/api.js";
import { useAppStore } from "../stores/app.js";
import { DisplayNum, DottedHead, Key, Meta, SectionLabel, StatusPip } from "./primitives/index.js";

/**
 * AgentDetailPage — per-agent canvas-grammar detail surface.
 *
 * Wires three read-only endpoints (added in Phase 6):
 *   · GET /agents/:slug/runs       → recent-runs table
 *   · GET /agents/:slug/histogram  → rolling-24h activity chart + cap
 *   · GET /agents/:slug/config     → rails state + persona drift chip
 *
 * Plus the pre-existing state + pause controls. Everything on this
 * page corresponds to a real query — no invented data.
 *
 * Per docs/04-ai-and-agents.md §§Run history and activity histogram
 * and §§Exposing persona frontmatter; 09-ui-and-brand.md §Agent
 * detail page.
 */
interface AgentDetailPageProps {
  slug: string;
}

interface AgentStateSnapshot {
  slug: string;
  canRun: boolean;
  reason: string | null;
}

export function AgentDetailPage({ slug }: AgentDetailPageProps) {
  const [state, setState] = useState<AgentStateSnapshot | null>(null);
  const [config, setConfig] = useState<AgentConfigResponse | null>(null);
  const [runs, setRuns] = useState<AgentRunRecord[] | null>(null);
  const [histogram, setHistogram] = useState<AgentHistogramResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pausing, setPausing] = useState(false);

  const paused = state?.reason === "agent is paused" || config?.status === "paused";

  // Fetch everything in parallel on slug change. Each fetch is
  //  independent so one endpoint failing only dims its own section
  //  rather than tanking the whole page.
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setState(null);
    setConfig(null);
    setRuns(null);
    setHistogram(null);

    fetchAgentState(slug)
      .then((s) => !cancelled && setState(s))
      .catch((err: Error) => !cancelled && setLoadError(err.message));
    fetchAgentConfig(slug)
      .then((c) => !cancelled && setConfig(c))
      .catch(() => {
        /* config failure is non-fatal; the rail shows "—" */
      });
    fetchAgentRuns(slug, 24)
      .then((r) => !cancelled && setRuns(r))
      .catch(() => !cancelled && setRuns([]));
    fetchAgentHistogram(slug)
      .then((h) => !cancelled && setHistogram(h))
      .catch(() => {
        /* histogram failure is non-fatal */
      });

    return () => {
      cancelled = true;
    };
  }, [slug]);

  const [running, setRunning] = useState(false);

  /**
   * Enqueue an autonomous run — same endpoint that powers the Home
   * §01 Active runs "Run now" CTA. Failures surface silently; the
   * run will show up (or not) in the recent-runs table on the next
   * poll.
   */
  const handleRunNow = useCallback(async () => {
    if (running || paused) return;
    setRunning(true);
    try {
      await startAutonomousRun(slug);
      // Re-fetch runs so the new entry lands immediately instead of
      //  waiting for the 10-second poll.
      const r = await fetchAgentRuns(slug, 24);
      setRuns(r);
    } catch {
      /* non-fatal; rails will re-report via the state endpoint */
    } finally {
      setRunning(false);
    }
  }, [running, paused, slug]);

  const handleTogglePause = useCallback(async () => {
    if (pausing || !state) return;
    setPausing(true);
    try {
      const next = await setAgentPaused(slug, !paused);
      setState((prev) =>
        prev
          ? { ...prev, canRun: !next.paused, reason: next.paused ? "agent is paused" : null }
          : prev,
      );
      setConfig((prev) =>
        prev
          ? {
              ...prev,
              status: next.paused ? "paused" : "active",
              pauseReason: next.paused ? "user" : null,
            }
          : prev,
      );
    } catch {
      /* non-fatal: next load will resync */
    } finally {
      setPausing(false);
    }
  }, [pausing, state, slug, paused]);

  // Keyboard shortcuts for §04 Controls. Ignore keys when the user is
  //  typing in any input or contenteditable — the detail page can sit
  //  behind an open command palette or inline editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable) return;
      }
      // ⌘R / Ctrl-R — Run now. Browser's reload binding wins on most
      //  OSes, so this is a best-effort affordance; the button is the
      //  durable path.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "r" && !e.shiftKey) {
        e.preventDefault();
        void handleRunNow();
        return;
      }
      // Escape — close the detail surface. Mirrors the X button and
      //  the modal-dialog grammar used elsewhere in the app.
      if (e.key === "Escape") {
        e.preventDefault();
        useAppStore.getState().setActiveAgentSlug(null);
        return;
      }
      // `P` (unmodified) — toggle pause.
      if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        void handleTogglePause();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleRunNow, handleTogglePause]);

  // Is the agent's most-recent run still running? The observability
  //  endpoint returns runs ordered desc by startedAt; status==="running"
  //  on the top row means the executor is currently streaming against
  //  this agent. Used for the hero `running · step NN` label and to
  //  disable the "Run now" control.
  const latestRun = runs?.[0] ?? null;
  const isLiveRun = latestRun?.status === "running";

  const pipState: "running" | "paused" | "idle" | "warn" = paused
    ? "paused"
    : isLiveRun
      ? "running"
      : state?.canRun
        ? "idle"
        : state
          ? "warn"
          : "idle";

  /**
   * Hero pip label — always mono uppercase, one of:
   *   · `running · step NN` while a run is in flight
   *   · `paused · <reason>` when the rails say stop
   *   · `idle` otherwise
   * Never Inter; never a raw error string. Matches the same state
   * grammar used on the sidebar, Home Active runs, and AI panel
   * header so the user reads one vocabulary across the product.
   */
  const pipLabel = isLiveRun
    ? `running · step ${String(latestRun?.stepCount ?? 0).padStart(2, "0")}`
    : paused
      ? `paused · ${(config?.pauseReason ?? state?.reason ?? "user").toLowerCase()}`
      : "idle";

  // Display-variant toggle for the hero slug: the safe variant keeps
  //  Inter 600 30 (matching screen-more.jsx `ScreenAgentDetail` safe
  //  silhouette); the serif display variant swaps to Instrument
  //  Serif 400 italic 48 with a trailing italic `.` period, echoing
  //  the Home / Settings hero grammar. Onboarding stays
  //  unconditionally serif; everything else respects typeDisplay.
  const typeDisplay = useAppStore((s) => s.typeDisplay);
  const serif = typeDisplay === "serif";

  // Prose description comes from persona.md frontmatter. Falls back
  //  to a terse instruction so the hero never reads blank.
  const description =
    config?.persona?.description ??
    "Open the persona file to inspect or edit the prompt, budget, and tool list.";

  // Hero stats — all derived from the two data endpoints. `runs · 24h`
  //  sums the 24 histogram buckets; `avg duration` medians the recent
  //  runs' `finishedAt - startedAt`; `headroom` shows the slack under
  //  the daily cap.
  const runs24h = histogram ? histogram.buckets.reduce((a, b) => a + b, 0) : null;
  const headroom =
    histogram && runs24h !== null ? Math.max(0, histogram.cap.perDay - runs24h) : null;
  const avgDurationSec = runs ? medianDurationSeconds(runs) : null;

  return (
    <main
      id="main-content"
      aria-label={`Agent detail: ${slug}`}
      className="flex flex-1 flex-col overflow-y-auto"
      style={{ background: "var(--il-bg)", minWidth: 480 }}
    >
      {/* Hero */}
      <section
        className="relative flex items-start gap-8 px-10 py-7"
        style={{ borderBottom: "1px solid var(--il-border-soft)" }}
      >
        {/* Close affordance — returns to whatever surface was open
         *  before (editor / home). Lives top-right in the hero so it
         *  doesn't compete with the stat grid or the slug. */}
        <button
          type="button"
          onClick={() => useAppStore.getState().setActiveAgentSlug(null)}
          aria-label="Close agent detail"
          title="Close (Esc)"
          className="absolute flex items-center justify-center rounded outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
          style={{
            top: 14,
            right: 14,
            width: 26,
            height: 26,
            background: "transparent",
            border: "1px solid var(--il-border-soft)",
            color: "var(--il-text3)",
            cursor: "pointer",
          }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <DottedHead size={96} color="var(--il-blue)" aria-label={`${slug} emblem`} />

        <div className="min-w-0 flex-1">
          <div className="mb-1.5">
            <StatusPip state={pipState} label={pipLabel} />
          </div>
          <h1
            style={{
              fontFamily: serif ? "var(--font-display)" : "var(--font-sans)",
              fontWeight: serif ? 400 : 600,
              fontStyle: serif ? "italic" : "normal",
              fontSize: serif ? 48 : 30,
              letterSpacing: "-0.025em",
              lineHeight: 1,
              margin: "0 0 6px",
              color: "var(--il-text)",
            }}
          >
            {slug}
            {serif && <span style={{ fontStyle: "italic", color: "var(--il-text2)" }}>.</span>}
          </h1>
          <p
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 14,
              color: "var(--il-text2)",
              margin: 0,
              maxWidth: 620,
              lineHeight: 1.5,
            }}
          >
            {description}
          </p>
          <div
            className="mt-1 font-mono"
            style={{
              fontSize: 10.5,
              letterSpacing: "0.02em",
              color: "var(--il-text4)",
            }}
          >
            → {`${AGENTS_DIR}/${slug}/persona.md`}
          </div>
          {/* Header chips: an always-visible "open persona" button
           *  (routes the editor to the persona.md for this slug) plus
           *  the amber drift chip when persona.md is newer than the
           *  rails-state mirror. Kept in one row so the hero has a
           *  single chip strip beneath the locator path. */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                useAppStore.getState().setActivePath(`${AGENTS_DIR}/${slug}/persona.md`)
              }
              className="inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono uppercase outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
              style={{
                borderColor: "var(--il-border-soft)",
                background: "var(--il-slate)",
                color: "var(--il-text2)",
                fontSize: 10.5,
                letterSpacing: "0.04em",
                cursor: "pointer",
              }}
              title={`Open ${AGENTS_DIR}/${slug}/persona.md in the editor`}
            >
              <ExternalLink className="h-3 w-3" />
              open persona
            </button>
            {config?.personaMtimeDriftSeconds != null && config.personaMtimeDriftSeconds > 0 && (
              <div
                className="inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono uppercase"
                style={{
                  borderColor: "var(--il-amber)",
                  color: "var(--il-amber)",
                  background: "color-mix(in oklch, var(--il-amber) 10%, transparent)",
                  fontSize: 10.5,
                  letterSpacing: "0.04em",
                }}
                title="persona.md was edited more recently than the rails state was refreshed"
              >
                persona drift · {formatDrift(config.personaMtimeDriftSeconds)}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-start gap-7">
          <StatBlock label="runs · 24h" value={runs24h !== null ? String(runs24h) : "—"} />
          <StatBlock
            label="avg duration"
            value={avgDurationSec !== null ? String(avgDurationSec) : "—"}
            unit={avgDurationSec !== null ? "s" : undefined}
          />
          <StatBlock
            label="headroom"
            value={headroom !== null ? String(headroom) : "—"}
            unit={headroom !== null ? "/day" : undefined}
            accent={headroom !== null && headroom < 10 ? "amber" : undefined}
          />
        </div>
      </section>

      {/* Body grid — recent runs left, config/controls rail right.
       *  Close ribbon dropped per spec; exit via the sidebar tree
       *  (clicking any file path clears `activeAgentSlug`). */}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px]">
        <div className="px-10 py-6" style={{ borderRight: "1px solid var(--il-border-soft)" }}>
          <SectionLabel index={1} title="Recent runs" meta="LAST 24" />
          <div className="mt-3">
            <RecentRunsTable runs={runs} />
          </div>

          <div className="mt-8">
            <SectionLabel index={2} title="Activity" meta="ROLLING 24H" />
            <div className="mt-3">
              <ActivityHistogram histogram={histogram} />
            </div>
          </div>

          {/* Recent journal shares the main column so it lines up
           *  with Recent runs and Activity — the side rail is
           *  reserved for dense config/controls rows. */}
          <div className="mt-8">
            <JournalSection slug={slug} />
          </div>
        </div>

        <div className="px-6 py-6">
          <SectionLabel index={4} title="Config" meta="" />
          <div className="mt-3 grid gap-3 text-xs">
            <ConfigRow k="slug" v={slug} />
            <ConfigRow
              k="state"
              v={
                loadError
                  ? `error: ${loadError}`
                  : paused
                    ? (config?.pauseReason ?? "paused")
                    : (state?.canRun ?? false)
                      ? "ready"
                      : (state?.reason ?? "checking")
              }
            />
            <ConfigRow k="schedule" v={formatHeartbeat(config?.persona?.heartbeat)} mono />
            <ConfigRow k="review mode" v={config?.persona?.reviewMode ?? "—"} mono />
            <ConfigRow k="tools" v={formatTools(config?.persona?.tools)} mono />
            <ConfigRow k="budget" v={formatBudget(config?.persona?.budget)} mono />
            <ConfigRow k="scope" v={formatScope(config?.persona?.scope)} mono />
            <ConfigRow
              k="rate caps"
              v={config ? `${config.maxRunsPerHour}/hour · ${config.maxRunsPerDay}/day` : "—"}
              mono
            />
            <ConfigRow k="failure streak" v={config ? `${config.failureStreak} / 3` : "—"} mono />
            <ConfigRow k="persona" v={`${AGENTS_DIR}/${slug}/persona.md`} mono />
          </div>

          <div className="mt-6">
            <SectionLabel index={5} title="Controls" meta="" />
            <div className="mt-3 grid gap-1.5">
              {/* Pause / Resume — `P` (unmodified) toggles.
               *  "Rotate branch" from the doc spec is intentionally
               *  not rendered: no server endpoint exists for it and
               *  the brand rule is to drop non-functional chrome. */}
              <ControlButton
                icon={paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                label={paused ? "Resume" : "Pause"}
                shortcut="P"
                disabled={!state || pausing}
                onClick={handleTogglePause}
              />
              <ControlButton
                icon={<Zap className="h-3.5 w-3.5" />}
                label="Run now"
                shortcut="⌘R"
                disabled={running || paused || isLiveRun}
                onClick={handleRunNow}
              />
              <ControlButton
                label="Talk to agent"
                shortcut="⌘⇧A"
                onClick={() => useAppStore.getState().toggleAIPanel()}
              />
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * §03 — last N agent.journal entries, newest first. Each entry
 * carries its own job id so users can click through to the run
 * later (not wired today — the row is read-only). Empty state is
 * rendered (not hidden) so the section stays discoverable before
 * the agent has journaled anything.
 */
function JournalSection({ slug }: { slug: string }) {
  const [entries, setEntries] = useState<AgentJournalEntry[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchAgentJournal(slug, 12)
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (entries === null) return null; // loading — avoid layout jank

  // Empty state is rendered (not hidden) so the section is
  //  discoverable even before the agent has journaled anything —
  //  that way the user knows §06 exists and will populate once the
  //  agent runs start using `agent.journal`.
  const isEmpty = entries.length === 0;

  return (
    <div>
      <SectionLabel
        index={3}
        title="Recent journal"
        meta={isEmpty ? "none yet" : `last ${entries.length}`}
      />
      {isEmpty ? (
        <div
          className="mt-3 rounded border border-dashed px-4 py-5 text-center"
          style={{
            borderColor: "var(--il-border-soft)",
            color: "var(--il-text3)",
            fontSize: 12.5,
          }}
        >
          No journal entries yet. They appear here when this agent emits{" "}
          <span className="font-mono" style={{ fontSize: 11.5, color: "var(--il-text2)" }}>
            agent.journal
          </span>{" "}
          during a run.
        </div>
      ) : (
        <div className="mt-3 grid gap-2">
          {entries.map((entry) => (
            <JournalRow key={`${entry.jobId}-${entry.timestamp}`} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

function JournalRow({ entry }: { entry: AgentJournalEntry }) {
  return (
    <div
      style={{
        padding: "10px 12px",
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
          color: "var(--il-blue)",
          marginBottom: 4,
        }}
      >
        → journal · {formatShortDate(entry.timestamp)}
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.55, color: "var(--il-text2)" }}>{entry.text}</div>
    </div>
  );
}

function formatShortDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ───────────────────────── subcomponents ─────────────────────────

interface StatBlockProps {
  label: string;
  value: string;
  unit?: string;
  accent?: "amber";
}

function StatBlock({ label, value, unit, accent }: StatBlockProps) {
  return (
    <div>
      <div
        className="font-mono uppercase"
        style={{
          fontSize: 10.5,
          letterSpacing: "0.08em",
          color: "var(--il-text3)",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div className="flex items-baseline gap-1">
        <DisplayNum
          size={36}
          style={{ color: accent === "amber" ? "var(--il-amber)" : "var(--il-text)" }}
        >
          {value}
        </DisplayNum>
        {unit && (
          <span className="font-mono" style={{ fontSize: 11, color: "var(--il-text3)" }}>
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}

function RecentRunsTable({ runs }: { runs: AgentRunRecord[] | null }) {
  if (runs === null) {
    return <div className="py-6 text-center text-xs text-secondary">Loading…</div>;
  }
  if (runs.length === 0) {
    return (
      <div
        className="rounded border border-dashed px-4 py-6 text-center text-xs"
        style={{ borderColor: "var(--il-border-soft)", color: "var(--il-text3)" }}
      >
        No runs in the last 24 hours.
      </div>
    );
  }

  return (
    <div className="grid gap-0.5">
      {runs.map((r, idx) => (
        <div
          key={r.jobId}
          className="grid items-center gap-3 rounded"
          style={{
            gridTemplateColumns: "64px 16px 68px minmax(0, 1fr) auto",
            padding: "6px 10px",
            background:
              idx === 0 ? "color-mix(in oklch, var(--il-blue) 8%, transparent)" : "transparent",
            borderLeft: `2px solid ${idx === 0 ? "var(--il-blue)" : "transparent"}`,
          }}
          title={`Job ${r.jobId}${r.commitShaEnd ? ` · ${r.commitShaEnd.slice(0, 7)}` : ""}`}
        >
          <span className="font-mono" style={{ fontSize: 11, color: "var(--il-text3)" }}>
            {formatClockTime(r.startedAt)}
          </span>
          {/* 10 px pip — spec §Reuleaux sizes: cards / rows. */}
          <StatusPip state={r.status} size={10} />
          <span
            className="font-mono"
            style={{ fontSize: 10.5, color: "var(--il-text3)", letterSpacing: "0.04em" }}
          >
            step {String(r.stepCount).padStart(2, "0")}
          </span>
          <span className="truncate" style={{ fontSize: 12.5, color: "var(--il-text)" }}>
            {r.note ?? "—"}
          </span>
          {/* Right-most column is a mono arrow per the JSX spec — the
           *  commit SHA moves to the row's title tooltip so hover still
           *  reveals the endpoint, but the column itself stays a clean
           *  directional cue rather than a hash. */}
          <span className="font-mono" style={{ fontSize: 11, color: "var(--il-text4)" }}>
            →
          </span>
        </div>
      ))}
    </div>
  );
}

function ActivityHistogram({ histogram }: { histogram: AgentHistogramResponse | null }) {
  if (!histogram) {
    return <div className="py-6 text-center text-xs text-secondary">Loading…</div>;
  }
  // Cap line: the hourly max. Scale bars against (cap.perHour * 1.5)
  //  so the cap line lands at ~67% of frame — never crowds the top
  //  and always visible even on a quiet hour.
  const ceilingRef = Math.max(1, histogram.cap.perHour * 1.5);
  const maxBucket = Math.max(...histogram.buckets, histogram.cap.perHour);
  const scale = Math.max(ceilingRef, maxBucket);
  const capPct = (histogram.cap.perHour / scale) * 100;

  return (
    <div>
      <div
        className="relative flex items-end gap-0.5 rounded"
        style={{
          height: 72,
          padding: "0 2px",
          borderBottom: "1px dashed var(--il-border)",
        }}
      >
        {histogram.buckets.map((count, i) => {
          const h = (count / scale) * 100;
          const warn = count >= histogram.cap.perHour;
          const isMostRecent = i === histogram.buckets.length - 1;
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: index is the bucket index by definition
              key={i}
              className="flex flex-1 flex-col items-center justify-end"
              style={{ height: "100%" }}
              title={`${count} run${count === 1 ? "" : "s"}`}
            >
              <div
                style={{
                  width: "100%",
                  height: `${h}%`,
                  background: warn ? "var(--il-amber)" : "var(--il-blue)",
                  opacity: isMostRecent ? 1 : 0.55,
                  boxShadow: isMostRecent ? "0 0 10px var(--il-blue-glow)" : "none",
                  borderRadius: 1,
                }}
              />
            </div>
          );
        })}
        {/* Cap line — amber dashed at y = cap.perHour */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: `${capPct}%`,
            borderTop: "1px dashed var(--il-amber)",
            opacity: 0.5,
          }}
        />
      </div>
      <div
        className="mt-1.5 flex justify-between font-mono"
        style={{
          fontSize: 10.5,
          letterSpacing: "0.06em",
          color: "var(--il-text4)",
        }}
      >
        <span>-24h</span>
        <span>-18h</span>
        <span>-12h</span>
        <span>-6h</span>
        <span>now</span>
      </div>
      <div
        className="mt-2 font-mono uppercase"
        style={{
          fontSize: 10.5,
          letterSpacing: "0.04em",
          color: "var(--il-amber)",
        }}
      >
        cap · {histogram.cap.perHour}/hour · {histogram.cap.perDay}/day
      </div>
    </div>
  );
}

function ConfigRow({ k, v, mono = false }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="grid gap-0.5">
      <Meta k={k} v="" />
      <span
        className={mono ? "truncate font-mono" : "truncate"}
        style={{ fontSize: 12.5, color: "var(--il-text)" }}
      >
        {v}
      </span>
    </div>
  );
}

interface ControlButtonProps {
  icon?: React.ReactNode;
  label: string;
  hint?: string;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
}

function ControlButton({ icon, label, hint, shortcut, disabled, onClick }: ControlButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex items-center gap-2 rounded border text-left outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue/50 disabled:opacity-40"
      style={{
        padding: "7px 10px",
        background: "var(--il-slate)",
        borderColor: "var(--il-border-soft)",
        color: "var(--il-text)",
      }}
    >
      {icon}
      <span className="flex-1 text-[12.5px]">{label}</span>
      {hint && !shortcut && (
        <span
          className="truncate font-mono uppercase"
          style={{
            fontSize: 10.5,
            letterSpacing: "0.04em",
            color: "var(--il-text3)",
            maxWidth: 160,
          }}
        >
          {hint}
        </span>
      )}
      {shortcut && <Key>{shortcut}</Key>}
    </button>
  );
}

// ───────────────────────── helpers ─────────────────────────

function formatClockTime(ms: number): string {
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/** Median duration (in whole seconds) of the completed runs. */
function medianDurationSeconds(runs: AgentRunRecord[]): number | null {
  const completed = runs
    .filter((r) => r.finishedAt !== null)
    .map((r) => ((r.finishedAt as number) - r.startedAt) / 1000)
    .filter((n) => n >= 0);
  if (completed.length === 0) return null;
  completed.sort((a, b) => a - b);
  const mid = Math.floor(completed.length / 2);
  if (completed.length % 2 === 1) {
    return Math.round(completed[mid] ?? 0);
  }
  const a = completed[mid - 1] ?? 0;
  const b = completed[mid] ?? 0;
  return Math.round((a + b) / 2);
}

/** Short human-readable drift: "5m", "2h", "3d". */
function formatDrift(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/**
 * Translate a small set of common cron patterns into prose the
 * config rail can show alongside raw schedules that don't match.
 * Falls back to the literal cron string so anything unrecognized
 * still reads as "what persona.md says" rather than "—".
 */
function formatHeartbeat(cron: string | null | undefined): string {
  if (!cron) return "—";
  const trimmed = cron.trim();

  // */N * * * *  →  every N minutes
  const everyNMin = /^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/.exec(trimmed);
  if (everyNMin?.[1]) return `every ${everyNMin[1]}m`;

  // 0 */N * * *  →  every N hours
  const everyNHr = /^0\s+\*\/(\d+)\s+\*\s+\*\s+\*$/.exec(trimmed);
  if (everyNHr?.[1]) return `every ${everyNHr[1]}h`;

  // 0 H * * 1-5 / M H * * 1-5  →  weekdays H:MM
  const weekdays = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+1-5$/.exec(trimmed);
  if (weekdays?.[1] && weekdays[2])
    return `weekdays ${weekdays[2].padStart(2, "0")}:${weekdays[1].padStart(2, "0")}`;

  return trimmed;
}

/**
 * Tools joined as `a · b · c` with a "+N" tail once the list outgrows
 * the rail. The rail is 320px — showing more than four tool names
 * wraps awkwardly.
 */
function formatTools(tools: string[] | null | undefined): string {
  if (!tools || tools.length === 0) return "—";
  const shown = tools.slice(0, 4).join(" · ");
  const extra = tools.length - 4;
  return extra > 0 ? `${shown} · +${extra}` : shown;
}

/**
 * Budget line — only shows the fields persona.md actually defines.
 * Prefers `fsync_ms` when present because that's the canvas's
 * canonical budget tagline ("4ms fsync").
 */
function formatBudget(
  b: { tokens: number | null; toolCalls: number | null; fsyncMs: number | null } | null | undefined,
): string {
  if (!b) return "—";
  const parts: string[] = [];
  if (b.fsyncMs !== null) parts.push(`${b.fsyncMs}ms fsync`);
  if (b.tokens !== null) parts.push(`${Math.round(b.tokens / 1000)}k tokens`);
  if (b.toolCalls !== null) parts.push(`${b.toolCalls} calls`);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

/**
 * Scope line — page globs + writable kinds. Show the first page
 * glob prose-style; counts the rest ("+N more"). Writable kinds
 * follow in parens when present.
 */
function formatScope(
  scope: { pages: string[] | null; writableKinds: string[] | null } | null | undefined,
): string {
  if (!scope) return "—";
  const pageParts: string[] = [];
  if (scope.pages && scope.pages.length > 0) {
    const first = scope.pages[0];
    if (first) pageParts.push(first);
    if (scope.pages.length > 1) pageParts.push(`+${scope.pages.length - 1} more`);
  }
  if (scope.writableKinds && scope.writableKinds.length > 0) {
    pageParts.push(`writable: ${scope.writableKinds.join(", ")}`);
  }
  return pageParts.length > 0 ? pageParts.join(" · ") : "—";
}
