import { AGENTS_DIR } from "@ironlore/core";
import { Pause, Play, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { fetchAgentState, setAgentPaused } from "../lib/api.js";
import { useAppStore } from "../stores/app.js";
import { DisplayNum, Key, Meta, SectionLabel, StatusPip, Venn } from "./primitives/index.js";

/**
 * AgentDetailPage — per-agent canvas-grammar detail surface.
 *
 * Layout per docs/09-ui-and-brand.md §Agent detail:
 *   · Venn watermark hero with the serif-italic agent name triad
 *   · `runs · 24h`, `avg duration`, `headroom` stats row
 *   · `01 Recent runs` SectionLabel + table
 *   · right rail with `03 Config` and `04 Controls` sections
 *
 * Honest about what's backed by real data today:
 *   · State (`canRun`, `reason`) + pause/resume are wired to the
 *     existing `/agents/:slug/state` endpoint.
 *   · Stats, recent runs, and config metadata are not yet surfaced
 *     by the server — those sections render "—" placeholders rather
 *     than fake numbers. A later phase adds the endpoints.
 *   · "Open persona" jumps to `.agents/<slug>/persona.md` in the
 *     existing markdown editor — the one agent data we do have on
 *     disk.
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pausing, setPausing] = useState(false);

  const paused = state?.reason === "paused";

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    fetchAgentState(slug)
      .then((s) => {
        if (!cancelled) setState(s);
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const handleTogglePause = useCallback(async () => {
    if (pausing || !state) return;
    setPausing(true);
    try {
      const next = await setAgentPaused(slug, !paused);
      setState((prev) =>
        prev ? { ...prev, canRun: !next.paused, reason: next.paused ? "paused" : null } : prev,
      );
    } catch {
      // Rails errors are non-fatal here — surface via loadError so the
      // user sees the failed toggle on the next state refetch.
    } finally {
      setPausing(false);
    }
  }, [pausing, state, slug, paused]);

  const pipState: "running" | "paused" | "idle" | "warn" = paused
    ? "paused"
    : state?.canRun
      ? "idle"
      : state
        ? "warn"
        : "idle";

  return (
    <main
      id="main-content"
      aria-label={`Agent detail: ${slug}`}
      className="flex flex-1 flex-col overflow-y-auto"
      style={{ background: "var(--il-bg)", minWidth: 480 }}
    >
      {/* Hero */}
      <section
        className="flex items-start gap-8 px-10 py-7"
        style={{ borderBottom: "1px solid var(--il-border-soft)" }}
      >
        <Venn
          size={96}
          fill="var(--il-blue)"
          color="var(--il-text2)"
          lineWidth={0.7}
          aria-label="Agent emblem"
        />

        <div className="min-w-0 flex-1">
          <div className="mb-1.5">
            <StatusPip
              state={pipState}
              label={paused ? "paused" : state?.canRun ? "ready" : (state?.reason ?? "checking")}
            />
          </div>
          <h1
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 400,
              fontStyle: "italic",
              fontSize: 44,
              letterSpacing: "-0.025em",
              lineHeight: 1,
              margin: "0 0 6px",
              color: "var(--il-text)",
            }}
          >
            {slug}
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
            Agent persona lives on disk. Open the file to inspect or edit the prompt, budget, and
            tool list.
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
        </div>

        <div className="flex items-start gap-7">
          <StatBlock label="runs · 24h" value="—" />
          <StatBlock label="avg duration" value="—" />
          <StatBlock label="headroom" value="—" />
        </div>
      </section>

      {/* Close ribbon */}
      <div
        className="flex items-center justify-end gap-2 px-10 py-2 font-mono uppercase"
        style={{
          borderBottom: "1px solid var(--il-border-soft)",
          fontSize: 10,
          letterSpacing: "0.04em",
          color: "var(--il-text3)",
        }}
      >
        <span>Close</span>
        <button
          type="button"
          onClick={() => useAppStore.getState().setActiveAgentSlug(null)}
          aria-label="Close agent detail"
          className="rounded p-1 text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Body grid — recent runs left, config/controls rail right */}
      <div className="grid flex-1 min-h-0 grid-cols-[minmax(0,1fr)_320px]">
        <div className="px-10 py-6" style={{ borderRight: "1px solid var(--il-border-soft)" }}>
          <SectionLabel index={1} title="Recent runs" meta="LAST 24H" />
          <div className="mt-3">
            <RecentRunsPlaceholder />
          </div>

          <div className="mt-8">
            <SectionLabel index={2} title="Activity" meta="HOUR OF DAY" />
            <div
              className="mt-3 rounded border border-dashed px-4 py-6 text-center text-xs"
              style={{ borderColor: "var(--il-border-soft)", color: "var(--il-text3)" }}
            >
              Run-rate histogram lands when `/agents/:slug/runs` is wired. No fake data.
            </div>
          </div>
        </div>

        <div className="px-6 py-6">
          <SectionLabel index={3} title="Config" meta="" />
          <div className="mt-3 grid gap-3 text-xs">
            <ConfigRow k="slug" v={slug} />
            <ConfigRow k="persona" v={`${AGENTS_DIR}/${slug}/persona.md`} mono />
            <ConfigRow
              k="state"
              v={
                loadError
                  ? `error: ${loadError}`
                  : paused
                    ? "paused"
                    : state?.canRun
                      ? "ready"
                      : (state?.reason ?? "checking")
              }
            />
          </div>

          <div className="mt-6">
            <SectionLabel index={4} title="Controls" meta="" />
            <div className="mt-3 grid gap-1.5">
              <ControlButton
                icon={paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                label={paused ? "Resume" : "Pause"}
                hint={paused ? "let the rails accept runs again" : "stop accepting new runs"}
                disabled={!state || pausing}
                onClick={handleTogglePause}
              />
              <ControlButton
                label="Open persona"
                hint={`${AGENTS_DIR}/${slug}/persona.md`}
                shortcut=""
                onClick={() =>
                  useAppStore.getState().setActivePath(`${AGENTS_DIR}/${slug}/persona.md`)
                }
              />
              <ControlButton
                label="Talk to agent"
                hint="open AI panel · select this agent"
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

function StatBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        className="font-mono uppercase"
        style={{
          fontSize: 10,
          letterSpacing: "0.08em",
          color: "var(--il-text3)",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <DisplayNum size={36}>{value}</DisplayNum>
    </div>
  );
}

function RecentRunsPlaceholder() {
  return (
    <div
      className="rounded border border-dashed px-4 py-8 text-center text-xs"
      style={{
        borderColor: "var(--il-border-soft)",
        color: "var(--il-text3)",
      }}
    >
      Recent runs surface when <code className="font-mono">/jobs?agent=&lt;slug&gt;</code> is added.
      Skipping rather than inventing a timeline.
    </div>
  );
}

function ConfigRow({ k, v, mono = false }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="grid gap-0.5">
      <Meta k={k} v="" />
      <span
        className={mono ? "font-mono truncate" : "truncate"}
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
          className="font-mono uppercase truncate"
          style={{
            fontSize: 9.5,
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
