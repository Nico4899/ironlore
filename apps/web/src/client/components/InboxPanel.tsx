import { Check, GitBranch, Inbox, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  approveInboxEntry,
  fetchInbox,
  fetchInboxFiles,
  type InboxFileDiff,
  rejectInboxEntry,
  setInboxFileDecision,
} from "../lib/api.js";
import { useAppStore } from "../stores/app.js";
import { Key, Reuleaux, Venn } from "./primitives/index.js";

interface InboxEntry {
  id: string;
  agentSlug: string;
  branch: string;
  jobId: string;
  filesChanged: string[];
  finalizedAt: number;
  status: string;
}

/**
 * Agent Inbox panel — batch review UI for inbox-mode agent runs.
 *
 * Keyboard-first per docs/09-ui-and-brand.md §Agent Inbox:
 *   · `j`/`k` (or ↑↓) move focus between entries
 *   · `a` approves the focused entry, `r` rejects
 *   · `⇧A` approve-all, `⇧R` reject-all
 *   · `Enter` opens provenance for the first file changed
 *
 * Bulk operations fan out the per-entry endpoints serially so one
 * failure doesn't cascade and partially-applied state is still
 * observable in the list.
 */
export function InboxPanel({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<InboxEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [focusIdx, setFocusIdx] = useState(0);
  const [busy, setBusy] = useState(false);

  /**
   * Per-entry diff stats keyed by entry id. Populated lazily once
   * the entry list lands — one git call per entry. Failure to compute
   * for an individual entry surfaces as "no diff data" on that row
   * rather than tanking the whole panel.
   */
  const [fileStats, setFileStats] = useState<Map<string, InboxFileDiff[] | "error">>(
    () => new Map(),
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { entries: e } = await fetchInbox();
      setEntries(e);
    } catch {
      // Network error — leave empty
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Fan out the diff-stats fetches once the entry list changes. Each
  //  entry's stats cache until entries change identity; we only fetch
  //  for ids we haven't seen yet.
  useEffect(() => {
    if (entries.length === 0) return;
    let cancelled = false;
    for (const entry of entries) {
      if (fileStats.has(entry.id)) continue;
      fetchInboxFiles(entry.id)
        .then((files) => {
          if (cancelled) return;
          setFileStats((prev) => {
            const next = new Map(prev);
            next.set(entry.id, files);
            return next;
          });
        })
        .catch(() => {
          if (cancelled) return;
          setFileStats((prev) => {
            const next = new Map(prev);
            next.set(entry.id, "error");
            return next;
          });
        });
    }
    return () => {
      cancelled = true;
    };
  }, [entries, fileStats]);

  // Keep focus in range when entries shrink after approve/reject.
  useEffect(() => {
    if (entries.length === 0) {
      setFocusIdx(0);
    } else if (focusIdx >= entries.length) {
      setFocusIdx(entries.length - 1);
    }
  }, [entries.length, focusIdx]);

  const handleApprove = useCallback(async (id: string) => {
    const result = await approveInboxEntry(id);
    if (result.success) {
      setEntries((prev) => prev.filter((e) => e.id !== id));
    }
  }, []);

  const handleReject = useCallback(async (id: string) => {
    const result = await rejectInboxEntry(id);
    if (result.success) {
      setEntries((prev) => prev.filter((e) => e.id !== id));
    }
  }, []);

  /**
   * Per-file decision toggle. Optimistically updates the local stats
   * cache so the button flip is instant; rolls back on server error.
   * The new `approveInboxEntry` call honors these decisions — rejected
   * files are skipped during the cherry-pick path.
   */
  const handleFileDecision = useCallback(
    async (entryId: string, path: string, decision: "approved" | "rejected" | null) => {
      let prevDecision: "approved" | "rejected" | null = null;
      setFileStats((prev) => {
        const current = prev.get(entryId);
        if (!Array.isArray(current)) return prev;
        const next = new Map(prev);
        next.set(
          entryId,
          current.map((f) => {
            if (f.path !== path) return f;
            prevDecision = f.decision;
            return { ...f, decision };
          }),
        );
        return next;
      });
      try {
        const result = await setInboxFileDecision(entryId, path, decision);
        if (!result.success) throw new Error(result.error ?? "Decision failed");
      } catch {
        // Roll back the optimistic update on failure.
        setFileStats((prev) => {
          const current = prev.get(entryId);
          if (!Array.isArray(current)) return prev;
          const next = new Map(prev);
          next.set(
            entryId,
            current.map((f) => (f.path === path ? { ...f, decision: prevDecision } : f)),
          );
          return next;
        });
      }
    },
    [],
  );

  const handleApproveAll = useCallback(async () => {
    if (busy || entries.length === 0) return;
    setBusy(true);
    // Snapshot ids — entries is filtered as each resolves.
    const ids = entries.map((e) => e.id);
    for (const id of ids) {
      try {
        await handleApprove(id);
      } catch {
        // Stop on first error so the user can inspect what's left.
        break;
      }
    }
    setBusy(false);
  }, [busy, entries, handleApprove]);

  const handleRejectAll = useCallback(async () => {
    if (busy || entries.length === 0) return;
    setBusy(true);
    const ids = entries.map((e) => e.id);
    for (const id of ids) {
      try {
        await handleReject(id);
      } catch {
        break;
      }
    }
    setBusy(false);
  }, [busy, entries, handleReject]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip when the user is typing into any input/textarea/contenteditable.
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable) return;
      }
      if (entries.length === 0) return;
      const entry = entries[focusIdx];
      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          setFocusIdx((i) => Math.min(i + 1, entries.length - 1));
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          setFocusIdx((i) => Math.max(i - 1, 0));
          break;
        case "A":
          // Capital A only (user must hold Shift) — approve-all.
          e.preventDefault();
          handleApproveAll();
          break;
        case "R":
          e.preventDefault();
          handleRejectAll();
          break;
        case "a":
          if (entry) {
            e.preventDefault();
            handleApprove(entry.id);
          }
          break;
        case "r":
          if (entry) {
            e.preventDefault();
            handleReject(entry.id);
          }
          break;
        case "Enter": {
          const file = entry?.filesChanged[0];
          if (file) {
            e.preventDefault();
            useAppStore.getState().openProvenance(file, "");
          }
          break;
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [entries, focusIdx, handleApprove, handleReject, handleApproveAll, handleRejectAll]);

  const paddedCount = String(entries.length).padStart(2, "0");

  return (
    <div className="flex h-full w-80 flex-col border-l border-border bg-ironlore-slate">
      {/*
       * Header — canvas-grammar per docs/09-ui-and-brand.md §Agent
       * Inbox. Mono uppercase overline `"<NN> pending"` sits above an
       * Inter h1, followed by a keyboard-hint row. The close X and
       * Inbox icon live at the top so mouse users still have one-click
       * dismissal.
       */}
      <header className="border-b border-border px-3 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5 text-secondary">
            <Inbox className="h-3.5 w-3.5" aria-hidden="true" />
          </div>
          <button
            type="button"
            className="rounded p-1 text-secondary hover:bg-ironlore-slate-hover"
            onClick={onClose}
            aria-label="Close inbox"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div
          className="mt-1 font-mono uppercase"
          style={{
            fontSize: 10.5,
            letterSpacing: "0.08em",
            color: "var(--il-text3)",
          }}
        >
          {paddedCount} pending
        </div>
        <h1
          className="mt-0.5"
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 18,
            fontWeight: 600,
            letterSpacing: "-0.02em",
            color: "var(--il-text)",
            margin: 0,
          }}
        >
          Agent Inbox
        </h1>
        {!loading && entries.length > 0 && (
          <div
            className="mt-3 flex flex-wrap gap-x-3 gap-y-1 font-mono uppercase"
            style={{
              fontSize: 10,
              letterSpacing: "0.04em",
              color: "var(--il-text3)",
            }}
          >
            <span>
              <Key>j</Key>/<Key>k</Key> navigate
            </span>
            <span>
              <Key>a</Key> approve
            </span>
            <span>
              <Key>r</Key> reject
            </span>
            <span>
              <Key>⇧A</Key> approve all
            </span>
          </div>
        )}
      </header>

      <section className="flex-1 overflow-y-auto p-3" aria-label="Pending inbox entries">
        {!loading && entries.length > 1 && (
          <div className="mb-3 flex items-center gap-2">
            <button
              type="button"
              onClick={handleRejectAll}
              disabled={busy}
              className="flex-1 rounded border border-border bg-transparent px-2 py-1 text-[11px] font-medium text-secondary hover:bg-ironlore-slate-hover disabled:opacity-40"
            >
              Reject all
            </button>
            <button
              type="button"
              onClick={handleApproveAll}
              disabled={busy}
              className="flex-1 rounded border-none bg-ironlore-blue px-2 py-1 text-[11px] font-medium text-background hover:bg-ironlore-blue-strong disabled:opacity-40"
              style={{ boxShadow: "0 0 10px var(--il-blue-glow)" }}
            >
              Approve all
            </button>
          </div>
        )}

        {loading && <div className="py-8 text-center text-xs text-secondary">Loading...</div>}

        {!loading && entries.length === 0 && <InboxEmptyState />}

        {entries.map((entry, idx) => {
          const focused = idx === focusIdx;
          return (
            <div
              key={entry.id}
              id={`inbox-entry-${entry.id}`}
              aria-current={focused ? "true" : undefined}
              className={`mb-2 rounded-lg border p-3 text-xs transition-colors ${
                focused
                  ? "border-ironlore-blue/60 bg-ironlore-blue/10"
                  : "border-border bg-ironlore-slate-hover/50"
              }`}
            >
              <div className="flex items-center gap-2">
                <Reuleaux size={9} color="var(--il-amber)" aria-label="Pending review" />
                <GitBranch className="h-3.5 w-3.5 text-accent-violet" />
                <span className="font-semibold text-primary">{entry.agentSlug}</span>
                <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-tertiary">
                  {new Date(entry.finalizedAt).toLocaleDateString()}
                </span>
              </div>

              <div className="mt-1.5 text-secondary">
                {entry.filesChanged.length} file
                {entry.filesChanged.length === 1 ? "" : "s"} changed
              </div>

              <InboxEntryFiles
                entry={entry}
                stats={fileStats.get(entry.id)}
                onDecisionChange={(path, decision) => handleFileDecision(entry.id, path, decision)}
              />

              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleApprove(entry.id);
                  }}
                  className="flex items-center gap-1 rounded border border-signal-green/30 bg-signal-green/10 px-2 py-1 text-signal-green hover:bg-signal-green/20"
                >
                  <Check className="h-3 w-3" />
                  Approve <Key style={{ fontSize: 9 }}>a</Key>
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleReject(entry.id);
                  }}
                  className="flex items-center gap-1 rounded border border-signal-red/30 bg-signal-red/10 px-2 py-1 text-signal-red hover:bg-signal-red/20"
                >
                  <X className="h-3 w-3" />
                  Reject <Key style={{ fontSize: 9 }}>r</Key>
                </button>
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}

