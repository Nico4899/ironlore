import type { BlockProvenanceRow, BlockTrustResponse } from "../lib/api.js";
import { useAppStore } from "../stores/app.js";
import { Reuleaux } from "./primitives/index.js";

/**
 * Per-block provenance metadata — agent slug + trust badge + source
 * citation chips. Used in two places that show a single block's
 * receipts:
 *
 *   1. [`BlockProvenancePanel`](./BlockProvenancePanel.tsx) — one
 *      strip per row in the toolbar-opened "Show your work" panel.
 *   2. [`ProvenancePane`](./ProvenancePane.tsx) — one strip pinned
 *      above the cited block in the right-hand citation pane (per
 *      docs/03-editor.md §Block-ref click and hover provenance).
 *
 * Both surfaces render the same shape for the same per-block
 * provenance row (`BlockProvenanceRow`); pulling the renderer out
 * keeps the visual contract identical so trust + provenance reads
 * the same way wherever the user encounters it.
 */
export function BlockProvenanceStrip({ row }: { row: BlockProvenanceRow }) {
  const openProvenance = useAppStore((s) => s.openProvenance);
  const trust = row.trust;
  const trustColor = trustToColor(trust?.state ?? null);
  const trustLabel = (trust?.state ?? "human").toUpperCase();

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {trust && <Reuleaux size={7} color={trustColor} />}
        <span
          className="font-mono"
          style={{ fontSize: 10, color: trustColor, letterSpacing: "0.06em" }}
        >
          {trustLabel}
        </span>
        <span style={{ color: "var(--il-text4)" }}>·</span>
        <span style={{ color: "var(--il-text3)", fontSize: 11 }}>{row.agent ?? "unknown"}</span>
        {row.compiledAt && (
          <>
            <span style={{ color: "var(--il-text4)" }}>·</span>
            <span
              className="font-mono"
              style={{ fontSize: 10, color: "var(--il-text4)" }}
              title={row.compiledAt}
            >
              {formatRelative(row.compiledAt)}
            </span>
          </>
        )}
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
        <div className="flex items-center gap-3" style={{ color: "var(--il-text3)" }}>
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
        <div className="flex flex-wrap gap-1">
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
    </div>
  );
}

function trustToColor(state: BlockTrustResponse["state"] | null): string {
  if (state === "fresh") return "var(--il-green)";
  if (state === "stale") return "var(--il-amber)";
  if (state === "unverified") return "var(--il-text4)";
  return "var(--il-text4)";
}

/** Relative time stamp — "2h ago", "3d ago", "5w ago", or full ISO
 *  date past a year. Mirrors the brevity of the rest of the
 *  provenance strip; full ISO available in the `title` tooltip. */
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = hours / 24;
  if (days < 7) return `${Math.floor(days)}d ago`;
  const weeks = days / 7;
  if (weeks < 52) return `${Math.floor(weeks)}w ago`;
  return iso.slice(0, 10);
}

function parseBlockRef(ref: string): { page: string; blockId: string } | null {
  const hash = ref.lastIndexOf("#");
  if (hash <= 0) return null;
  return { page: ref.slice(0, hash), blockId: ref.slice(hash + 1) };
}
