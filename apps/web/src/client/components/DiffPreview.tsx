import { Meta } from "./primitives/index.js";

interface DiffPreviewProps {
  pageId: string;
  diff: string;
  approved: boolean | null;
  onApprove: () => void;
  onReject: () => void;
  /** Optional block id so the header can render `page · #block`. */
  blockId?: string;
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
}: DiffPreviewProps) {
  const lines = diff.split("\n");
  const { added, removed } = countHunkLines(lines);
  const target = blockId ? `${pageId} · #${blockId}` : pageId;

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
        <Meta k="Δ" v={`+${added} −${removed}`} />
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
        <div
          className="flex items-center gap-2"
          style={{
            padding: "6px 10px",
            borderTop: "1px solid var(--il-border-soft)",
          }}
        >
          <button
            type="button"
            onClick={onReject}
            style={{
              padding: "4px 10px",
              fontSize: 11.5,
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
              padding: "4px 10px",
              fontSize: 11.5,
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

      {approved !== null && (
        <div
          className="font-mono uppercase"
          style={{
            fontSize: 10.5,
            letterSpacing: "0.06em",
            padding: "6px 10px",
            borderTop: "1px solid var(--il-border-soft)",
            color: approved ? "var(--il-green)" : "var(--il-red)",
          }}
        >
          {approved ? "approved" : "rejected"}
        </div>
      )}
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
