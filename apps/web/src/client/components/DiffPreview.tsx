import { Check, X } from "lucide-react";

interface DiffPreviewProps {
  pageId: string;
  diff: string;
  approved: boolean | null;
  onApprove: () => void;
  onReject: () => void;
}

/**
 * Inline diff preview card for destructive agent edits.
 *
 * When dry-run mode is on (default for the Editor agent), the tool
 * dispatcher emits a `diff_preview` event instead of executing the
 * mutation. The AI panel renders this card so the user can approve
 * or reject before the edit lands.
 *
 * See docs/04-ai-and-agents.md §Dry-run diff preview and
 * docs/09-ui-and-brand.md §useAIPanelStore.ConversationMessage.
 */
export function DiffPreview({ pageId, diff, approved, onApprove, onReject }: DiffPreviewProps) {
  const lines = diff.split("\n");

  return (
    <div className="rounded-lg border border-border bg-ironlore-slate text-xs">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="font-medium text-primary">
          {approved === true ? "✓ Approved" : approved === false ? "✗ Rejected" : "Review edit"}
        </span>
        <code className="font-mono text-[10px] text-secondary">{pageId}</code>
      </div>

      <pre className="max-h-48 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed">
        {lines.map((line, i) => {
          let cls = "text-secondary";
          if (line.startsWith("+") && !line.startsWith("+++")) cls = "text-signal-green";
          else if (line.startsWith("-") && !line.startsWith("---")) cls = "text-signal-red";
          else if (line.startsWith("@@")) cls = "text-ironlore-blue";

          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are static
            <div key={`${i}:${line.slice(0, 20)}`} className={cls}>
              {line}
            </div>
          );
        })}
      </pre>

      {approved === null && (
        <div className="flex gap-2 border-t border-border px-3 py-2">
          <button
            type="button"
            onClick={onApprove}
            className="flex items-center gap-1 rounded bg-signal-green/20 px-2 py-1 font-medium text-signal-green hover:bg-signal-green/30"
          >
            <Check className="h-3 w-3" />
            Apply
          </button>
          <button
            type="button"
            onClick={onReject}
            className="flex items-center gap-1 rounded bg-signal-red/20 px-2 py-1 font-medium text-signal-red hover:bg-signal-red/30"
          >
            <X className="h-3 w-3" />
            Skip
          </button>
        </div>
      )}
    </div>
  );
}
