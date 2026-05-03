import { messages } from "@ironlore/core/messages";
import { useMemo, useState } from "react";
import type { ConflictResponse } from "../../lib/api.js";
import { fetchPage, getApiProject } from "../../lib/api.js";
import {
  applyResolutions,
  type ConflictChoice,
  type ConflictResolution,
  diffBlocks,
  type MergeSegment,
} from "../../lib/merge-blocks.js";
import { splitFrontmatter, useEditorStore } from "../../stores/editor.js";

interface ConflictBannerProps {
  conflict: ConflictResponse;
  onResolved: () => void;
}

/**
 * Block-level merge UI shown on a 409 during auto-save.
 *
 * Splits local and remote markdown into block segments using stable block
 * IDs, presents each conflicting block side-by-side, and lets the user
 * pick yours / theirs / keep-both / custom per conflict. Non-conflicting
 * blocks (one-sided additions, identical blocks) auto-merge.
 *
 * Two escape hatches remain for cases the block merger can't handle
 * cleanly: "Keep mine" force-saves the local version and "Discard" pulls
 * the server version wholesale.
 */
export function ConflictBanner({ conflict, onResolved }: ConflictBannerProps) {
  const localMarkdown = useEditorStore((s) => s.markdown);

  // `localMarkdown` is body-only (the editor store stripped the
  //  frontmatter on load). `conflict.currentContent` is the full
  //  server-side page including frontmatter. Strip the server copy
  //  too so the block-diff compares body-to-body rather than
  //  flagging a synthetic frontmatter "change" every time.
  const serverBody = useMemo(
    () => splitFrontmatter(conflict.currentContent).body,
    [conflict.currentContent],
  );

  const segments = useMemo(
    () => diffBlocks(localMarkdown, serverBody),
    [localMarkdown, serverBody],
  );
  const conflictSegments = segments.filter((s) => s.kind === "conflict");

  const [resolutions, setResolutions] = useState<Map<string, ConflictResolution>>(new Map());
  const unresolvedCount = conflictSegments.filter((s) => !resolutions.has(s.id)).length;

  const setResolution = (id: string, choice: ConflictChoice, customText?: string) => {
    setResolutions((prev) => {
      const next = new Map(prev);
      next.set(id, { choice, customText });
      return next;
    });
  };

  const handleSaveMerged = async () => {
    const { filePath, frontmatter, setEtag, setStatus, setMarkdown } = useEditorStore.getState();
    if (!filePath) return;

    const { markdown, hasUnresolvedConflicts } = applyResolutions(segments, resolutions);
    if (hasUnresolvedConflicts) return;

    // Re-prepend the local frontmatter so the on-disk copy keeps
    //  its YAML block. A frontmatter *conflict* is out of scope
    //  for the block-level merge UI; using the local copy here
    //  matches "Keep mine" semantics for metadata specifically.
    const payload = frontmatter + markdown;

    const res = await fetch(`/api/projects/${getApiProject()}/pages/${filePath}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": conflict.currentEtag,
      },
      body: JSON.stringify({ markdown: payload }),
    });

    if (res.ok) {
      const { etag } = (await res.json()) as { etag: string };
      // Store body-only in the editor — the store's `markdown`
      //  field is semantically body-only now.
      setMarkdown(markdown);
      setEtag(etag);
      setStatus("clean");
      onResolved();
    }
  };

  const handleKeepMine = async () => {
    const { filePath, getFullContent, setEtag, setStatus } = useEditorStore.getState();
    if (!filePath) return;

    // Full on-disk shape (frontmatter + body) so a "keep mine"
    //  never clobbers the YAML block.
    const payload = getFullContent();

    const res = await fetch(`/api/projects/${getApiProject()}/pages/${filePath}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": conflict.currentEtag,
      },
      body: JSON.stringify({ markdown: payload }),
    });

    if (res.ok) {
      const { etag } = (await res.json()) as { etag: string };
      setEtag(etag);
      setStatus("clean");
      onResolved();
    }
  };

  const handleDiscard = async () => {
    const { filePath, fileType, setFile } = useEditorStore.getState();
    if (!filePath) return;
    const page = await fetchPage(filePath);
    setFile(filePath, page.content, page.etag, fileType ?? "markdown");
    onResolved();
  };

  const title = messages.editorMergeTitle.replace("{count}", String(conflictSegments.length));

  return (
    <div className="border-b border-signal-amber bg-signal-amber/10" role="alert">
      <div className="flex items-center gap-3 px-4 py-2 text-sm">
        <span className="flex-1 font-medium text-signal-amber">
          {conflictSegments.length > 0 ? title : messages.editorConflictBanner}
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
            className="rounded border border-border px-3 py-1 text-xs hover:bg-ironlore-slate-hover"
            onClick={handleKeepMine}
          >
            {messages.editorKeepMine}
          </button>
          <button
            type="button"
            disabled={unresolvedCount > 0}
            className="rounded bg-ironlore-blue px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
            onClick={handleSaveMerged}
          >
            {messages.editorMergeSave}
          </button>
        </div>
      </div>

      {unresolvedCount > 0 && (
        <p className="px-4 pb-2 text-xs text-signal-amber">
          {messages.editorMergeUnresolved.replace("{count}", String(unresolvedCount))}
        </p>
      )}

      <div className="max-h-[60vh] space-y-3 overflow-y-auto px-4 pb-4">
        {segments.map((seg) => (
          <SegmentRow
            key={seg.id}
            segment={seg}
            resolution={resolutions.get(seg.id)}
            onResolve={setResolution}
          />
        ))}
      </div>
    </div>
  );
}

