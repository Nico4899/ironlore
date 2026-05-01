import { Meta } from "./primitives/index.js";

interface DiffPreviewProps {
  pageId: string;
  diff: string;
  approved: boolean | null;
  onApprove: () => void;
  onReject: () => void;
  /** Optional block id so the header can render `page · #block`. */
  blockId?: string;
  /**
   * Commit SHA produced by the executor after approval. When present
   * the collapsed summary line shows `… · <short>`. Absent for the
   * resting / pending state.
   */
  commitSha?: string;
  /**
   * Phase-11 inline-diff plugin (docs/03-editor.md §Pending-edit
   * decorations) — when the proposed edit's target page is NOT the
   * one the user has open, surface an "Open page" affordance that
   * routes them to the in-editor inline-diff surface instead of
   * forcing the full approve/reject decision from the panel.
   * `onOpenPage` is invoked with no args; the caller decides whether
   * to navigate, push the pending edit into the editor store, or
   * both. When `false`, the button isn't rendered.
   */
  showOpenPageButton?: boolean;
  onOpenPage?: () => void;
}

/**
 * Inline diff preview card per docs/09-ui-and-brand.md §AI panel
 * DiffCard: mono `diff preview` + `page · #block` overline + a
 * right-aligned `Meta k="Δ" v="+N −N"` chip. Hunk rows are 14 %
 * red- or green-tinted with a matching 2 px left bar. Footer
 * buttons are **Approve** (blue + `--il-blue-glow`) and **Reject**
 * (transparent with `--il-border` stroke) — the same hierarchy the
 * Agent Inbox uses, so the user learns it once.
 *
 * When dry-run mode is on (default for the Editor agent), the tool
 * dispatcher emits a `diff_preview` event instead of executing the
 * mutation. The AI panel renders this card so the user can approve
 * or reject before the edit lands.
 *
 * See docs/04-ai-and-agents.md §Dry-run diff preview.
 */