function InboxEmptyState() {
  return (
    <div className="relative mt-10 flex flex-col items-center gap-4 px-6 text-center">
      <div aria-hidden="true" style={{ opacity: 0.55 }}>
        <Venn
          size={80}
          color="var(--il-text4)"
          lineWidth={0.7}
          ringOpacity={0.7}
          fillOpacity={0.35}
        />
      </div>
      <div
        className="font-mono uppercase"
        style={{
          fontSize: 10,
          letterSpacing: "0.08em",
          color: "var(--il-text3)",
        }}
      >
        inbox · zero
      </div>
      <p className="text-xs text-secondary">
        No pending reviews. Runs with{" "}
        <code className="rounded bg-ironlore-slate-hover px-1">review_mode: inbox</code> will appear
        here.
      </p>
    </div>
  );
}

/**
 * Per-file diff rows for an inbox entry — `A/D/M  path  +N -M` per
 * docs/09-ui-and-brand.md §Agent Inbox. Falls back to the plain
 * filename list when git stats aren't available yet (loading / error
 * / fell off the branch) so the row never goes empty.
 */
function InboxEntryFiles({
  entry,
  stats,
  onDecisionChange,
}: {
  entry: InboxEntry;
  stats: InboxFileDiff[] | "error" | undefined;
  onDecisionChange: (path: string, decision: "approved" | "rejected" | null) => void;
}) {
  // While we're fetching or the endpoint failed, degrade to the plain
  //  filename list. Never block the entry from rendering on this.
  if (stats === undefined || stats === "error" || stats.length === 0) {
    return (
      <ul className="mt-1 max-h-20 overflow-y-auto text-[10px] text-secondary">
        {entry.filesChanged.map((f) => (
          <li key={f} className="truncate font-mono">
            {f}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <ul className="mt-1 max-h-32 overflow-y-auto">
      {stats.map((f) => {
        const isApproved = f.decision === "approved";
        const isRejected = f.decision === "rejected";
        // Toggle semantics: clicking an already-set decision clears
        //  it (back to default-accept). Keeps the button pair
        //  single-ended without needing a separate "clear" control.
        const toggle = (next: "approved" | "rejected") => {
          onDecisionChange(f.path, f.decision === next ? null : next);
        };
        return (
          <li
            key={f.path}
            className="grid items-center gap-1.5 py-0.5"
            style={{
              gridTemplateColumns: "12px minmax(0, 1fr) auto auto",
              fontSize: 10,
              background: isApproved
                ? "color-mix(in oklch, var(--il-green) 10%, transparent)"
                : isRejected
                  ? "color-mix(in oklch, var(--il-red) 10%, transparent)"
                  : "transparent",
              opacity: isRejected ? 0.65 : 1,
              paddingLeft: 2,
              paddingRight: 2,
              borderRadius: 2,
            }}
            title={f.path}
          >
            <span
              className="font-mono uppercase"
              style={{
                letterSpacing: "0.06em",
                fontWeight: 600,
                color: statusColor(f.status),
              }}
            >
              {f.status}
            </span>
            <span
              className="truncate font-mono"
              style={{
                color: "var(--il-text2)",
                textDecoration: isRejected ? "line-through" : undefined,
              }}
            >
              {f.path}
            </span>
            <span className="font-mono" style={{ color: "var(--il-text4)" }}>
              {formatDelta(f)}
            </span>
            <span className="flex gap-1">
              <FileDecisionButton
                kind="rejected"
                active={isRejected}
                onClick={() => toggle("rejected")}
              />
              <FileDecisionButton
                kind="approved"
                active={isApproved}
                onClick={() => toggle("approved")}
              />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Per-file ✓/✗ pill. The active state uses a solid fill; idle is
 * outlined. Matches the canvas's miniBtn pattern — small, quiet,
 * sits at the right edge of the file row.
 */
function FileDecisionButton({
  kind,
  active,
  onClick,
}: {
  kind: "approved" | "rejected";
  active: boolean;
  onClick: () => void;
}) {
  const color = kind === "approved" ? "var(--il-green)" : "var(--il-red)";
  const glyph = kind === "approved" ? "✓" : "✗";
  const label = kind === "approved" ? "Approve this file" : "Reject this file";
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{
        width: 16,
        height: 14,
        padding: 0,
        fontSize: 9,
        lineHeight: 1,
        background: active ? color : "transparent",
        color: active ? "var(--il-bg)" : color,
        border: `1px solid ${active ? color : "var(--il-border)"}`,
        borderRadius: 2,
        cursor: "pointer",
      }}
    >
      {glyph}
    </button>
  );
}

function statusColor(status: InboxFileDiff["status"]): string {
  switch (status) {
    case "A":
      return "var(--il-green)";
    case "D":
      return "var(--il-red)";
    case "M":
    case "R":
      return "var(--il-blue)";
    default:
      return "var(--il-text3)";
  }
}

/**
 * Compact delta label — `+3 -2`, `+24`, `-8`, or `bin` for binary
 * files (git reports `-` for both counts when the diff is unreadable
 * as text). Zero-count columns drop out so the row stays short.
 */
function formatDelta(f: InboxFileDiff): string {
  if (f.added === null && f.removed === null) return "bin";
  const parts: string[] = [];
  if ((f.added ?? 0) > 0) parts.push(`+${f.added}`);
  if ((f.removed ?? 0) > 0) parts.push(`-${f.removed}`);
  return parts.length === 0 ? "·" : parts.join(" ");
}
