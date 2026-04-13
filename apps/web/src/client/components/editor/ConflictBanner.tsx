import { messages } from "@ironlore/core/messages";
import type { ConflictResponse } from "../../lib/api.js";
import { fetchPage } from "../../lib/api.js";
import { useEditorStore } from "../../stores/editor.js";

interface ConflictBannerProps {
  conflict: ConflictResponse;
  onResolved: () => void;
}

/**
 * Conflict banner shown when a 409 is received during auto-save.
 *
 * Three actions:
 * - **Keep mine**: force-save with the new ETag (overwrites remote changes)
 * - **Discard**: reload the server version
 * - **Merge**: (future) three-way merge UI — for now, shows diff and lets
 *   user choose
 */
export function ConflictBanner({ conflict, onResolved }: ConflictBannerProps) {
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
    <div
      className="flex items-center gap-3 border-b border-signal-amber bg-signal-amber/10 px-4 py-2 text-sm"
      role="alert"
    >
      <span className="flex-1 font-medium text-signal-amber">
        {messages.editorConflictBanner}
      </span>
      <div className="flex gap-2">
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
  );
}
