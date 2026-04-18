import { Check, GitBranch, Inbox, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { approveInboxEntry, fetchInbox, rejectInboxEntry } from "../lib/api.js";
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
 * Each entry shows the agent name, branch, files changed, and
 * approve/reject buttons. Approve merges the staging branch to main
 * via fast-forward or rebase. Reject deletes the branch.
 */
export function InboxPanel({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<InboxEntry[]>([]);
  const [loading, setLoading] = useState(true);

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

  const handleApprove = async (id: string) => {
    const result = await approveInboxEntry(id);
    if (result.success) {
      setEntries((prev) => prev.filter((e) => e.id !== id));
    }
  };

  const handleReject = async (id: string) => {
    const result = await rejectInboxEntry(id);
    if (result.success) {
      setEntries((prev) => prev.filter((e) => e.id !== id));
    }
  };

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

      <div className="flex-1 overflow-y-auto p-3">
        {/* Canvas-grammar section label — zero-padded index, title, mono
         *  count on the right. "03 Pending" layout per spec. */}
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

        {entries.map((entry) => (
          <div
            key={entry.id}
            className="mb-2 rounded-lg border border-border bg-ironlore-slate-hover/50 p-3 text-xs"
          >
            <div className="flex items-center gap-2">
              {/* Amber Reuleaux — this entry is pending review. Signal-
               *  Amber is the inbox's state color per rev-3 spec. */}
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
                onClick={() => handleApprove(entry.id)}
                className="flex items-center gap-1 rounded border border-signal-green/30 bg-signal-green/10 px-2 py-1 text-signal-green hover:bg-signal-green/20"
              >
                <Check className="h-3 w-3" />
                Approve
              </button>
              <button
                type="button"
                onClick={() => handleReject(entry.id)}
                className="flex items-center gap-1 rounded border border-signal-red/30 bg-signal-red/10 px-2 py-1 text-signal-red hover:bg-signal-red/20"
              >
                <X className="h-3 w-3" />
                Reject
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
