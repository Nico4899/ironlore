import { Inbox, LayoutGrid, Search, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useWorkspaceActivity } from "../hooks/useWorkspaceActivity.js";
import {
  type AgentHistogramResponse,
  ApiError,
  fetchAgentHistogram,
  fetchRecentEdits,
  type RecentEdit,
  startAutonomousRun,
} from "../lib/api.js";
import { useAppStore } from "../stores/app.js";
import {
  AgentPulse,
  DisplayNum,
  Key,
  Meta,
  Reuleaux,
  SectionLabel,
  Venn,
} from "./primitives/index.js";

/**
 * HomePanel — the §Home canvas-grammar landing surface.
 *
 * Matches `screen-home.jsx` (JSX source-of-truth) + rev-5 §Home in
 * `docs/09-ui-and-brand.md`:
 *
 *  · Full-width hero with mono overline (date + live counter) and an
 *    Inter-or-Serif greeting; a 1 px hairline separates hero from body.
 *  · 1.3fr / 1fr body grid, each column padded + independently
 *    scrollable, LEFT column carries a 1 px right-edge rule — the
 *    schematic two-pane split the JSX prescribes.
 *  · LEFT: §01 Active runs + §02 Recent pages.
 *  · RIGHT: §03 Run-rate headroom + §04 Quick actions.
 *  · On a fresh project (zero pages AND zero agents), §01 and §03
 *    suppress and a dim Venn watermark carries the rest state.
 *
 * Elements without a data-backed signal were intentionally dropped:
 * no mock trend arrow on run-rate, no target path / progress bar on
 * AgentRunCard (we don't have a total-steps feed yet). Every visible
 * chip maps to a real field.
 */