interface SegmentRowProps {
  segment: MergeSegment;
  resolution: ConflictResolution | undefined;
  onResolve: (id: string, choice: ConflictChoice, customText?: string) => void;
}

function SegmentRow({ segment, resolution, onResolve }: SegmentRowProps) {
  const [customText, setCustomText] = useState(segment.local ?? segment.remote ?? "");
  const [editing, setEditing] = useState(false);

  if (segment.kind === "common") {
    // Hide fully-common segments to keep the merge view focused.
    return null;
  }

  if (segment.kind === "only-local" || segment.kind === "only-remote") {
    const side = segment.kind === "only-local" ? "you" : "them";
    const text = segment.local ?? segment.remote ?? "";
    return (
      <div className="rounded border border-border bg-ironlore-slate p-2 text-xs">
        <p className="mb-1 text-secondary">
          {messages.editorMergeBlockAdded.replace("{side}", side)} · {segment.blockType ?? "block"}
        </p>
        <pre className="whitespace-pre-wrap font-mono text-xs text-primary">{text}</pre>
      </div>
    );
  }

  const choice = resolution?.choice;

  return (
    <div className="rounded border border-signal-amber bg-ironlore-slate p-2 text-xs">
      <p className="mb-2 font-medium text-signal-amber">
        Conflict · {segment.blockType ?? "block"} ·{" "}
        <code className="text-secondary">{segment.id}</code>
      </p>
      <div className="grid grid-cols-2 gap-2">
        <ChoicePanel
          label={messages.editorMergeYoursLabel}
          text={segment.local ?? ""}
          selected={choice === "local"}
          onSelect={() => onResolve(segment.id, "local")}
        />
        <ChoicePanel
          label={messages.editorMergeTheirsLabel}
          text={segment.remote ?? ""}
          selected={choice === "remote"}
          onSelect={() => onResolve(segment.id, "remote")}
        />
      </div>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          className={`rounded border px-2 py-1 text-xs ${choice === "both" ? "border-ironlore-blue" : "border-border"}`}
          onClick={() => onResolve(segment.id, "both")}
        >
          {messages.editorMergeKeepBoth}
        </button>
        <button
          type="button"
          className={`rounded border px-2 py-1 text-xs ${editing || choice === "custom" ? "border-ironlore-blue" : "border-border"}`}
          onClick={() => setEditing((v) => !v)}
        >
          {messages.editorMergeEdit}
        </button>
      </div>
      {editing && (
        <div className="mt-2">
          <textarea
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            aria-label="Custom merged text for this block"
            className="h-24 w-full rounded border border-border bg-background p-2 font-mono text-xs text-primary outline-none focus:border-ironlore-blue"
          />
          <button
            type="button"
            className="mt-1 rounded bg-ironlore-blue px-2 py-1 text-xs text-white"
            onClick={() => {
              onResolve(segment.id, "custom", customText);
              setEditing(false);
            }}
          >
            Use this
          </button>
        </div>
      )}
    </div>
  );
}

interface ChoicePanelProps {
  label: string;
  text: string;
  selected: boolean;
  onSelect: () => void;
}

function ChoicePanel({ label, text, selected, onSelect }: ChoicePanelProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`text-left rounded border p-2 ${selected ? "border-ironlore-blue bg-ironlore-slate-hover" : "border-border hover:bg-ironlore-slate-hover"}`}
    >
      <p className="mb-1 font-medium text-secondary">{label}</p>
      <pre className="whitespace-pre-wrap font-mono text-xs text-primary">{text}</pre>
    </button>
  );
}
