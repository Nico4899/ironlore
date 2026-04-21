import { Eye, EyeOff } from "lucide-react";
import { useAIPanelStore } from "../../stores/ai-panel.js";
import { useEditorStore } from "../../stores/editor.js";

/**
 * Opened-file-as-context toggle — eye icon + current filename. When
 * the toggle is on, `AIPanel`'s send handler appends the active
 * editor file as a context pill on dispatch (see `handleSend` in
 * AIPanel.tsx). When no file is open, the toggle renders a muted
 * "no file open" label so the spot isn't empty.
 *
 * Persisted via the `includeActiveFileAsContext` store field (see
 * apps/web/src/client/stores/ai-panel.ts), default on.
 */

export function OpenedFileToggle() {
  const filePath = useEditorStore((s) => s.filePath);
  const include = useAIPanelStore((s) => s.includeActiveFileAsContext);
  const setInclude = useAIPanelStore((s) => s.setIncludeActiveFileAsContext);

  const baseName = filePath ? (filePath.split("/").pop() ?? filePath) : null;
  const hasFile = baseName !== null;
  const active = hasFile && include;

  const label = hasFile ? baseName : "no file open";
  const title = !hasFile
    ? "No file is currently open"
    : active
      ? `${baseName} will be sent as context. Click to disable.`
      : `${baseName} will NOT be sent. Click to enable.`;

  return (
    <button
      type="button"
      onClick={() => {
        if (!hasFile) return;
        setInclude(!include);
      }}
      disabled={!hasFile}
      aria-pressed={active}
      title={title}
      className="font-mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 6px",
        background: active ? "var(--il-slate-elev)" : "transparent",
        border: `1px solid ${active ? "var(--il-border-soft)" : "transparent"}`,
        borderRadius: 3,
        fontSize: 10.5,
        letterSpacing: "0.02em",
        color: !hasFile ? "var(--il-text4)" : active ? "var(--il-text2)" : "var(--il-text3)",
        cursor: hasFile ? "pointer" : "not-allowed",
        maxWidth: 160,
      }}
    >
      <span aria-hidden="true" style={{ display: "inline-flex" }}>
        {active ? <Eye size={11} /> : <EyeOff size={11} />}
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
    </button>
  );
}
