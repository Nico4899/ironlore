import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  approveInboxEntry,
  fetchInbox,
  fetchInboxDiff,
  fetchInboxFiles,
  type InboxFileDiff,
  rejectInboxEntry,
  setInboxFileDecision,
} from "../lib/api.js";
import { formatRelative } from "../lib/relative-time.js";
import { useAppStore } from "../stores/app.js";
import { Key, Meta, Reuleaux, StatusPip, Venn } from "./primitives/index.js";

/**
 * Agent Inbox — batch review surface for inbox-mode agent runs.
 *
 * Per screen-more.jsx ScreenInbox + docs/09-ui-and-brand.md §Agent
 * Inbox, Inbox is a full-screen content-area surface (promoted from
 * the prior sidebar-embedded panel). The workspace sidebar stays on
 * the files tree; selecting the sidebar's INBOX tab routes the
 * content area here.
 *
 * Keyboard-first:
 *   · `j`/`k` (or ↑↓) move focus between entries
 *   · `a` approves the focused entry, `r` rejects
 *   · `⇧A` approve-all, `⇧R` reject-all
 *   · `↵` toggles the focused entry's expanded diff dropdown
 *
 * New interaction: clicking (or pressing Enter on) an entry expands
 * an inline diff dropdown below it, rendering per-file `git diff`
 * content with a "Jump to file" CTA that opens the changed file in
 * the editor. The dropdown is the review affordance — we don't ship
 * people to a separate surface to see what they're approving.
 */

interface InboxEntry {
  id: string;
  agentSlug: string;
  branch: string;
  jobId: string;
  filesChanged: string[];
  finalizedAt: number;
  status: string;
}

