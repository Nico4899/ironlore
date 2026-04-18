import { Check, GitBranch, Inbox, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { approveInboxEntry, fetchInbox, rejectInboxEntry } from "../lib/api.js";
import { useAppStore } from "../stores/app.js";
import { Reuleaux, SectionLabel } from "./primitives/index.js";

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
 * Keyboard-first per docs/09-ui-and-brand.md §Agent Inbox: `j`/`k`
 * (or arrow keys) move between entries, `a` approves the focused
 * entry, `r` rejects, `Enter` opens provenance for the first file
 * changed. Buttons remain clickable for mouse users.
 */
export function InboxPanel({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<InboxEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [focusIdx, setFocusIdx] = useState(0);

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

  // Panel-scoped keyboard shortcuts. Mounting the listener at the
  // window lets keystrokes fire without the user first focusing a
  // non-interactive region (which Biome a11y lint correctly rejects).
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
          // Open provenance for the first file touched by this run;
          // empty block id surfaces the page header.
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
  }, [entries, focusIdx, handleApprove, handleReject]);

  return (
    <div className="flex h-full w-80 flex-col border-l border-border bg-ironlore-slate">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-primary">
          <Inbox className="h-4 w-4" />
          Agent Inbox
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

      <section className="flex-1 overflow-y-auto p-3" aria-label="Pending inbox entries">
        {!loading && (
          <SectionLabel
            index={1}
            title="Pending"
            meta={`${entries.length} review${entries.length === 1 ? "" : "s"}`}
          />
        )}

        {loading && <div className="py-8 text-center text-xs text-secondary">Loading...</div>}

        {!loading && entries.length === 0 && (
          <div className="py-8 text-center text-xs text-secondary">
            No pending reviews. Runs with{" "}
            <code className="rounded bg-ironlore-slate-hover px-1">review_mode: inbox</code> will
            appear here.
          </div>
        )}

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

              <ul className="mt-1 max-h-20 overflow-y-auto text-[10px] text-secondary">
                {entry.filesChanged.map((f) => (
                  <li key={f} className="truncate font-mono">
                    {f}
                  </li>
                ))}
              </ul>

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
                  Approve <kbd className="ml-1 font-mono text-[9px] opacity-60">a</kbd>
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
                  Reject <kbd className="ml-1 font-mono text-[9px] opacity-60">r</kbd>
                </button>
              </div>
            </div>
          );
        })}

        {!loading && entries.length > 0 && (
          <div className="mt-3 border-t border-border-soft pt-2 font-mono text-[10px] uppercase tracking-wider text-tertiary">
            <kbd className="bg-ironlore-slate-hover px-1">j</kbd>/
            <kbd className="bg-ironlore-slate-hover px-1">k</kbd> move ·{" "}
            <kbd className="bg-ironlore-slate-hover px-1">a</kbd> approve ·{" "}
            <kbd className="bg-ironlore-slate-hover px-1">r</kbd> reject ·{" "}
            <kbd className="bg-ironlore-slate-hover px-1">↵</kbd> open
          </div>
        )}
      </section>
    </div>
  );
}
