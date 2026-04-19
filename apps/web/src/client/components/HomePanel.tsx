import { FileText, FolderPlus, Inbox, Search, Sparkles } from "lucide-react";
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
import { AgentPulse, Key, Meta, Reuleaux, SectionLabel, Venn } from "./primitives/index.js";

/**
 * HomePanel — the canvas-grammar landing surface that replaces the
 * bare "Welcome to Ironlore" centered block.
 *
 * Per docs/09-ui-and-brand.md §Home grammar:
 *   · Mono overline with date + live-agent hint
 *   · Inter/display greeting (no fake persona — we don't know the user)
 *   · SectionLabel 01 Recent pages — real data from `fetchRecentEdits`
 *   · SectionLabel 02 Quick actions — keyboard-jumpable shortcuts
 *   · Dim Venn watermark behind the hero when the workspace is empty,
 *     so the canvas reads as a deliberate rest state rather than blank
 *
 * The grid sits in the default content area; callers render this any
 * time `activePath` is null on the Home tab.
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
  const isEmpty = recent !== null && recent.length === 0;
  const hasActivity = activity.runningCount > 0 || activity.inboxCount > 0;

  return (
    <div className="relative flex flex-1 flex-col overflow-y-auto">
      {/* Venn watermark for the empty workspace — sits behind content so
       *  it reads as contemplative rest, not decoration. */}
      {isEmpty && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute"
          style={{ top: "12%", right: "8%", opacity: 0.35 }}
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

      <div className="relative z-10 mx-auto w-full max-w-4xl px-8 py-10">
        {/* Hero — mono overline + Inter greeting */}
        <div
          className="flex items-center gap-2 font-mono uppercase"
          style={{
            fontSize: 10.5,
            letterSpacing: "0.08em",
            color: "var(--il-text3)",
            marginBottom: 10,
          }}
        >
          <Reuleaux
            size={8}
            color={activity.runningCount > 0 ? "var(--il-blue)" : "var(--il-text3)"}
            spin={activity.runningCount > 0}
          />
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
                  // Click the inline counter to open the Inbox panel —
                  //  same action as the Header pill. Lives inline in
                  //  the sentence so the mono overline keeps one
                  //  visual line; the underline appears only on hover
                  //  so the sentence reads as prose at rest.
                  <button
                    type="button"
                    onClick={() => useAppStore.getState().toggleInbox()}
                    className="il-hero-inbox-link inline-flex items-baseline gap-1 rounded-sm outline-none hover:underline focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
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
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 26,
            fontWeight: 600,
            letterSpacing: "-0.02em",
            color: "var(--il-text)",
            margin: 0,
          }}
        >
          {greeting}
        </h1>
        <p
          style={{
            marginTop: 6,
            fontSize: 14,
            color: "var(--il-text2)",
            maxWidth: 560,
            lineHeight: 1.5,
          }}
        >
          {isEmpty
            ? "No pages yet. Create one from the sidebar, drop files to upload, or let an agent seed the workspace."
            : "Pick up where you left off, or jump to a command."}
        </p>

        {/* Body grid — Active runs + Run-rate on top row, Recent +
         *  Quick actions on the second. Collapses to a single column
         *  under 880px so narrow windows stay readable. */}
        <div
          style={{
            marginTop: 28,
            display: "grid",
            gridTemplateColumns: "minmax(0, 1.3fr) minmax(0, 1fr)",
            gap: 32,
          }}
          className="il-home-grid"
        >
          {/* 01 — Active runs */}
          <div>
            <SectionLabel
              index={1}
              title="Active runs"
              meta={
                activity.runningCount > 0 ? `${activity.runningCount} RUNNING` : "NOTHING RUNNING"
              }
            />
            <div style={{ marginTop: 14 }}>
              {!activity.loaded ? (
                <div className="py-6 text-center text-xs text-secondary">Loading…</div>
              ) : activity.agents.length === 0 ? (
                <EmptyCard>
                  No agents installed. Drop a persona into <code>.agents/</code> to start.
                </EmptyCard>
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  {orderedForHome(activity.agents).map((a) => (
                    <ActiveAgentCard
                      key={a.slug}
                      slug={a.slug}
                      running={a.running}
                      paused={a.status === "paused"}
                      stepLabel={a.stepLabel}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 02 — Run-rate headroom */}
          <div>
            <SectionLabel index={2} title="Run-rate headroom" meta="ROLLING 24H" />
            <div style={{ marginTop: 14 }}>
              <RunRateHeadroom agents={activity.agents} />
            </div>
          </div>

          {/* 03 — Recent pages (full-width on the grid, spans both cols) */}
          <div style={{ gridColumn: "1 / -1", marginTop: 6 }}>
            <SectionLabel index={3} title="Recent pages" meta="LAST 7 DAYS" />
            {recent === null ? (
              <div className="py-6 text-center text-xs text-secondary">Loading…</div>
            ) : recent.length === 0 ? (
              <div
                className="rounded border py-8 text-center"
                style={{
                  borderColor: "var(--il-border-soft)",
                  borderStyle: "dashed",
                  color: "var(--il-text3)",
                  fontSize: 12.5,
                  marginTop: 14,
                }}
              >
                Nothing here yet.
              </div>
            ) : (
              <div
                className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
                style={{ marginTop: 14 }}
              >
                {recent.map((p) => (
                  <RecentCard key={p.path} entry={p} />
                ))}
              </div>
            )}
          </div>

          {/* 04 — Quick actions */}
          <div style={{ gridColumn: "1 / -1", marginTop: 6 }}>
            <SectionLabel index={4} title="Quick actions" meta="KEYBOARD" />
            <div
              className="grid gap-1.5"
              style={{ marginTop: 14, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}
            >
              <QuickAction
                icon={<FileText className="h-3.5 w-3.5" />}
                label="New page"
                hint="Open the sidebar and use the + button."
              />
              <QuickAction
                icon={<FolderPlus className="h-3.5 w-3.5" />}
                label="New folder"
                hint="Sidebar · New folder"
              />
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
                icon={<Inbox className="h-3.5 w-3.5" />}
                label="Agent inbox"
                hint="Pending agent runs"
                onClick={() => useAppStore.getState().toggleInbox()}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Sort active agents for the Home screen: running first, then
 * non-paused, then paused at the bottom. Within each group the order
 * follows the server's alphabetical list — deterministic across
 * renders, no churn on a poll.
 */
function orderedForHome(
  agents: ReturnType<typeof useWorkspaceActivity>["agents"],
): ReturnType<typeof useWorkspaceActivity>["agents"] {
  const rank = (a: (typeof agents)[number]) => (a.running ? 0 : a.status === "paused" ? 2 : 1);
  return [...agents].sort((a, b) => rank(a) - rank(b));
}

function EmptyCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded border py-6 text-center"
      style={{
        borderColor: "var(--il-border-soft)",
        borderStyle: "dashed",
        color: "var(--il-text3)",
        fontSize: 12.5,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Active-agent card matching the design-system AgentRunCard:
 *  · Reuleaux pip on the left (spinning when running)
 *  · Agent slug + status label
 *  · Mono "step N" tag on the right
 *  · Blue accent bar on the left rail while live
 *  · AgentPulse wrapping the row when running
 *  · "Run now" CTA in the idle state — posts autonomously so the user
 *    can start a scheduled agent without opening its detail page.
 *    Matches the §01 Active runs punch-list item from the UX review.
 */
function ActiveAgentCard({
  slug,
  running,
  paused,
  stepLabel,
}: {
  slug: string;
  running: boolean;
  paused: boolean;
  stepLabel: string | null;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onOpen = () => useAppStore.getState().setActiveAgentSlug(slug);

  // "Run now" — start an autonomous run. `starting` latches true from
  //  click to the first poll tick that surfaces this agent as running.
  //  If the poll doesn't flip within 20 s the latch auto-clears so a
  //  failed-to-enqueue run doesn't leave the button dead. Rate-limit
  //  errors (429) and forbidden states (403) surface inline; network
  //  or server errors also surface so the user sees why nothing
  //  happened.
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

  // Clear the latch once the poll reflects the new running state or
  //  after a 20 s watchdog.
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

  return (
    <AgentPulse
      active={running || starting}
      style={{
        background: "var(--il-slate)",
        border: "1px solid var(--il-border-soft)",
        borderLeft: `2px solid ${running || starting ? "var(--il-blue)" : "var(--il-border)"}`,
        borderRadius: 4,
        padding: "12px 14px",
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
            color={
              running || starting
                ? "var(--il-blue)"
                : paused
                  ? "var(--il-amber)"
                  : "var(--il-text3)"
            }
            spin={running || starting}
          />
          <span
            className="truncate"
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 13.5,
              fontWeight: 600,
              letterSpacing: "-0.01em",
              color: "var(--il-text)",
            }}
          >
            {slug}
          </span>
          <span
            className="font-mono uppercase"
            style={{
              fontSize: 10,
              color:
                running || starting
                  ? "var(--il-blue)"
                  : paused
                    ? "var(--il-amber)"
                    : "var(--il-text3)",
              letterSpacing: "0.06em",
            }}
          >
            {statusLabel}
          </span>
          <span style={{ flex: 1 }} />
          <Meta
            k="step"
            v={stepLabel ?? "—"}
            color={running || starting ? "var(--il-blue)" : "var(--il-text3)"}
          />
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
 * plus a dashed cap line at the combined `perDay` ceiling. Fetches
 * each agent's histogram in parallel (small N — personas directory is
 * tens at most) and sums the buckets.
 */
function RunRateHeadroom({
  agents,
}: {
  agents: ReturnType<typeof useWorkspaceActivity>["agents"];
}) {
  const [series, setSeries] = useState<AgentHistogramResponse[] | null>(null);

  // Stable slug list + primitive key. `agents` is a new array
  //  reference on every poll tick, so depending on it directly would
  //  refetch the histogram every 10s; we only want to refetch when
  //  the *set* of slugs actually changes.
  const slugs = useMemo(() => agents.map((a) => a.slug).sort(), [agents]);
  const slugsKey = slugs.join("|");

  // biome-ignore lint/correctness/useExhaustiveDependencies: slugsKey captures the only dependency that matters — refetching on every `slugs` reference change would negate the memoization.
  useEffect(() => {
    let cancelled = false;
    if (slugs.length === 0) {
      setSeries([]);
      return;
    }
    Promise.all(slugs.map((slug) => fetchAgentHistogram(slug).catch(() => null))).then((rows) => {
      if (cancelled) return;
      setSeries(rows.filter((r): r is AgentHistogramResponse => r !== null));
    });
    return () => {
      cancelled = true;
    };
  }, [slugsKey]);

  if (series === null) {
    return <div className="py-6 text-center text-xs text-secondary">Loading…</div>;
  }
  if (series.length === 0) {
    return <EmptyCard>No activity data yet.</EmptyCard>;
  }

  const bucketCount = 24;
  const buckets = new Array<number>(bucketCount).fill(0);
  let capPerDay = 0;
  let capPerHour = 0;
  for (const s of series) {
    capPerDay += s.cap.perDay;
    capPerHour = Math.max(capPerHour, s.cap.perHour);
    for (let i = 0; i < Math.min(bucketCount, s.buckets.length); i++) {
      buckets[i] = (buckets[i] ?? 0) + (s.buckets[i] ?? 0);
    }
  }
  const total24h = buckets.reduce((a, b) => a + b, 0);
  const headroom = Math.max(0, capPerDay - total24h);
  const maxValue = Math.max(capPerHour, ...buckets, 1);
  const capRatio = capPerHour > 0 ? capPerHour / maxValue : 1;

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
        <span
          style={{
            fontFamily: "var(--font-serif)",
            fontSize: 44,
            lineHeight: 0.9,
            letterSpacing: "-0.02em",
            fontVariantNumeric: "tabular-nums",
            color: "var(--il-text)",
          }}
        >
          {total24h}
        </span>
        <div>
          <div
            className="font-mono uppercase"
            style={{
              fontSize: 10.5,
              color: "var(--il-text3)",
              letterSpacing: "0.06em",
            }}
          >
            runs / 24h
          </div>
          <div style={{ fontSize: 12, color: "var(--il-text2)", marginTop: 2 }}>
            across {series.length} {series.length === 1 ? "agent" : "agents"}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <div style={{ textAlign: "right" }}>
          <div
            className="font-mono uppercase"
            style={{
              fontSize: 10.5,
              color: "var(--il-text3)",
              letterSpacing: "0.06em",
            }}
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
          height: 64,
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
                fontSize: 9.5,
                color: "var(--il-amber)",
                letterSpacing: "0.04em",
              }}
            >
              cap · {capPerHour}/h
            </span>
          </>
        )}
      </div>
      <div
        className="font-mono"
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 6,
          fontSize: 9.5,
          color: "var(--il-text4)",
          letterSpacing: "0.06em",
        }}
      >
        <span>−24h</span>
        <span>−18h</span>
        <span>−12h</span>
        <span>−6h</span>
        <span>NOW</span>
      </div>
    </div>
  );
}

function RecentCard({ entry }: { entry: RecentEdit }) {
  const { path } = entry;
  const name = path.split("/").pop() ?? path;
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const when = useRelativeTime(entry.updatedAt);
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
      }}
    >
      {folder && (
        <div
          className="font-mono uppercase"
          style={{
            fontSize: 10,
            color: "var(--il-text4)",
            letterSpacing: "0.04em",
            marginBottom: 4,
          }}
        >
          {folder}/
        </div>
      )}
      <div
        className="truncate"
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 13.5,
          fontWeight: 500,
          color: "var(--il-text)",
        }}
      >
        {name}
      </div>
      <div className="mt-2 flex items-baseline gap-3">
        <Meta k="edited" v={when} />
        {entry.author && entry.author !== "you" && (
          <Meta k="by" v={entry.author} color="var(--il-blue)" />
        )}
      </div>
    </button>
  );
}

interface QuickActionProps {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  hint?: string;
  onClick?: () => void;
}

function QuickAction({ icon, label, shortcut, hint, onClick }: QuickActionProps) {
  const interactive = typeof onClick === "function";
  const Wrap = interactive ? "button" : "div";
  return (
    <Wrap
      type={interactive ? "button" : undefined}
      onClick={onClick}
      className="flex items-center gap-3 text-left outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
      style={{
        padding: "9px 12px",
        background: "var(--il-slate)",
        border: "1px solid var(--il-border-soft)",
        borderRadius: 3,
        cursor: interactive ? "pointer" : "default",
      }}
    >
      <span style={{ color: "var(--il-text2)" }}>{icon}</span>
      <span style={{ flex: 1, fontSize: 13, color: "var(--il-text)" }}>{label}</span>
      {hint && !shortcut && (
        <span
          className="font-mono uppercase"
          style={{
            fontSize: 10,
            letterSpacing: "0.04em",
            color: "var(--il-text3)",
          }}
        >
          {hint}
        </span>
      )}
      {shortcut && <Key>{shortcut}</Key>}
    </Wrap>
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

function useTodayLabel(): string {
  const d = new Date();
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
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