export function InboxPanel() {
  const typeDisplay = useAppStore((s) => s.typeDisplay);
  const serif = typeDisplay === "serif";

  const [entries, setEntries] = useState<InboxEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [focusIdx, setFocusIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  /** Id of the currently-expanded entry (only one at a time). */
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [fileStats, setFileStats] = useState<Map<string, InboxFileDiff[] | "error">>(
    () => new Map(),
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { entries: e } = await fetchInbox();
      setEntries(e);
    } catch {
      /* leave empty on network error */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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

  useEffect(() => {
    if (entries.length === 0) setFocusIdx(0);
    else if (focusIdx >= entries.length) setFocusIdx(entries.length - 1);
  }, [entries.length, focusIdx]);

  const handleApprove = useCallback(async (id: string) => {
    const result = await approveInboxEntry(id);
    if (result.success) {
      setEntries((prev) => prev.filter((e) => e.id !== id));
      setExpandedId((cur) => (cur === id ? null : cur));
    }
  }, []);

  const handleReject = useCallback(async (id: string) => {
    const result = await rejectInboxEntry(id);
    if (result.success) {
      setEntries((prev) => prev.filter((e) => e.id !== id));
      setExpandedId((cur) => (cur === id ? null : cur));
    }
  }, []);

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
    const ids = entries.map((e) => e.id);
    for (const id of ids) {
      try {
        await handleApprove(id);
      } catch {
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

  /**
   * Jump to a file that appears inside the expanded diff. Closes the
   * inbox surface, restores the sidebar to its Files tab, and routes
   * the editor to the file's path. This is the review-to-edit bridge
   * the spec calls for in the expand-on-click flow.
   */
  const handleJumpToFile = useCallback((path: string) => {
    const store = useAppStore.getState();
    store.setSidebarTab("files");
    store.setActivePath(path);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
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
          if (!entry) break;
          e.preventDefault();
          // Enter toggles the inline diff dropdown for the focused
          //  entry — the review affordance replaces the prior
          //  "open provenance" behavior, which dropped users out of
          //  the inbox flow.
          setExpandedId((cur) => (cur === entry.id ? null : entry.id));
          break;
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [entries, focusIdx, handleApprove, handleReject, handleApproveAll, handleRejectAll]);

  const paddedCount = String(entries.length).padStart(2, "0");

  return (
    <section
      className="flex h-full flex-col overflow-hidden"
      aria-label="Agent Inbox"
      style={{ background: "var(--il-bg)" }}
    >
      {/* Header — content-area grammar. Mono `NN pending` overline +
       *  variant-aware H1 (Inter 22 safe / Serif 34 italic with
       *  trailing italic `awaiting review.` in display) + a
       *  keyboard-hint row. Matches screen-more.jsx ScreenInbox. */}
      <header
        className="shrink-0"
        style={{
          padding: "22px 32px 14px",
          borderBottom: "1px solid var(--il-border-soft)",
        }}
      >
        <div className="flex items-baseline gap-4">
          <span
            className="font-mono uppercase"
            style={{
              fontSize: 11,
              letterSpacing: "0.08em",
              color: "var(--il-text3)",
            }}
          >
            {paddedCount} pending
          </span>
          <h1
            style={{
              fontFamily: serif ? "var(--font-display)" : "var(--font-sans)",
              fontWeight: serif ? 400 : 600,
              fontSize: serif ? 34 : 22,
              letterSpacing: "-0.025em",
              lineHeight: 1.1,
              margin: 0,
              color: "var(--il-text)",
            }}
          >
            Agent Inbox
            {serif && (
              <span style={{ fontStyle: "italic", color: "var(--il-text2)" }}>
                {" "}
                — awaiting review.
              </span>
            )}
          </h1>
        </div>
        {!loading && entries.length > 0 && (
          <div
            className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono uppercase"
            style={{ fontSize: 10.5, letterSpacing: "0.04em", color: "var(--il-text3)" }}
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
            <span>
              <Key>↵</Key> expand
            </span>
          </div>
        )}
      </header>

      <div className="flex-1 overflow-y-auto" style={{ padding: "14px 32px" }}>
        {loading && <div className="py-8 text-center text-xs text-secondary">Loading…</div>}
        {!loading && entries.length === 0 && <InboxEmptyState />}
        {entries.map((entry, idx) => {
          const focused = idx === focusIdx;
          const expanded = expandedId === entry.id;
          return (
            <InboxEntryCard
              key={entry.id}
              entry={entry}
              focused={focused}
              expanded={expanded}
              stats={fileStats.get(entry.id)}
              onToggleExpanded={() => {
                setFocusIdx(idx);
                setExpandedId((cur) => (cur === entry.id ? null : entry.id));
              }}
              onApprove={() => handleApprove(entry.id)}
              onReject={() => handleReject(entry.id)}
              onDecisionChange={(path, decision) => handleFileDecision(entry.id, path, decision)}
              onJumpToFile={handleJumpToFile}
            />
          );
        })}
      </div>
    </section>
  );
}

/**
 * One entry in the inbox list. The card header is click-to-expand;
 * expanding drops an inline diff dropdown below the file rows.
 * Approve/Reject remain in the header so users can act without
 * having to expand first.
 */
function InboxEntryCard({
  entry,
  focused,
  expanded,
  stats,
  onToggleExpanded,
  onApprove,
  onReject,
  onDecisionChange,
  onJumpToFile,
}: {
  entry: InboxEntry;
  focused: boolean;
  expanded: boolean;
  stats: InboxFileDiff[] | "error" | undefined;
  onToggleExpanded: () => void;
  onApprove: () => void;
  onReject: () => void;
  onDecisionChange: (path: string, decision: "approved" | "rejected" | null) => void;
  onJumpToFile: (path: string) => void;
}) {
  const typeDisplay = useAppStore((s) => s.typeDisplay);
  const serif = typeDisplay === "serif";
  const shortBranch = entry.branch.split("/").pop() || entry.branch;
  const finalizedLabel = formatRelative(entry.finalizedAt, Date.now());

  return (
    <div
      id={`inbox-entry-${entry.id}`}
      aria-current={focused ? "true" : undefined}
      className="mb-3 overflow-hidden rounded-md"
      style={{
        background: focused
          ? "color-mix(in oklch, var(--il-blue) 8%, transparent)"
          : "var(--il-slate)",
        border: focused ? "1px solid var(--il-blue)" : "1px solid var(--il-border-soft)",
        boxShadow: focused ? "0 0 0 3px var(--il-blue-glow)" : undefined,
        transition: "background var(--motion-snap), border-color var(--motion-snap)",
      }}
    >
      {/* Header row — click to expand the diff dropdown. Approve /
       *  Reject buttons stop propagation so they don't toggle too. */}
      <button
        type="button"
        onClick={onToggleExpanded}
        aria-expanded={expanded}
        aria-controls={`inbox-diff-${entry.id}`}
        className="flex w-full items-center gap-3 text-left outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
        style={{ padding: "12px 16px" }}
      >
        <Reuleaux size={10} color="var(--il-amber)" aria-label="Pending review" />
        <span
          className="shrink-0"
          style={{
            fontFamily: serif ? "var(--font-display)" : "var(--font-sans)",
            fontStyle: serif ? "italic" : "normal",
            fontSize: serif ? 22 : 15,
            fontWeight: serif ? 400 : 600,
            letterSpacing: "-0.01em",
            color: "var(--il-text)",
          }}
        >
          {entry.agentSlug}
        </span>
        <Meta
          k="branch"
          v={shortBranch}
          style={{ maxWidth: "10rem", overflow: "hidden", textOverflow: "ellipsis" }}
        />
        <Meta k="finalized" v={finalizedLabel} />
        <span className="flex-1" />
        <span
          aria-hidden="true"
          className="font-mono"
          style={{
            fontSize: 10.5,
            color: "var(--il-text3)",
            letterSpacing: "0.04em",
          }}
        >
          {expanded ? "▾" : "▸"}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onReject();
          }}
          className="rounded px-3 py-1 text-xs font-medium text-secondary transition-colors hover:bg-ironlore-slate-hover"
          style={{ border: "1px solid var(--il-border)" }}
        >
          Reject all
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onApprove();
          }}
          className="rounded border-none bg-ironlore-blue px-3 py-1 text-xs font-medium text-background hover:bg-ironlore-blue-strong"
          style={{ boxShadow: "0 0 10px var(--il-blue-glow)" }}
        >
          Approve all
        </button>
      </button>

      <InboxEntryFiles
        entry={entry}
        stats={stats}
        focused={focused}
        onDecisionChange={onDecisionChange}
      />

      {/* Inline diff dropdown — only one entry may be expanded at a
       *  time. Each file shows its unified diff + a Jump-to-file
       *  CTA so the user can open the changed file without leaving
       *  the review flow. */}
      {expanded && (
        <InboxDiffDropdown entryId={entry.id} stats={stats} onJumpToFile={onJumpToFile} />
      )}
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
          fontSize: 10.5,
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
 * Per-file status rows. Each row: `A/D/M` status letter · mono path
 * · mono delta (`+N -N`) · `pending` StatusPip · mini `× / ✓`
 * decision buttons per screen-more.jsx. Decisions persist via
 * `POST /inbox/:id/files/decision` and round-trip into the Approve-
 * all partial-cherry-pick.
 */
function InboxEntryFiles({
  entry,
  stats,
  focused,
  onDecisionChange,
}: {
  entry: InboxEntry;
  stats: InboxFileDiff[] | "error" | undefined;
  focused: boolean;
  onDecisionChange: (path: string, decision: "approved" | "rejected" | null) => void;
}) {
  if (stats === undefined || stats === "error" || stats.length === 0) {
    return (
      <ul
        className="border-t border-border/50 text-[10px] text-secondary"
        style={{ padding: "8px 16px" }}
      >
        {entry.filesChanged.map((f) => (
          <li key={f} className="truncate font-mono">
            {f}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <ul style={{ borderTop: "1px solid var(--il-border-soft)" }}>
      {stats.map((f, i) => {
        const isApproved = f.decision === "approved";
        const isRejected = f.decision === "rejected";
        const toggle = (next: "approved" | "rejected") => {
          onDecisionChange(f.path, f.decision === next ? null : next);
        };
        const firstRowFocusTint =
          focused && i === 0 && !isApproved && !isRejected
            ? "color-mix(in oklch, var(--il-blue) 8%, transparent)"
            : null;
        return (
          <li
            key={f.path}
            className="grid items-center"
            style={{
              gridTemplateColumns: "20px minmax(0, 1fr) auto auto 72px",
              columnGap: 12,
              padding: "10px 16px",
              fontSize: 12,
              background: isApproved
                ? "color-mix(in oklch, var(--il-green) 8%, transparent)"
                : isRejected
                  ? "color-mix(in oklch, var(--il-red) 8%, transparent)"
                  : (firstRowFocusTint ?? "transparent"),
              opacity: isRejected ? 0.65 : 1,
              borderTop: i > 0 ? "1px solid var(--il-border-soft)" : undefined,
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
                fontSize: 12,
                color: "var(--il-text)",
                textDecoration: isRejected ? "line-through" : undefined,
              }}
            >
              {f.path}
            </span>
            <span className="font-mono" style={{ fontSize: 10.5, color: "var(--il-text3)" }}>
              {formatDelta(f)}
            </span>
            <StatusPip state="idle" label="pending" size={7} />
            <div className="flex justify-end gap-1.5">
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
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Expand-on-click dropdown — fetches the unified diff for every file
 * in the entry and renders each block with a Jump-to-file CTA.
 * Diffs are fetched lazily on expand so an un-expanded entry doesn't
 * pay the git round-trip; results live in local component state so
 * collapsing & re-expanding doesn't re-fetch.
 */
function InboxDiffDropdown({
  entryId,
  stats,
  onJumpToFile,
}: {
  entryId: string;
  stats: InboxFileDiff[] | "error" | undefined;
  onJumpToFile: (path: string) => void;
}) {
  const filePaths = useMemo<string[]>(() => {
    if (!stats || stats === "error") return [];
    return stats.filter((f) => f.status !== "D").map((f) => f.path);
  }, [stats]);

  const [diffs, setDiffs] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    for (const path of filePaths) {
      if (path in diffs) continue;
      setLoading((prev) => {
        const next = new Set(prev);
        next.add(path);
        return next;
      });
      fetchInboxDiff(entryId, path)
        .then((text) => {
          if (cancelled) return;
          setDiffs((prev) => ({ ...prev, [path]: text }));
          setLoading((prev) => {
            const next = new Set(prev);
            next.delete(path);
            return next;
          });
        })
        .catch(() => {
          if (cancelled) return;
          setDiffs((prev) => ({ ...prev, [path]: null }));
          setLoading((prev) => {
            const next = new Set(prev);
            next.delete(path);
            return next;
          });
        });
    }
    return () => {
      cancelled = true;
    };
  }, [entryId, filePaths, diffs]);

  if (filePaths.length === 0) {
    return (
      <div
        id={`inbox-diff-${entryId}`}
        style={{
          padding: "12px 16px",
          borderTop: "1px solid var(--il-border-soft)",
          fontSize: 12,
          color: "var(--il-text3)",
        }}
      >
        No readable diffs — this entry only has deletions or unreadable files.
      </div>
    );
  }

  return (
    <div id={`inbox-diff-${entryId}`} style={{ borderTop: "1px solid var(--il-border-soft)" }}>
      {filePaths.map((path) => (
        <DiffBlock
          key={path}
          path={path}
          diff={diffs[path]}
          loading={loading.has(path)}
          onJumpToFile={() => onJumpToFile(path)}
        />
      ))}
    </div>
  );
}

function DiffBlock({
  path,
  diff,
  loading,
  onJumpToFile,
}: {
  path: string;
  diff: string | null | undefined;
  loading: boolean;
  onJumpToFile: () => void;
}) {
  return (
    <div style={{ borderBottom: "1px solid var(--il-border-soft)" }}>
      <div
        className="flex items-center gap-3"
        style={{
          padding: "8px 16px",
          background: "var(--il-slate-elev)",
          borderBottom: "1px solid var(--il-border-soft)",
        }}
      >
        <span
          className="font-mono uppercase"
          style={{
            fontSize: 10.5,
            letterSpacing: "0.06em",
            color: "var(--il-text3)",
          }}
        >
          diff
        </span>
        <span
          className="truncate font-mono"
          style={{ fontSize: 11.5, color: "var(--il-text2)" }}
          title={path}
        >
          {path}
        </span>
        <span className="flex-1" />
        {/* Jump-to-file CTA — closes the inbox surface + opens the
         *  changed file in the editor. The explicit arrow glyph
         *  matches the "→ open first" pattern in the onboarding
         *  witness step. */}
        <button
          type="button"
          onClick={onJumpToFile}
          className="inline-flex items-center gap-1.5 rounded outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
          style={{
            padding: "4px 10px",
            fontSize: 11.5,
            fontFamily: "var(--font-sans)",
            fontWeight: 500,
            color: "var(--il-blue)",
            background: "transparent",
            border: "1px solid color-mix(in oklch, var(--il-blue) 40%, transparent)",
          }}
        >
          <ExternalLink className="h-3 w-3" />
          Jump to file
        </button>
      </div>
      <div
        style={{
          padding: "8px 16px",
          maxHeight: 360,
          overflowY: "auto",
          background: "var(--il-bg)",
        }}
      >
        {loading && <div style={{ fontSize: 11.5, color: "var(--il-text3)" }}>Loading diff…</div>}
        {!loading && diff === null && (
          <div style={{ fontSize: 11.5, color: "var(--il-text3)" }}>Diff unavailable.</div>
        )}
        {!loading && diff !== null && diff !== undefined && <DiffPre diff={diff} />}
      </div>
    </div>
  );
}

/**
 * Colour-by-prefix renderer for unified diff text. Lines starting
 * with `+` (not `+++`) tint green, `-` (not `---`) tint red,
 * `@@` headings get amber, file headers stay muted mono. The whole
 * block is read-only mono 11.5 / 1.55 — same grammar the AI panel's
 * DiffCard uses, so users learn it once.
 */
function DiffPre({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <pre
      className="font-mono"
      style={{
        margin: 0,
        fontSize: 11.5,
        lineHeight: 1.55,
        color: "var(--il-text2)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {lines.map((line, i) => {
        let color = "var(--il-text2)";
        let background = "transparent";
        let borderLeft = "2px solid transparent";
        if (line.startsWith("+++") || line.startsWith("---")) {
          color = "var(--il-text3)";
        } else if (line.startsWith("+")) {
          color = "var(--il-green)";
          background = "color-mix(in oklch, var(--il-green) 12%, transparent)";
          borderLeft = "2px solid var(--il-green)";
        } else if (line.startsWith("-")) {
          color = "var(--il-red)";
          background = "color-mix(in oklch, var(--il-red) 12%, transparent)";
          borderLeft = "2px solid var(--il-red)";
        } else if (line.startsWith("@@")) {
          color = "var(--il-amber)";
        } else if (line.startsWith("diff ") || line.startsWith("index ")) {
          color = "var(--il-text3)";
        }
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: diff text is positional; index IS the identity
            key={i}
            style={{
              color,
              background,
              borderLeft,
              padding: "0 6px",
            }}
          >
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

/**
 * Spec's mini decision button — solid-fill `×` / `✓` glyph in a
 * 24×22 cell, borderless when active (bg carries the colour),
 * transparent border when inactive. Replaces the prior labeled
 * `R·REJECT` / `A·APPROVE` chip so the file row fits the canvas
 * grammar in screen-more.jsx.
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
  const glyph = kind === "approved" ? "✓" : "×";
  const color = kind === "approved" ? "var(--il-green)" : "var(--il-text2)";
  const activeBg = kind === "approved" ? "var(--il-green)" : "transparent";
  const ariaLabel = kind === "approved" ? "Approve this file" : "Reject this file";
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={active}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{
        width: 24,
        height: 22,
        padding: 0,
        fontSize: 13,
        lineHeight: 1,
        background: active ? activeBg : "transparent",
        color: active ? (kind === "approved" ? "var(--il-bg)" : color) : color,
        border: active
          ? kind === "approved"
            ? "none"
            : "1px solid var(--il-border)"
          : "1px solid var(--il-border)",
        borderRadius: 3,
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

function formatDelta(f: InboxFileDiff): string {
  if (f.added === null && f.removed === null) return "bin";
  const parts: string[] = [];
  if ((f.added ?? 0) > 0) parts.push(`+${f.added}`);
  if ((f.removed ?? 0) > 0) parts.push(`-${f.removed}`);
  return parts.length === 0 ? "·" : parts.join(" ");
}
