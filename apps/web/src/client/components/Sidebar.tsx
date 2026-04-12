import { useAppStore } from "../stores/app.js";
import { useTreeStore } from "../stores/tree.js";

export function Sidebar() {
  const width = useAppStore((s) => s.sidebarWidth);
  const nodes = useTreeStore((s) => s.nodes);
  const loading = useTreeStore((s) => s.loading);

  return (
    <aside
      className="flex flex-col border-r border-border bg-ironlore-slate"
      style={{ width: `${width}px`, minWidth: "220px", maxWidth: "420px" }}
      role="navigation"
      aria-label="Page tree"
    >
      {/* Search trigger */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          className="flex-1 rounded bg-ironlore-slate-hover px-3 py-1.5 text-left text-xs text-secondary"
        >
          Search pages...
        </button>
        <kbd className="text-[10px] text-secondary">&#8984;K</kbd>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto px-2 py-1" role="tree">
        {loading ? (
          <p className="px-2 py-4 text-xs text-secondary">Loading...</p>
        ) : nodes.length === 0 ? (
          <p className="px-2 py-4 text-xs text-secondary">No pages yet</p>
        ) : (
          nodes.map((node) => (
            <div key={node.id} role="treeitem" className="px-2 py-1 text-sm">
              {node.name}
            </div>
          ))
        )}
      </div>

      {/* New page button */}
      <div className="border-t border-border px-3 py-2">
        <button
          type="button"
          className="w-full rounded bg-ironlore-blue px-3 py-1.5 text-xs font-medium text-white"
        >
          New page
        </button>
      </div>
    </aside>
  );
}