export function HomePanel() {
  const [recent, setRecent] = useState<RecentEdit[] | null>(null);

  useEffect(() => {
    fetchRecentEdits(8)
      .then(setRecent)
      .catch(() => setRecent([]));
  }, []);

  const greeting = useGreeting();
  const today = useTodayLabel();
  const activity = useWorkspaceActivity();
  const typeDisplay = useAppStore((s) => s.typeDisplay);
  const displaySerif = typeDisplay === "serif";

  const hasActivity = activity.runningCount > 0 || activity.inboxCount > 0;
  // "Fresh project" — zero recent pages AND zero installed agents.
  //  This is the exact trigger for the Venn watermark (§Home in
  //  docs/09-ui-and-brand.md). On a fresh project §01 Active runs and
  //  §03 Run-rate headroom suppress so the canvas doesn't announce
  //  "nothing here" twice; the Venn + §02 Recent pages + §04 Quick
  //  actions carry the rest state together.
  const isFreshProject =
    recent !== null && recent.length === 0 && activity.loaded && activity.agents.length === 0;

  const idleCount = activity.agents.filter((a) => !a.running && a.status === "active").length;
  const pausedCount = activity.agents.filter((a) => a.status === "paused").length;
  const activeRunsMeta = formatActiveRunsMeta(activity.runningCount, idleCount, pausedCount);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Venn watermark — contemplative rest when nothing exists yet.
       *  Sized + positioned like screen-home.jsx's bold-variant hero
       *  accent but trigger-gated to fresh projects so it never fights
       *  populated canvases. */}
      {isFreshProject && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute"
          style={{ top: 60, right: 48, opacity: 0.35 }}
        >
          <Venn
            size={220}
            color="var(--il-text4)"
            lineWidth={0.5}
            ringOpacity={0.6}
            fillOpacity={0.35}
          />
        </div>
      )}

      {/* ─── Hero ─── */}
      <div
        style={{
          position: "relative",
          padding: displaySerif ? "40px 48px 28px" : "28px 36px 18px",
          borderBottom: "1px solid var(--il-border-soft)",
        }}
      >
        <div
          className="flex items-center gap-2 font-mono uppercase"
          style={{
            fontSize: 10.5,
            letterSpacing: "0.12em",
            color: "var(--il-text3)",
            marginBottom: 10,
          }}
        >
          {/* 8 px pip — spec §Reuleaux sizes: headers / banners. The
           *  hero overline is the most prominent inline location, so
           *  it runs at the upper end of the inline range. */}
          <Reuleaux size={8} color="var(--il-blue)" />
          <span>{today}</span>
          {hasActivity && (
            <>
              <span style={{ color: "var(--il-text4)" }}>/</span>
              <span>
                {activity.runningCount > 0 && (
                  <>
                    <span style={{ color: "var(--il-text)" }}>{activity.runningCount}</span>{" "}
                    {activity.runningCount === 1 ? "agent" : "agents"} working
                  </>
                )}
                {activity.runningCount > 0 && activity.inboxCount > 0 && ", "}
                {activity.inboxCount > 0 && (
                  <button
                    type="button"
                    onClick={() => useAppStore.getState().openSidebarTab("inbox")}
                    className="inline-flex items-baseline gap-1 rounded-sm outline-none hover:underline focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "inherit",
                      cursor: "pointer",
                      font: "inherit",
                      letterSpacing: "inherit",
                      padding: 0,
                    }}
                    aria-label={`Open inbox (${activity.inboxCount} pending)`}
                    title="Open inbox"
                  >
                    <span style={{ color: "var(--il-text)" }}>{activity.inboxCount}</span>
                    <span>in inbox</span>
                  </button>
                )}
              </span>
            </>
          )}
        </div>
        <h1
          style={
            displaySerif
              ? {
                  fontFamily: "var(--font-serif)",
                  fontSize: 48,
                  fontWeight: 400,
                  letterSpacing: "-0.025em",
                  lineHeight: 1.05,
                  color: "var(--il-text)",
                  margin: 0,
                  maxWidth: 680,
                }
              : {
                  fontFamily: "var(--font-sans)",
                  fontSize: 26,
                  fontWeight: 600,
                  letterSpacing: "-0.02em",
                  lineHeight: 1.05,
                  color: "var(--il-text)",
                  margin: 0,
                  maxWidth: 680,
                }
          }
        >
          {greeting}
          {displaySerif && (
            <>
              .
              <br />
              <span style={{ fontStyle: "italic", color: "var(--il-text2)" }}>
                {isFreshProject
                  ? "An empty canvas is a contract."
                  : hasActivity
                    ? "Let's pick up where you left off."
                    : "Pick up where you left off."}
              </span>
            </>
          )}
        </h1>
        {/* Safe-mode sub-paragraph. Renders on every canvas state —
         *  fresh, populated, and in-between — with data-driven copy so
         *  the line is never generic filler. Bold mode carries its own
         *  italic continuation inside the h1 above, so this block
         *  suppresses there. */}
        {!displaySerif && (
          <div
            style={{
              color: "var(--il-text2)",
              fontSize: 14,
              marginTop: 8,
              maxWidth: 600,
              lineHeight: 1.5,
            }}
          >
            {isFreshProject ? (
              <>
                Create a page from the sidebar, drop files to upload, or install a persona into{" "}
                <code
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 12.5,
                    color: "var(--il-text)",
                  }}
                >
                  .agents/
                </code>{" "}
                to get started.
              </>
            ) : activity.inboxCount > 0 ? (
              <>
                {activity.inboxCount === 1
                  ? "One run awaits"
                  : `${activity.inboxCount} runs await`}{" "}
                your review.
                {activity.runningCount > 0 && (
                  <>
                    {" "}
                    {activity.runningCount === 1
                      ? "Another agent is"
                      : `${activity.runningCount} other agents are`}{" "}
                    working in the background.
                  </>
                )}
              </>
            ) : activity.runningCount > 0 ? (
              <>
                {activity.runningCount === 1 ? "One agent is" : `${activity.runningCount} agents are`}{" "}
                working. Pick up where you left off.
              </>
            ) : (
              "Pick up where you left off."
            )}
          </div>
        )}
      </div>

      {/* ─── Body grid ─── */}
      <div
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.3fr) minmax(0, 1fr)",
          minHeight: 0,
        }}
      >
        {/* LEFT column */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 26,
            padding: "20px 28px",
            borderRight: "1px solid var(--il-border-soft)",
            overflowY: "auto",
            minWidth: 0,
          }}
        >
          {!isFreshProject && (
            <section>
              <SectionLabel index={1} title="Active runs" meta={activeRunsMeta} />
              <div style={{ display: "grid", gap: 10 }}>
                {!activity.loaded ? (
                  <LoadingRow />
                ) : activity.agents.length === 0 ? (
                  <EmptyCard>No agents installed yet.</EmptyCard>
                ) : (
                  orderedForHome(activity.agents).map((a) => (
                    <ActiveAgentCard
                      key={a.slug}
                      slug={a.slug}
                      running={a.running}
                      paused={a.status === "paused"}
                      stepLabel={a.stepLabel}
                      note={a.lastNote}
                      displaySerif={displaySerif}
                    />
                  ))
                )}
              </div>
            </section>
          )}

          <section>
            <SectionLabel index={2} title="Recent pages" meta="LAST 7 DAYS" />
            {recent === null ? (
              <LoadingRow />
            ) : recent.length === 0 ? (
              <EmptyCard>Nothing here yet.</EmptyCard>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" style={{ minWidth: 0 }}>
                {recent.map((p) => (
                  <RecentCard key={p.path} entry={p} displaySerif={displaySerif} />
                ))}
              </div>
            )}
          </section>
        </div>

        {/* RIGHT column */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 22,
            padding: "20px 28px",
            overflowY: "auto",
            minWidth: 0,
          }}
        >
          {!isFreshProject && (
            <section>
              <SectionLabel index={3} title="Run-rate headroom" meta="ROLLING 24H" />
              <RunRateHeadroom agents={activity.agents} displaySerif={displaySerif} />
            </section>
          )}

          <section>
            <SectionLabel index={4} title="Quick actions" meta="⌘-JUMPABLE" />
            <div style={{ display: "grid", gap: 6 }}>
              <QuickAction
                icon={<Search className="h-3.5 w-3.5" />}
                label="Search everything"
                shortcut="⌘K"
                onClick={() => useAppStore.getState().toggleSearchDialog()}
              />
              <QuickAction
                icon={<Sparkles className="h-3.5 w-3.5" />}
                label="Toggle AI panel"
                shortcut="⌘⇧A"
                onClick={() => useAppStore.getState().toggleAIPanel()}
              />
              <QuickAction
                icon={<LayoutGrid className="h-3.5 w-3.5" />}
                label="Switch project"
                shortcut="⌘P"
                onClick={() => useAppStore.getState().toggleProjectSwitcher()}
              />
              <QuickAction
                icon={<Inbox className="h-3.5 w-3.5" />}
                label="Open inbox"
                onClick={() => useAppStore.getState().openSidebarTab("inbox")}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * Sort active agents for the Home screen: running first, then
 * non-paused, then paused at the bottom. Deterministic across polls.
 */