export function DiffPreview({
  pageId,
  blockId,
  diff,
  approved,
  onApprove,
  onReject,
  commitSha,
  showOpenPageButton = false,
  onOpenPage,
}: DiffPreviewProps) {
  const lines = diff.split("\n");
  const { added, removed } = countHunkLines(lines);
  const target = blockId ? `${pageId} · #${blockId}` : pageId;

  // Collapsed summary row — rendered once the user has approved or
  //  rejected. The conversation keeps flowing, so we trade the full
  //  diff for a single mono line (matching screen-editor.jsx's
  //  `· REPLACED / ARCHITECTURE.MD · BLK_A4F2 / -3 +8   SHA · 2s ago`).
  if (approved !== null) {
    return (
      <DiffPreviewSummary
        verb={approved ? "replaced" : "rejected"}
        verbColor={approved ? "var(--il-green)" : "var(--il-red)"}
        pageId={pageId}
        blockId={blockId}
        added={added}
        removed={removed}
        commitSha={commitSha}
      />
    );
  }

  return (
    <div
      style={{
        borderRadius: 4,
        border: "1px solid var(--il-border-soft)",
        background: "var(--il-slate)",
        fontSize: 12,
      }}
    >
      {/* Mono `diff preview` overline + page · #block + right-aligned Δ. */}
      <div
        className="flex items-center gap-2"
        style={{
          padding: "6px 10px",
          borderBottom: "1px solid var(--il-border-soft)",
        }}
      >
        <span
          className="font-mono uppercase"
          style={{ fontSize: 10.5, letterSpacing: "0.06em", color: "var(--il-text3)" }}
        >
          diff preview
        </span>
        <span aria-hidden="true" style={{ color: "var(--il-text4)" }}>
          ·
        </span>
        <code
          className="font-mono truncate"
          style={{ fontSize: 10.5, color: "var(--il-text2)" }}
          title={target}
        >
          {target}
        </code>
        <span className="flex-1" />
        {/* Δ tint turns green when the edit is net-additive (pure
         *  add, or more adds than deletes) and red when net-
         *  destructive. Pure deletion reads red; mixed falls back to
         *  the default Meta tone so the signal is never ambiguous. */}
        <Meta
          k="Δ"
          v={`+${added} −${removed}`}
          color={
            removed === 0 && added > 0
              ? "var(--il-green)"
              : added === 0 && removed > 0
                ? "var(--il-red)"
                : undefined
          }
        />
      </div>

      {/* Hunks — one row per line, 14 % tint + 2 px left bar on
       *  add/remove. No horizontal scroll; overflow wraps so full
       *  hunks stay visible inside the 380 px panel. */}
      <div style={{ maxHeight: 208, overflowY: "auto", padding: "6px 0" }}>
        {lines.map((line, i) => {
          const isAdd = line.startsWith("+") && !line.startsWith("+++");
          const isDel = line.startsWith("-") && !line.startsWith("---");
          const isHunk = line.startsWith("@@");
          let bg: string | undefined;
          let rail: string | undefined;
          let color: string = "var(--il-text2)";
          if (isAdd) {
            bg = "color-mix(in oklch, var(--il-green) 14%, transparent)";
            rail = "var(--il-green)";
            color = "var(--il-text)";
          } else if (isDel) {
            bg = "color-mix(in oklch, var(--il-red) 14%, transparent)";
            rail = "var(--il-red)";
            color = "var(--il-text)";
          } else if (isHunk) {
            color = "var(--il-blue)";
          }
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
              key={`${i}:${line.slice(0, 20)}`}
              className="font-mono"
              style={{
                fontSize: 11.5,
                lineHeight: 1.55,
                padding: "0 10px",
                background: bg,
                borderLeft: rail ? `2px solid ${rail}` : "2px solid transparent",
                color,
                whiteSpace: "pre-wrap",
              }}
            >
              {line}
            </div>
          );
        })}
      </div>

      {approved === null && (
        // Footer buttons split 50/50 via `flex: 1` per
        //  screen-editor.jsx DiffCard. Reject stays on the left to
        //  match the Inbox approve/reject grammar the user learns
        //  once; the JSX source-of-truth is inconsistent across
        //  surfaces on button order, so brand-doc consistency wins.
        <div
          className="flex items-center gap-1.5"
          style={{
            padding: "8px 10px",
            borderTop: "1px solid var(--il-border-soft)",
          }}
        >
          {showOpenPageButton && onOpenPage && (
            // Phase-11 inline-diff bridge: when the target page isn't
            //  open, the user can choose to review the change in the
            //  editor surface (where the inline plugin shows ghost
            //  decorations + Tab-to-accept) instead of approving from
            //  the panel. Sits before Reject so it doesn't displace
            //  the primary approve/reject grammar.
            <button
              type="button"
              onClick={onOpenPage}
              style={{
                flex: 1,
                padding: "5px 8px",
                fontSize: 12,
                fontFamily: "var(--font-sans)",
                fontWeight: 500,
                background: "transparent",
                color: "var(--il-text2)",
                border: "1px solid var(--il-border-soft)",
                borderRadius: 3,
                cursor: "pointer",
              }}
            >
              Open page
            </button>
          )}
          <button
            type="button"
            onClick={onReject}
            style={{
              flex: 1,
              padding: "5px 8px",
              fontSize: 12,
              fontFamily: "var(--font-sans)",
              fontWeight: 500,
              background: "transparent",
              color: "var(--il-text2)",
              border: "1px solid var(--il-border)",
              borderRadius: 3,
              cursor: "pointer",
            }}
          >
            Reject
          </button>
          <button
            type="button"
            onClick={onApprove}
            style={{
              flex: 1,
              padding: "5px 8px",
              fontSize: 12,
              fontFamily: "var(--font-sans)",
              fontWeight: 500,
              background: "var(--il-blue)",
              color: "var(--il-bg)",
              border: "none",
              borderRadius: 3,
              cursor: "pointer",
              boxShadow: "0 0 10px var(--il-blue-glow)",
            }}
          >
            Approve
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Single-line summary rendered after the user has voted. Mirrors the
 * schematic `· REPLACED / <path> · <blk> / -3 +8     <sha> · <ago>`
 * from the JSX source-of-truth so the conversation can keep flowing
 * without a stale hunk block in the middle of the transcript.
 */
function DiffPreviewSummary({
  verb,
  verbColor,
  pageId,
  blockId,
  added,
  removed,
  commitSha,
}: {
  verb: string;
  verbColor: string;
  pageId: string;
  blockId?: string;
  added: number;
  removed: number;
  commitSha?: string;
}) {
  const shortSha = commitSha ? commitSha.slice(0, 7) : null;
  const fileLabel = pageId.split("/").pop() ?? pageId;
  const blockLabel = blockId ? ` · ${blockId}` : "";
  return (
    <div
      className="flex items-center gap-2 font-mono uppercase"
      style={{
        padding: "6px 10px",
        borderRadius: 3,
        background: "color-mix(in oklch, var(--il-slate-elev) 60%, transparent)",
        border: "1px solid var(--il-border-soft)",
        fontSize: 10.5,
        letterSpacing: "0.06em",
        color: "var(--il-text3)",
      }}
    >
      <span aria-hidden="true" style={{ color: "var(--il-text4)" }}>
        ·
      </span>
      <span style={{ color: verbColor }}>{verb}</span>
      <span style={{ color: "var(--il-text4)" }}>/</span>
      <span className="truncate" style={{ color: "var(--il-text2)" }} title={pageId}>
        {fileLabel}
        {blockLabel}
      </span>
      <span style={{ color: "var(--il-text4)" }}>/</span>
      <span style={{ color: "var(--il-text2)" }}>
        −{removed} +{added}
      </span>
      <span className="flex-1" />
      {/* Phase-12 git-terminology cleanup (B.6): present the resolved
       *   commit hash with a `version` label so the chrome reads as
       *   product noun, not git-internal noun — consistent with the
       *   AI panel + Agent Detail page renames. */}
      {shortSha && <span style={{ color: "var(--il-text3)" }}>version {shortSha}</span>}
    </div>
  );
}

/**
 * Count `+` and `-` diff lines (skipping the `+++` / `---` file
 * headers) so the header chip can show `Δ +N −N`.
 */
function countHunkLines(lines: string[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}
