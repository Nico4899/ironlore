import { ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { type BlockProvenanceRow, fetchPageProvenance } from "../lib/api.js";
import { BlockProvenanceStrip } from "./BlockProvenanceStrip.js";

/**
 * "Show your work" provenance panel — Phase-11 A.3.2 deliverable.
 *
 * Surfaces the per-block `derived_from` / `agent` / `compiled_at`
 * stamps the kb tools persist into `.blocks.json`, alongside a
 * server-computed trust state (`fresh | stale | unverified`). The
 * trust signal is derived at read time per
 * [docs/04-ai-and-agents.md §Trust score](../../../docs/04-ai-and-agents.md);
 * no persisted column anywhere — recomputing with a new heuristic
 * is just a server redeploy.
 *
 * UX shape: anchored panel that opens from the editor toolbar's
 * `BlockProvenanceButton`. Lists every agent-stamped block on the
 * current page; each row exposes the source citations as clickable
 * chips that route through the existing `openProvenance` flow
 * (block-ref click + amber flash). Blocks with no stamp are
 * omitted entirely — no empty rows for the human-written majority.
 */
export function BlockProvenancePanel({
  pagePath,
  onClose,
}: {
  pagePath: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<BlockProvenanceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch on mount + on path change. The endpoint is cheap (one
  // sidecar read + a per-source stat) so we don't bother with a
  // store-level cache; reopening the panel re-reads.
  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    void fetchPageProvenance(pagePath)
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [pagePath]);

  return (
    <div
      role="dialog"
      aria-label="Block provenance"
      style={{
        position: "absolute",
        top: 40,
        right: 16,
        width: 380,
        maxHeight: "60vh",
        overflowY: "auto",
        zIndex: 40,
        background: "var(--il-slate-elev)",
        border: "1px solid var(--il-border)",
        borderRadius: 6,
        boxShadow: "0 6px 24px color-mix(in oklch, black 30%, transparent)",
      }}
    >
      <header
        className="flex items-center gap-2 border-b px-3 font-mono uppercase"
        style={{
          height: 32,
          borderColor: "var(--il-border-soft)",
          fontSize: 10.5,
          letterSpacing: "0.06em",
          color: "var(--il-text2)",
        }}
      >
        <ShieldCheck className="h-3.5 w-3.5" style={{ color: "var(--il-blue)" }} />
        <span>Provenance</span>
        <span style={{ color: "var(--il-text4)" }}>·</span>
        <span style={{ color: "var(--il-text3)" }}>
          {rows === null ? "loading" : `${rows.length} block${rows.length === 1 ? "" : "s"}`}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close provenance panel"
          className="rounded p-0.5 hover:bg-ironlore-slate-hover"
        >
          <X className="h-3.5 w-3.5" style={{ color: "var(--il-text3)" }} />
        </button>
      </header>
      <div className="px-3 py-2 text-xs" style={{ color: "var(--il-text2)" }}>
        {error && (
          <div className="text-signal-red" role="alert">
            {error}
          </div>
        )}
        {rows !== null && rows.length === 0 && !error && (
          <div style={{ color: "var(--il-text3)" }}>
            No agent-authored blocks on this page. Provenance only renders for blocks the agent
            wrote — human-written content needs no receipts.
          </div>
        )}
        {rows !== null && rows.length > 0 && (
          <ul className="space-y-2">
            {rows.map((row) => (
              <ProvenanceRow key={row.id} row={row} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ProvenanceRow({ row }: { row: BlockProvenanceRow }) {
  return (
    <li
      className="rounded border p-2"
      style={{
        borderColor: "var(--il-border-soft)",
        background: "color-mix(in oklch, var(--il-slate-hover) 40%, transparent)",
      }}
    >
      <BlockProvenanceStrip row={row} />
    </li>
  );
}
