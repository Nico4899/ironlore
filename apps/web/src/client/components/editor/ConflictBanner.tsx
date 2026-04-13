import { messages } from "@ironlore/core/messages";
import { useState } from "react";
import type { ConflictResponse } from "../../lib/api.js";
import { fetchPage } from "../../lib/api.js";
import { useEditorStore } from "../../stores/editor.js";

interface ConflictBannerProps {
  conflict: ConflictResponse;
  onResolved: () => void;
}

/**
 * Parse a unified diff string into styled line elements.
 * Each line is classified as added (+), removed (-), header (@@), or context.
 */
function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");

  return (
    <pre className="max-h-60 overflow-auto rounded border border-border bg-ironlore-slate p-3 font-mono text-xs leading-relaxed">
      {lines.map((line, i) => {
        let className = "text-secondary";
        if (line.startsWith("+") && !line.startsWith("+++")) {
          className = "text-signal-green";
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          className = "text-signal-red";
        } else if (line.startsWith("@@")) {
          className = "text-ironlore-blue";
        }

        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are static and never reorder
          <div key={`${i}:${line}`} className={className}>
            {line}
          </div>
        );
      })}
    </pre>
  );
}

/**
 * Conflict banner shown when a 409 is received during auto-save.
 *
 * Shows the unified diff of server-side changes so the user can make an
 * informed choice between keeping their version or discarding.
 *
 * Two actions:
 * - **Keep mine**: force-save with the new ETag (overwrites remote changes)
 * - **Discard**: reload the server version
 */
export function ConflictBanner({ conflict, onResolved }: ConflictBannerProps) {
  const [showDiff, setShowDiff] = useState(true);

  const handleKeepMine = async () => {
    const { filePath, markdown, setEtag, setStatus } = useEditorStore.getState();
    if (!filePath) return;

    // Re-save with the current ETag from the conflict response
    const res = await fetch(`/api/projects/main/pages/${filePath}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": conflict.currentEtag,
      },
      body: JSON.stringify({ markdown }),
    });

    if (res.ok) {
      const { etag } = (await res.json()) as { etag: string };
      setEtag(etag);
      setStatus("clean");
      onResolved();
    }
  };

  const handleDiscard = async () => {
    const { filePath, setFile } = useEditorStore.getState();
    if (!filePath) return;

    const page = await fetchPage(filePath);
    setFile(filePath, page.content, page.etag);
    onResolved();
  };

  return (
    <div className="border-b border-signal-amber bg-signal-amber/10" role="alert">
      <div className="flex items-center gap-3 px-4 py-2 text-sm">
        <span className="flex-1 font-medium text-signal-amber">
          {messages.editorConflictBanner}
        </span>
        <div className="flex gap-2">
          {conflict.diff && (
            <button
              type="button"
              className="rounded border border-border px-3 py-1 text-xs hover:bg-ironlore-slate-hover"
              onClick={() => setShowDiff((v) => !v)}
              aria-expanded={showDiff}
            >
              {showDiff ? "Hide diff" : "Show diff"}
            </button>
          )}
          <button
            type="button"
            className="rounded border border-border px-3 py-1 text-xs hover:bg-ironlore-slate-hover"
            onClick={handleDiscard}
          >
            {messages.editorDiscard}
          </button>
          <button
            type="button"
            className="rounded bg-ironlore-blue px-3 py-1 text-xs font-medium text-white hover:opacity-90"
            onClick={handleKeepMine}
          >
            {messages.editorKeepMine}
          </button>
        </div>
      </div>

      {conflict.diff && showDiff && (
        <div className="px-4 pb-3">
          <DiffView diff={conflict.diff} />
        </div>
      )}
    </div>
  );
}