function orderedForHome(
  agents: ReturnType<typeof useWorkspaceActivity>["agents"],
): ReturnType<typeof useWorkspaceActivity>["agents"] {
  const rank = (a: (typeof agents)[number]) => (a.running ? 0 : a.status === "paused" ? 2 : 1);
  return [...agents].sort((a, b) => rank(a) - rank(b));
}

function formatActiveRunsMeta(running: number, idle: number, paused: number): string {
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} RUNNING`);
  if (idle > 0) parts.push(`${idle} IDLE`);
  if (paused > 0) parts.push(`${paused} PAUSED`);
  return parts.length > 0 ? parts.join(" · ") : "NO AGENTS";
}

function LoadingRow() {
  return (
    <div
      className="font-mono"
      style={{
        padding: "14px 0",
        textAlign: "center",
        fontSize: 10.5,
        letterSpacing: "0.06em",
        color: "var(--il-text3)",
        textTransform: "uppercase",
      }}
    >
      loading…
    </div>
  );
}

function EmptyCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "14px 16px",
        border: "1px dashed var(--il-border-soft)",
        borderRadius: 3,
        color: "var(--il-text3)",
        fontSize: 12.5,
        textAlign: "center",
      }}
    >
      {children}
    </div>
  );
}

/**
 * Active-agent card matching `screen-home.jsx` AgentRunCard:
 *  · AgentPulse wrapper (live sweep while running)
 *  · Reuleaux + slug + status + step-meta row
 *  · Action line from the most-recent run's `note` (when present)
 *  · 2 px blue-left rail when live, neutral rail otherwise
 *  · "Run now" CTA in the idle state — autonomous `POST /agents/:slug/run`
 *
 * Target path + progress bar from the JSX mock are intentionally
 * skipped: we don't have a `totalSteps` feed or a per-run "current
 * target" field yet. They'll light up the moment the executor
 * surfaces them; meanwhile decoration stays off.
 */
function ActiveAgentCard({
  slug,
  running,
  paused,
  stepLabel,
  note,
  displaySerif,
}: {
  slug: string;
  running: boolean;
  paused: boolean;
  stepLabel: string | null;
  note: string | null;
  displaySerif: boolean;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onOpen = () => useAppStore.getState().setActiveAgentSlug(slug);

  const onRunNow = useCallback(async () => {
    if (starting || running) return;
    setStarting(true);
    setError(null);
    try {
      await startAutonomousRun(slug);
    } catch (err) {
      setStarting(false);
      if (err instanceof ApiError) {
        if (err.status === 429) {
          setError("rate-limited · try again later");
        } else {
          setError(err.body.slice(0, 60) || `error ${err.status}`);
        }
      } else {
        setError("failed to start");
      }
    }
  }, [slug, running, starting]);

  useEffect(() => {
    if (!starting) return;
    if (running) {
      setStarting(false);
      return;
    }
    const id = window.setTimeout(() => setStarting(false), 20_000);
    return () => window.clearTimeout(id);
  }, [starting, running]);

  let statusLabel: string;
  if (starting) statusLabel = "starting";
  else if (running) statusLabel = "running";
  else if (paused) statusLabel = "paused";
  else statusLabel = "idle";
  const showRunNow = !running && !paused;
  const live = running || starting;

  return (
    <AgentPulse
      active={live}
      style={{
        background: "var(--il-slate)",
        border: "1px solid var(--il-border-soft)",
        borderLeft: `2px solid ${live ? "var(--il-blue)" : "var(--il-border)"}`,
        borderRadius: 4,
        padding: "14px 16px",
      }}
    >
      <div className="flex w-full items-baseline gap-3">
        <button
          type="button"
          onClick={onOpen}
          className="flex flex-1 items-baseline gap-3 text-left outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
          style={{ background: "transparent", border: "none", cursor: "pointer", minWidth: 0 }}
          aria-label={`Open ${slug} detail page`}
        >
          <Reuleaux
            size={9}
            color={live ? "var(--il-blue)" : paused ? "var(--il-amber)" : "var(--il-text3)"}
            spin={live}
          />
          {/* Serif-italic subject in display-variant, Inter 600 in
           *  safe — matches screen-home.jsx AgentRunCard + the
           *  §Typography "serif-italic name + mono meta + inter
           *  sentence" triad. */}
          <span
            className="truncate"
            style={
              displaySerif
                ? {
                    fontFamily: "var(--font-serif)",
                    fontSize: 20,
                    fontWeight: 400,
                    fontStyle: "italic",
                    letterSpacing: "-0.01em",
                    lineHeight: 1.15,
                    color: "var(--il-text)",
                  }
                : {
                    fontFamily: "var(--font-sans)",
                    fontSize: 14,
                    fontWeight: 600,
                    letterSpacing: "-0.01em",
                    color: "var(--il-text)",
                  }
            }
          >
            {slug}
          </span>
          <span
            className="font-mono uppercase"
            style={{
              fontSize: 10.5,
              color: live ? "var(--il-blue)" : paused ? "var(--il-amber)" : "var(--il-text3)",
              letterSpacing: "0.06em",
            }}
          >
            {statusLabel}
          </span>
          <span style={{ flex: 1 }} />
          <Meta k="step" v={stepLabel ?? "—"} color={live ? "var(--il-blue)" : "var(--il-text3)"} />
        </button>

        {showRunNow && (
          <button
            type="button"
            onClick={onRunNow}
            disabled={starting}
            className="flex shrink-0 items-center gap-1.5 rounded-sm px-2 py-0.75 text-xs outline-none hover:bg-ironlore-slate-hover focus-visible:ring-1 focus-visible:ring-ironlore-blue/50 disabled:opacity-50"
            style={{
              background: "var(--il-slate-elev)",
              border: "1px solid var(--il-border-soft)",
              color: "var(--il-text)",
              cursor: starting ? "progress" : "pointer",
            }}
            aria-label={`Run ${slug} now`}
            title="Start an autonomous run for this agent"
          >
            <span
              className="font-mono uppercase"
              style={{
                fontSize: 10.5,
                letterSpacing: "0.04em",
                color: starting ? "var(--il-text3)" : "var(--il-text2)",
              }}
            >
              {starting ? "starting…" : "run now"}
            </span>
            {!starting && <Key>⌘R</Key>}
          </button>
        )}
      </div>

      {/* Action line — always renders per screen-home.jsx
       *  AgentRunCard (every card shows one sentence of context).
       *    · Live run + note → Inter 12.5 text2, the run's current
       *      note verbatim.
       *    · Idle + note → mono uppercase `last · <note>` so the user
       *      can see what the agent was last up to.
       *    · Idle + no runs yet → `no recent activity`.
       *    · Paused → `paused`. */}
      <div
        className={live && note ? "truncate" : "font-mono truncate"}
        style={
          live && note
            ? { marginTop: 6, fontSize: 12.5, color: "var(--il-text2)" }
            : {
                marginTop: 6,
                fontSize: 10.5,
                color: "var(--il-text3)",
                letterSpacing: "0.02em",
                textTransform: "uppercase",
              }
        }
      >
        {live && note
          ? note
          : paused
            ? "paused"
            : note
              ? `last · ${note}`
              : "no recent activity"}
      </div>

      {error && (
        <div
          className="font-mono"
          style={{
            marginTop: 6,
            fontSize: 10.5,
            color: "var(--il-red)",
            letterSpacing: "0.02em",
          }}
        >
          {error}
        </div>
      )}
    </AgentPulse>
  );
}

/**
 * Compact 24-bar histogram aggregated across every installed agent
 * plus a dashed cap line at the per-hour ceiling. Fetches each
 * agent's histogram in parallel (small N — personas directory is
 * tens at most) and sums the buckets.
 */
function RunRateHeadroom({
  agents,
  displaySerif,
}: {
  agents: ReturnType<typeof useWorkspaceActivity>["agents"];
  displaySerif: boolean;
}) {
  const [series, setSeries] = useState<AgentHistogramResponse[] | null>(null);

  const slugs = useMemo(() => agents.map((a) => a.slug).sort(), [agents]);
  const slugsKey = slugs.join("|");

  // biome-ignore lint/correctness/useExhaustiveDependencies: slugsKey captures the only dependency that matters — refetching on every `slugs` reference change would negate the memoization.
  useEffect(() => {
    let cancelled = false;
    if (slugs.length === 0) {
      setSeries([]);
      return;
    }
    // 48 h buckets so we can split them into "current 24 h" + "prior
    //  24 h" and compute a real day-over-day delta for the trend line
    //  per screen-home.jsx `↗ 18% vs. prior day`.
    Promise.all(slugs.map((slug) => fetchAgentHistogram(slug, 48).catch(() => null))).then(
      (rows) => {
        if (cancelled) return;
        setSeries(rows.filter((r): r is AgentHistogramResponse => r !== null));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [slugsKey]);

  if (series === null) return <LoadingRow />;
  if (series.length === 0) return <EmptyCard>No activity data yet.</EmptyCard>;

  // Sum 48 buckets across every agent. The most recent 24 are the
  //  current window the viz paints; the older 24 drive the trend line.
  const totalBuckets = 48;
  const allBuckets = new Array<number>(totalBuckets).fill(0);
  let capPerDay = 0;
  let capPerHour = 0;
  for (const s of series) {
    capPerDay += s.cap.perDay;
    capPerHour = Math.max(capPerHour, s.cap.perHour);
    const offset = totalBuckets - s.buckets.length;
    for (let i = 0; i < s.buckets.length; i++) {
      const dst = i + offset;
      if (dst >= 0 && dst < totalBuckets) {
        allBuckets[dst] = (allBuckets[dst] ?? 0) + (s.buckets[i] ?? 0);
      }
    }
  }
  const priorBuckets = allBuckets.slice(0, 24);
  const buckets = allBuckets.slice(24);
  const total24h = buckets.reduce((a, b) => a + b, 0);
  const prior24h = priorBuckets.reduce((a, b) => a + b, 0);
  const headroom = Math.max(0, capPerDay - total24h);
  const maxValue = Math.max(capPerHour, ...buckets, 1);
  const capRatio = capPerHour > 0 ? capPerHour / maxValue : 1;

  // Trend = (current - prior) / prior. When prior is 0 we skip the
  //  delta entirely rather than rendering an infinite "↗ ∞%" arrow —
  //  no prior activity means no comparison surface to make.
  const trend = computeTrend(total24h, prior24h);

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 16,
          marginBottom: 14,
        }}
      >
        {/* DisplayNum — Instrument Serif 44 safe / 64 italic display,
         *  per screen-home.jsx. Tabular figures so a count change
         *  doesn't nudge the surrounding meta. */}
        <DisplayNum size={displaySerif ? 64 : 44} serif italic={displaySerif}>
          {total24h}
        </DisplayNum>
        <div>
          <div
            className="font-mono uppercase"
            style={{ fontSize: 10.5, color: "var(--il-text3)", letterSpacing: "0.06em" }}
          >
            runs / 24h
          </div>
          {trend ? (
            <div style={{ fontSize: 12, color: "var(--il-text2)", marginTop: 2 }}>
              <span
                style={{
                  color: trend.direction === "down" ? "var(--il-red)" : "var(--il-green)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {trend.direction === "down" ? "↘" : "↗"} {trend.pctLabel}
              </span>{" "}
              vs. prior day
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "var(--il-text2)", marginTop: 2 }}>
              across {series.length} {series.length === 1 ? "agent" : "agents"}
            </div>
          )}
        </div>
        <span style={{ flex: 1 }} />
        <div style={{ textAlign: "right" }}>
          <div
            className="font-mono uppercase"
            style={{ fontSize: 10.5, color: "var(--il-text3)", letterSpacing: "0.06em" }}
          >
            headroom
          </div>
          <div
            style={{
              fontSize: 12,
              color: headroom > 0 ? "var(--il-amber)" : "var(--il-red)",
              marginTop: 2,
            }}
          >
            {headroom} / day remaining
          </div>
        </div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 2,
          height: 72,
          padding: "0 2px",
          borderBottom: "1px dashed var(--il-border)",
          position: "relative",
        }}
      >
        {buckets.map((v, i) => {
          const h = (v / maxValue) * 100;
          const warn = capPerHour > 0 && v >= capPerHour * 0.75;
          const recent = i >= 20;
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: stable hour slot
              key={i}
              style={{
                flex: 1,
                height: `${Math.max(h, v > 0 ? 3 : 0)}%`,
                background: warn ? "var(--il-amber)" : "var(--il-blue)",
                opacity: recent ? 1 : 0.55,
                boxShadow: recent ? "0 0 8px var(--il-blue-glow)" : "none",
                borderRadius: 1,
                minHeight: v > 0 ? 1 : 0,
              }}
            />
          );
        })}
        {capPerHour > 0 && (
          <>
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: `${capRatio * 100}%`,
                borderTop: "1px dashed var(--il-amber)",
                opacity: 0.5,
              }}
            />
            <span
              className="font-mono uppercase"
              style={{
                position: "absolute",
                right: 0,
                bottom: `calc(${capRatio * 100}% + 2px)`,
                fontSize: 10.5,
                color: "var(--il-amber)",
                letterSpacing: "0.04em",
              }}
            >
              cap · {capPerHour}/h
            </span>
          </>
        )}
      </div>
      {/* Axis ticks — absolute local time per screen-home.jsx
       *  (`00:00 · 06:00 · 12:00 · 18:00 · NOW`). Computed from the
       *  current clock so the rail always reads "where are we today,"
       *  regardless of when the user opens the app. */}
      <div
        className="font-mono"
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 6,
          fontSize: 10.5,
          color: "var(--il-text4)",
          letterSpacing: "0.06em",
        }}
      >
        {absoluteAxisTicks().map((tick) => (
          <span key={tick}>{tick}</span>
        ))}
      </div>
    </div>
  );
}

/**
 * Trend between the current 24 h window and the prior 24 h window.
 * Returns null when the prior window is empty — an infinite-growth
 * arrow would be useless signal.
 */
function computeTrend(
  current: number,
  prior: number,
): { direction: "up" | "down"; pctLabel: string } | null {
  if (prior <= 0) return null;
  const delta = (current - prior) / prior;
  const direction: "up" | "down" = delta >= 0 ? "up" : "down";
  const pct = Math.round(Math.abs(delta) * 100);
  return { direction, pctLabel: `${pct}%` };
}

/**
 * Axis labels for the 24-bar histogram: four evenly spaced absolute
 * hour marks + a "NOW" anchor at the right. Mirrors the design
 * handoff's `00:00 · 06:00 · 12:00 · 18:00 · NOW`; we pick the four
 * ticks from the current local time so they walk back 24 h and land
 * on whole hours.
 */
function absoluteAxisTicks(): string[] {
  const now = new Date();
  const ticks: string[] = [];
  const hoursBack = [24, 18, 12, 6];
  for (const back of hoursBack) {
    const d = new Date(now.getTime() - back * 3_600_000);
    const h = String(d.getHours()).padStart(2, "0");
    ticks.push(`${h}:00`);
  }
  ticks.push("NOW");
  return ticks;
}

/**
 * RecentCard — matches `screen-home.jsx` shape:
 *  · Mono uppercase folder overline (muted).
 *  · Inter 500 name, weighted down from the greeting.
 *  · Single mono footer line: `{time} ago · {author}`. Author renders
 *    Ironlore-Blue when it isn't "you" — a hand-off cue that the
 *    edit came from an agent, not the user.
 *
 * Blocks-count from the JSX mock is dropped; the server's
 * `recent_edits` table doesn't store it and synthesising it per row
 * would be decoration.
 */
function RecentCard({
  entry,
  displaySerif,
}: {
  entry: RecentEdit;
  displaySerif: boolean;
}) {
  const { path } = entry;
  const name = path.split("/").pop() ?? path;
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const when = useRelativeTime(entry.updatedAt);
  const author = entry.author;
  const isSelf = !author || author === "you";

  return (
    <button
      type="button"
      onClick={() => useAppStore.getState().setActivePath(path)}
      className="text-left outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
      style={{
        padding: "12px 14px",
        background: "var(--il-slate)",
        border: "1px solid var(--il-border-soft)",
        borderRadius: 3,
        cursor: "pointer",
        minWidth: 0,
      }}
    >
      {folder && (
        <div
          className="font-mono uppercase truncate"
          style={{
            fontSize: 10.5,
            color: "var(--il-text4)",
            letterSpacing: "0.04em",
            marginBottom: 4,
          }}
        >
          {folder}/
        </div>
      )}
      {/* Title — serif 18/400 in display mode, Inter 13.5/500 in safe
       *  mode per screen-home.jsx RecentCard. */}
      <div
        className="truncate"
        style={
          displaySerif
            ? {
                fontFamily: "var(--font-serif)",
                fontSize: 18,
                fontWeight: 400,
                lineHeight: 1.2,
                color: "var(--il-text)",
              }
            : {
                fontFamily: "var(--font-sans)",
                fontSize: 13.5,
                fontWeight: 500,
                lineHeight: 1.2,
                color: "var(--il-text)",
              }
        }
      >
        {name}
      </div>
      <div
        className="font-mono truncate"
        style={{
          display: "flex",
          gap: 10,
          marginTop: 8,
          fontSize: 10.5,
          color: "var(--il-text3)",
          letterSpacing: "0.02em",
        }}
      >
        <span>{when}</span>
        <span style={{ color: "var(--il-text4)" }}>·</span>
        <span style={{ color: isSelf ? "var(--il-text2)" : "var(--il-blue)" }}>
          {isSelf ? "you" : author}
        </span>
      </div>
    </button>
  );
}

interface QuickActionProps {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  onClick: () => void;
}

function QuickAction({ icon, label, shortcut, onClick }: QuickActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-3 text-left outline-none hover:bg-ironlore-slate-hover focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
      style={{
        padding: "9px 12px",
        background: "var(--il-slate)",
        border: "1px solid var(--il-border-soft)",
        borderRadius: 3,
        cursor: "pointer",
      }}
    >
      <span style={{ color: "var(--il-text2)" }}>{icon}</span>
      <span style={{ flex: 1, fontSize: 13, color: "var(--il-text)" }}>{label}</span>
      {shortcut && <Key>{shortcut}</Key>}
    </button>
  );
}

// ───────────── helpers ─────────────

function useGreeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Still up?";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * Hero overline text — `Weekday · DD Month · HH:MM`, matching
 * screen-home.jsx's `Tuesday · 17 April · 09:24`. Re-renders on a
 * 60 s tick so the clock stays roughly honest without noise.
 */
function useTodayLabel(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const dateHalf = now.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${dateHalf} · ${hh}:${mm}`;
}

/**
 * Render a relative timestamp ("2m ago", "1h ago", "3d ago"). Returns
 * the raw date when it's older than 7 days so the surface doesn't drown
 * the user in "97d ago"-style noise.
 */
function useRelativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const diffMs = Date.now() - then;
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
