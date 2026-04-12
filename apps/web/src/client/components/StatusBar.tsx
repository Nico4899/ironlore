import { useAppStore } from "../stores/app.js";
import { useEditorStore } from "../stores/editor.js";

export function StatusBar() {
  const activePath = useAppStore((s) => s.activePath);
  const wsConnected = useAppStore((s) => s.wsConnected);
  const editorStatus = useEditorStore((s) => s.status);

  return (
    <footer className="flex h-6 items-center border-t border-border bg-ironlore-slate px-3 text-[11px] text-secondary">
      {activePath && (
        <button
          type="button"
          className="hover:text-primary"
          onClick={() => navigator.clipboard.writeText(activePath)}
          title="Copy file path"
        >
          {activePath}
        </button>
      )}
      <div className="flex-1" />
      <div className="flex items-center gap-3">
        <span>
          {editorStatus === "dirty" ? "Unsaved" : editorStatus === "syncing" ? "Saving..." : ""}
        </span>
        <span className={wsConnected ? "text-signal-green" : "text-signal-red"}>
          {wsConnected ? "Connected" : "Disconnected"}
        </span>
      </div>
    </footer>
  );
}
