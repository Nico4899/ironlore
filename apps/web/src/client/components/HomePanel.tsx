import { useCallback, useEffect, useMemo, useState } from "react";
import { useWorkspaceActivity } from "../hooks/useWorkspaceActivity.js";
import {
  type AgentHistogramResponse,
  createPage,
  fetchAgentHistogram,
  fetchInbox,
  fetchPage,
  fetchRecentEdits,
  type RecentEdit,
} from "../lib/api.js";
import { useAppStore } from "../stores/app.js";
import { useAuthStore } from "../stores/auth.js";
import { AgentsCube } from "./AgentsCube.js";
import { DisplayNum, Key, Reuleaux, SectionLabel, Venn } from "./primitives/index.js";

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
  /**
   * Per-path block-count cache. Populated in parallel as each
   * recent entry lands — we read `PageResponse.blocks.length`
   * directly, so no extra parse on the client side. Values:
   *   · `number`      — count ready
   *   · `"err"`       — fetch failed (non-markdown, 404, etc.)
   *   · missing key   — still fetching
   */
  const [blockCounts, setBlockCounts] = useState<Map<string, number | "err">>(() => new Map());

  useEffect(() => {
    fetchRecentEdits(8)
      .then(setRecent)
      .catch(() => setRecent([]));
  }, []);

  // Kick off block-count fetches in parallel. Only markdown pages
  //  are candidates (pages API only reads `.md`); everything else
  //  records `"err"` immediately so the card doesn't render a stale
  //  "N blocks" line.
  useEffect(() => {
    if (!recent || recent.length === 0) return;
    let cancelled = false;
    for (const entry of recent) {
      if (blockCounts.has(entry.path)) continue;
      if (!entry.path.endsWith(".md")) {
        setBlockCounts((prev) => {
          const next = new Map(prev);
          next.set(entry.path, "err");
          return next;
        });
        continue;
      }
      fetchPage(entry.path)
        .then((page) => {
          if (cancelled) return;
          setBlockCounts((prev) => {
            const next = new Map(prev);
            next.set(entry.path, page.blocks.length);
            return next;
          });
        })
        .catch(() => {
          if (cancelled) return;
          setBlockCounts((prev) => {
            const next = new Map(prev);
            next.set(entry.path, "err");
            return next;
          });
        });
    }
    return () => {
      cancelled = true;
    };
  }, [recent, blockCounts]);

  const greeting = useGreeting();
  const today = useTodayLabel();
  const activity = useWorkspaceActivity();
  const typeDisplay = useAppStore((s) => s.typeDisplay);
  const displaySerif = typeDisplay === "serif";
  /**
   * First-name suffix for the greeting. Pulled from the auth store
   * and title-cased client-side (`"eli"` → `"Eli"`). Brand doc rule
   * §Home hero: "the greeting never names the user unless the store
   * has a name to show" — when `username` is null we suppress the
   * suffix silently.
   */
  const username = useAuthStore((s) => s.username);
  const greetingName = useMemo(() => (username ? titleCaseFirstWord(username) : null), [username]);

  /**
   * Every inbox entry visible to the user. We'll project this into
   * two different hero clauses: the single most-recent entry (for
   * the "Docs-curator finished this morning…" line when the inbox
   * surfaces pending work) and a 24-hour rollup (for the "in the
   * last 24 hours" line that replaces the old "pick up where you
   * left off" fallback when no work is live but something did
   * finish in the window).
   */
  const [inboxEntries, setInboxEntries] = useState<
    Array<{ agentSlug: string; filesChanged: string[]; finalizedAt: number }>
  >([]);
  useEffect(() => {
    let cancelled = false;
    fetchInbox()
      .then(({ entries }) => {
        if (cancelled) return;
        setInboxEntries(
          entries.map((e) => ({
            agentSlug: e.agentSlug,
            filesChanged: e.filesChanged,
            finalizedAt: e.finalizedAt,
          })),
        );
      })
      .catch(() => {
        /* no-op — drop both clauses on failure */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Single most-recent entry — drives the existing inbox sub-clause.
  //  fetchInbox returns entries descending by finalizedAt, so the
  //  head is the newest by definition.
  const lastCompleted = inboxEntries[0] ?? null;

  // 24-hour rollup — distinct agents + total files touched + total
  //  changes across all entries finalized in the last 24 h.
  //  Surfaces when there's no live activity but something recent
  //  happened; replaces the old "Pick up where you left off" copy.
  const rollup24h = useMemo(() => {
    const cutoff = Date.now() - 24 * 3_600_000;
    const recent = inboxEntries.filter((e) => e.finalizedAt >= cutoff);
    if (recent.length === 0) return null;
    const agents = Array.from(new Set(recent.map((e) => e.agentSlug)));
    const uniqueFiles = new Set<string>();
    let changes = 0;
    for (const e of recent) {
      for (const p of e.filesChanged) uniqueFiles.add(p);
      changes += e.filesChanged.length;
    }
    return { agents, changes, fileCount: uniqueFiles.size };
  }, [inboxEntries]);

  const hasActivity = activity.runningCount > 0 || activity.inboxCount > 0;
  // "Fresh project" — zero recent pages AND zero installed agents.
  //  This is the exact trigger for the Venn watermark (§Home in
  //  docs/09-ui-and-brand.md). On a fresh project §01 Active runs and
  //  §03 Run-rate headroom suppress so the canvas doesn't announce
  //  "nothing here" twice; the Venn + §02 Recent pages + §04 Quick
  //  actions carry the rest state together.
  const isFreshProject =
    recent !== null && recent.length === 0 && activity.loaded && activity.agents.length === 0;

  // Queued = everything that isn't running right now (idle active
  //  agents + paused ones). Paused state is still visible per-card
  //  via the amber pip, so the meta count stays truthful without
  //  double-counting.
  const queuedCount = activity.agents.filter((a) => !a.running).length;
  const activeRunsMeta = formatActiveRunsMeta(activity.runningCount, queuedCount);

  /**
   * Quick action — New page. Creates `untitled.md` (or
   * `untitled-N.md` if that name is taken) at the project root and
   * focuses it in the editor. Unlike the sidebar's context-menu
   * `New file` path, this lands from Home without the user having
   * to navigate into a folder first.
   */
  const handleNewPage = useCallback(async () => {
    const basePath = "untitled.md";
    // Pick a free filename — check the recent-edits list and the
    //  in-memory tree as best-effort deduplication. Worst case the
    //  server will 409 and we'll surface the error.
    let candidate = basePath;
    let n = 2;
    const taken = (path: string): boolean => (recent ?? []).some((r) => r.path === path);
    while (taken(candidate) && n < 100) {
      candidate = `untitled-${n}.md`;
      n++;
    }
    try {
      await createPage(candidate, "# Untitled\n\n");
      useAppStore.getState().setActivePath(candidate);
    } catch {
      // Non-fatal — no toast infra on Home yet; user will see the
      //  sidebar refresh via the file watcher either way.
    }
  }, [recent]);

  /**
   * Quick action — Run an agent. Opens the first idle installed
   * agent's detail page so the user can inspect controls + trigger
   * a run. When no agents exist the button disables itself upstream.
   * Open question answer: option (a) — route to detail page rather
   * than the AI panel, since the detail page carries the Run-now
   * control + the recent-runs context.
   */
  const handleRunAnAgent = useCallback(() => {
    const idle = activity.agents.find((a) => !a.running && a.status === "active");
    const target = idle ?? activity.agents[0];
    if (!target) return;
    useAppStore.getState().setActiveAgentSlug(target.slug);
  }, [activity.agents]);

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
      // Home sits on `--il-home-bg` — pure black in dark mode, pure
      //  white in light mode. Both extremes make the slate cards
      //  (`--il-slate`) elevate cleanly without competing with the
      //  shell's `--il-bg` elsewhere. The token flips automatically
      //  on theme toggle via globals.css.
      style={{ background: "var(--il-home-bg)" }}
    >
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
          {greetingName ? `, ${greetingName}` : ""}
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
                {activity.inboxCount === 1 ? "One run awaits" : `${activity.inboxCount} runs await`}{" "}
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
                {activity.runningCount === 1
                  ? "One agent is"
                  : `${activity.runningCount} agents are`}{" "}
                working. Pick up where you left off.
              </>
            ) : rollup24h ? (
              // No work is live right now, but something finished in
              //  the last 24 h — describe it. Templated from real
              //  inbox data, not an LLM call: the "intelligence" is
              //  in picking the right signal, not generating prose.
              <>
                In the last 24 hours, {formatAgentList(rollup24h.agents)} made {rollup24h.changes}{" "}
                {rollup24h.changes === 1 ? "change" : "changes"} across {rollup24h.fileCount}{" "}
                {rollup24h.fileCount === 1 ? "file" : "files"}.
              </>
            ) : (
              "Pick up where you left off."
            )}
            {/* Most-recent-completed-run trailing clause. Rendered
             *  whenever the inbox surfaces a finalized entry; the
             *  primary sentence above is about "what's live now",
             *  this sentence is "what just finished" — two distinct
             *  facts, so they compose cleanly. Suppressed on a
             *  fresh project since no agent has run yet. */}
            {!isFreshProject && lastCompleted && (
              <>
                {" "}
                <span style={{ color: "var(--il-text)" }}>
                  {titleCaseFirstWord(lastCompleted.agentSlug)}
                </span>{" "}
                finished {formatFinishedRelative(lastCompleted.finalizedAt)} with{" "}
                {lastCompleted.filesChanged.length}{" "}
                {lastCompleted.filesChanged.length === 1 ? "file" : "files"} awaiting review.
              </>
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
              {/* 3D agents cube — six clusters × four agent strips,
               *  drag-to-rotate navigation + edge-hover affordances.
               *  Per the design brief, every face's name and its 4
               *  cells stay visible at the same depth; empty slots
               *  render "New agent" placeholders sized identically
               *  to the agent strips so the cube grid is consistent.
               *  See [`AgentsCube.tsx`](./AgentsCube.tsx) for the
               *  rotation + drag mechanics. */}
              {!activity.loaded ? (
                <LoadingRow />
              ) : activity.agents.length === 0 ? (
                <EmptyCard>No agents installed yet.</EmptyCard>
              ) : (
                <AgentsCube />
              )}
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
                {recent.map((p) => {
                  const bc = blockCounts.get(p.path);
                  const blockCount = typeof bc === "number" ? bc : null;
                  return (
                    <RecentCard
                      key={p.path}
                      entry={p}
                      blockCount={blockCount}
                      displaySerif={displaySerif}
                    />
                  );
                })}
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
            {/* Quick actions — mono section-meta reads `↵-jumpable`
             *  per screen-home.jsx. Rows match the JSX spec exactly:
             *  New page / Run an agent / Open inbox / Search. Icons
             *  intentionally dropped — the JSX carries only labels,
             *  and a weak icon next to a self-explanatory verb is
             *  exactly the "prefer no icon over a weak icon" anti-
             *  pattern. */}
            <SectionLabel index={4} title="Quick actions" meta="⌘-JUMPABLE" />
            <div style={{ display: "grid", gap: 6 }}>
              <QuickAction label="New page" shortcut="⌘N" onClick={handleNewPage} />
              <QuickAction
                label="Run an agent"
                shortcut="⌘⇧R"
                disabled={activity.loaded && activity.agents.length === 0}
                onClick={handleRunAnAgent}
              />
              <QuickAction
                label="Open inbox"
                shortcut="⌘I"
                onClick={() => useAppStore.getState().openSidebarTab("inbox")}
              />
              <QuickAction
                label="Search everything"
                shortcut="⌘K"
                onClick={() => useAppStore.getState().toggleSearchDialog()}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

// `orderedForHome` retired alongside `ActiveAgentCard` — the cube
//  surface owns running/paused/idle ordering through the Reuleaux
//  pip on each strip; the Home column no longer renders the flat
//  card list that needed deterministic per-poll sorting.

/**
 * §01 section-meta formatter. Matches the JSX spec grammar
 * `N RUNNING · N QUEUED` — paused agents fold into the queued
 * count (they're "not running right now"), since per-card pip
 * colour already encodes the paused state. Avoids double-counting
 * while keeping the meta honest.
 */
function formatActiveRunsMeta(running: number, queued: number): string {
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} RUNNING`);
  if (queued > 0) parts.push(`${queued} QUEUED`);
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
       *  regardless of when the user opens the app. text3 not text4
       *  so the time labels are AA-readable.
       */}
      <div
        className="font-mono"
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 6,
          fontSize: 10.5,
          color: "var(--il-text3)",
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
  blockCount,
  displaySerif,
}: {
  entry: RecentEdit;
  /** Block count (fetched lazily in HomePanel) — null while loading or on error. */
  blockCount: number | null;
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
            // Folder path is real navigation context — bumped from
            // text4 → text3 so it clears WCAG AA contrast.
            color: "var(--il-text3)",
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
        {blockCount !== null && (
          <>
            <span style={{ color: "var(--il-text4)" }}>·</span>
            <span>{blockCount} blocks</span>
          </>
        )}
        <span style={{ color: "var(--il-text4)" }}>·</span>
        <span style={{ color: isSelf ? "var(--il-text2)" : "var(--il-blue)" }}>
          {isSelf ? "you" : author}
        </span>
      </div>
    </button>
  );
}

interface QuickActionProps {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
}

/**
 * Quick-action row — `[label] ... [⌘K]`. Icons intentionally dropped
 * per screen-home.jsx (labels are self-explanatory verbs; adding a
 * Lucide icon per row is the weak-icon anti-pattern).
 */
function QuickAction({ label, shortcut, disabled, onClick }: QuickActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-3 text-left outline-none hover:bg-ironlore-slate-hover focus-visible:ring-1 focus-visible:ring-ironlore-blue/50 disabled:cursor-not-allowed disabled:opacity-40"
      style={{
        padding: "9px 12px",
        background: "var(--il-slate)",
        border: "1px solid var(--il-border-soft)",
        borderRadius: 3,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <span style={{ flex: 1, fontSize: 13, color: "var(--il-text)" }}>{label}</span>
      {shortcut && <Key>{shortcut}</Key>}
    </button>
  );
}

// ───────────── helpers ─────────────

// `parseStepPct`, `deriveTargetLine`, and `extractPathToken`
//  retired alongside `ActiveAgentCard` — the cube's per-strip
//  Reuleaux pip + step label cover the visual signal those helpers
//  fed (live progress, target line, paused/idle text). Cube cells
//  don't render a progress bar today; if it lands later, parse can
//  come back from history.

/**
 * Render a list of agent slugs as prose:
 *   []              → "no agents"
 *   ["a"]           → "<code>a</code>"
 *   ["a", "b"]      → "<code>a</code> and <code>b</code>"
 *   ["a", "b", "c"] → "<code>a</code>, <code>b</code> and <code>c</code>"
 *
 * Slugs render with `--il-text` tint so they read as signal chips
 * inside the surrounding text2 sentence, matching the spec line
 * "agent X at time Y made N changes."
 */
function formatAgentList(agents: string[]): React.ReactNode {
  if (agents.length === 0) return "no agents";
  const styled = agents.map((a) => (
    <code
      key={a}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 12.5,
        color: "var(--il-text)",
        background: "transparent",
      }}
    >
      {a}
    </code>
  ));
  if (styled.length === 1) return styled[0];
  if (styled.length === 2) {
    return (
      <>
        {styled[0]} and {styled[1]}
      </>
    );
  }
  const head = styled.slice(0, -1);
  const tail = styled[styled.length - 1];
  return (
    <>
      {head.flatMap((el, i) => (i < head.length - 1 ? [el, ", "] : [el]))} and {tail}
    </>
  );
}

/**
 * Capitalize the first word of a slug-ish string. `"eli"` → `"Eli"`,
 * `"docs-curator"` → `"Docs-curator"`. We only touch the first
 * character so multi-word slugs keep their internal punctuation.
 */
function titleCaseFirstWord(raw: string): string {
  if (!raw) return raw;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * Relative-time shape tuned for the hero's "finished …" clause. We
 * prefer day-parts ("this morning", "this afternoon", "tonight",
 * "yesterday") over raw deltas because the hero copy should read
 * like prose, not a timestamp. Falls back to `<N> days ago` for
 * anything outside the last ~30 h. Never returns the empty string
 * so the caller can concatenate unconditionally.
 */
function formatFinishedRelative(ms: number): string {
  const now = Date.now();
  const diffMs = now - ms;
  // Under a minute — the run just ended.
  if (diffMs < 60_000) return "just now";
  // Under an hour — minutes granularity.
  if (diffMs < 3_600_000) {
    const m = Math.max(1, Math.floor(diffMs / 60_000));
    return `${m}m ago`;
  }

  const nowDate = new Date(now);
  const thenDate = new Date(ms);
  const sameDay =
    nowDate.getFullYear() === thenDate.getFullYear() &&
    nowDate.getMonth() === thenDate.getMonth() &&
    nowDate.getDate() === thenDate.getDate();

  if (sameDay) {
    const hour = thenDate.getHours();
    if (hour < 12) return "this morning";
    if (hour < 17) return "this afternoon";
    return "tonight";
  }

  // Check "yesterday" by calendar-day diff, not a 24h delta.
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  const isYesterday =
    y.getFullYear() === thenDate.getFullYear() &&
    y.getMonth() === thenDate.getMonth() &&
    y.getDate() === thenDate.getDate();
  if (isYesterday) return "yesterday";

  const days = Math.floor(diffMs / 86_400_000);
  return `${days}d ago`;
}

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
