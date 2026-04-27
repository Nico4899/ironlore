import { ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  type BlockProvenanceRow,
  type BlockTrustResponse,
  fetchPageProvenance,
} from "../lib/api.js";
import { useAppStore } from "../stores/app.js";
import { Reuleaux } from "./primitives/index.js";

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
  const openProvenance = useAppStore((s) => s.openProvenance);
  const trust = row.trust;
  const trustColor = trustToColor(trust?.state ?? null);

  return (
    <li
      className="rounded border p-2"
      style={{
        borderColor: "var(--il-border-soft)",
        background: "color-mix(in oklch, var(--il-slate-hover) 40%, transparent)",
      }}
    >
      <div className="flex items-center gap-2">
        {trust && <Reuleaux size={7} color={trustColor} />}
        <span
          className="font-mono"
          style={{ fontSize: 10, color: trustColor, letterSpacing: "0.06em" }}
        >
          {(trust?.state ?? "human").toUpperCase()}
        </span>
        <span style={{ color: "var(--il-text4)" }}>·</span>
        <span style={{ color: "var(--il-text3)" }}>{row.agent ?? "unknown"}</span>
        <span className="flex-1" />
        <code
          className="font-mono"
          style={{ fontSize: 10, color: "var(--il-text4)" }}
          title={row.id}
        >
          {row.id.slice(-6)}
        </code>
      </div>
      {trust && (
        <div className="mt-1 flex items-center gap-3" style={{ color: "var(--il-text3)" }}>
          <span className="font-mono" style={{ fontSize: 10 }}>
            {trust.sources} source{trust.sources === 1 ? "" : "s"}
          </span>
          <span style={{ color: "var(--il-text4)" }}>·</span>
          <span className="font-mono" style={{ fontSize: 10 }}>
            depth {trust.chainDepth}
          </span>
          {trust.reason && (
            <>
              <span style={{ color: "var(--il-text4)" }}>·</span>
              <span style={{ fontSize: 10 }}>{trust.reason}</span>
            </>
          )}
        </div>
      )}
      {row.derivedFrom.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {row.derivedFrom.map((ref) => {
            const parsed = parseBlockRef(ref);
            if (!parsed) return null;
            return (
              <button
                key={ref}
                type="button"
                onClick={() => openProvenance(parsed.page, parsed.blockId)}
                className="rounded font-mono hover:bg-ironlore-blue/15"
                style={{
                  fontSize: 10,
                  padding: "1px 6px",
                  border: "1px solid color-mix(in oklch, var(--il-blue) 30%, transparent)",
                  color: "var(--il-blue)",
                  background: "color-mix(in oklch, var(--il-blue) 8%, transparent)",
                }}
                title={ref}
              >
                {parsed.page.split("/").pop()}#{parsed.blockId.slice(-4)}
              </button>
            );
          })}
        </div>
      )}
    </li>
  );
}

function trustToColor(state: BlockTrustResponse["state"] | null): string {
  if (state === "fresh") return "var(--il-green)";
  if (state === "stale") return "var(--il-amber)";
  if (state === "unverified") return "var(--il-text4)";
  return "var(--il-text4)";
}

function parseBlockRef(ref: string): { page: string; blockId: string } | null {
  const hash = ref.lastIndexOf("#");
  if (hash <= 0) return null;
  return { page: ref.slice(0, hash), blockId: ref.slice(hash + 1) };
}
