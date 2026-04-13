import type { PageType } from "@ironlore/core";
import {
  ChevronDown,
  ChevronRight,
  FileCode,
  FileSpreadsheet,
  FileText,
  FileType,
  FolderClosed,
  Image,
  Music,
  Video,
  Workflow,
} from "lucide-react";
import type { KeyboardEvent } from "react";
import { useCallback, useEffect, useRef } from "react";
import { fetchTree } from "../lib/api.js";
import { useAppStore } from "../stores/app.js";
import { useTreeStore } from "../stores/tree.js";

/** Map PageType → Lucide icon component. */
function FileIcon({ type }: { type: PageType | "directory" }) {
  const cls = "h-4 w-4 shrink-0 text-secondary";
  switch (type) {
    case "directory":
      return <FolderClosed className={cls} />;
    case "markdown":
      return <FileText className={cls} />;
    case "pdf":
      return <FileType className={cls} />;
    case "csv":
      return <FileSpreadsheet className={cls} />;
    case "image":
      return <Image className={cls} />;
    case "video":
      return <Video className={cls} />;
    case "audio":
      return <Music className={cls} />;
    case "source-code":
      return <FileCode className={cls} />;
    case "mermaid":
      return <Workflow className={cls} />;
    default:
      return <FileText className={cls} />;
  }
}

export function Sidebar() {
  const width = useAppStore((s) => s.sidebarWidth);
  const activePath = useAppStore((s) => s.activePath);
  const nodes = useTreeStore((s) => s.nodes);
  const expandedPaths = useTreeStore((s) => s.expandedPaths);
  const loading = useTreeStore((s) => s.loading);
  const treeRef = useRef<HTMLDivElement>(null);

  // Load tree on mount
  useEffect(() => {
    useTreeStore.getState().setLoading(true);
    fetchTree()
      .then(({ pages }) => {
        useTreeStore.getState().setNodes(
          pages.map((p) => ({
            id: p.path,
            name: p.name,
            path: p.path,
            type: p.type,
          })),
        );
      })
      .catch(() => {
        // Network error — leave tree empty
      })
      .finally(() => {
        useTreeStore.getState().setLoading(false);
      });
  }, []);

  const handleSelect = useCallback((path: string, type: string) => {
    if (type === "directory") {
      useTreeStore.getState().toggleExpanded(path);
    } else {
      useAppStore.getState().setActivePath(path);
    }
  }, []);

  // -------------------------------------------------------------------------
  // Keyboard navigation (WCAG: role="tree" + arrow keys)
  // -------------------------------------------------------------------------
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const items = treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]');
      if (!items || items.length === 0) return;

      const focused = document.activeElement as HTMLElement;
      const idx = Array.from(items).indexOf(focused);
      if (idx === -1) return;

      let next: HTMLElement | null = null;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          next = items[idx + 1] ?? null;
          break;
        case "ArrowUp":
          e.preventDefault();
          next = items[idx - 1] ?? null;
          break;
        case "Home":
          e.preventDefault();
          next = items[0] ?? null;
          break;
        case "End":
          e.preventDefault();
          next = items[items.length - 1] ?? null;
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          focused.click();
          break;
        case "ArrowRight": {
          e.preventDefault();
          const path = focused.dataset.path ?? "";
          const node = nodes.find((n) => n.path === path);
          if (node && node.type === "directory" && !expandedPaths.has(path)) {
            useTreeStore.getState().toggleExpanded(path);
          } else {
            next = items[idx + 1] ?? null;
          }
          break;
        }
        case "ArrowLeft": {
          e.preventDefault();
          const path = focused.dataset.path ?? "";
          const node = nodes.find((n) => n.path === path);
          if (node && node.type === "directory" && expandedPaths.has(path)) {
            useTreeStore.getState().toggleExpanded(path);
          } else {
            next = items[idx - 1] ?? null;
          }
          break;
        }
      }

      next?.focus();
    },
    [nodes, expandedPaths],
  );

  return (
    <nav
      className="flex flex-col border-r border-border bg-ironlore-slate"
      style={{ width: `${width}px`, minWidth: "220px", maxWidth: "420px" }}
      aria-label="Page tree"
    >
      {/* Search trigger */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          className="flex-1 rounded bg-ironlore-slate-hover px-3 py-1.5 text-left text-xs text-secondary"
          aria-label="Search pages"
          onClick={() => useAppStore.getState().toggleSearchDialog()}
        >
          Search pages...
        </button>
        <kbd className="text-[10px] text-secondary">&#8984;K</kbd>
      </div>

      {/* Tree */}
      <div
        ref={treeRef}
        className="flex-1 overflow-y-auto px-2 py-1"
        role="tree"
        onKeyDown={handleKeyDown}
      >
        {loading ? (
          <p className="px-2 py-4 text-xs text-secondary">Loading...</p>
        ) : nodes.length === 0 ? (
          <p className="px-2 py-4 text-xs text-secondary">No pages yet</p>
        ) : (
          nodes.map((node) => {
            const isDir = node.type === "directory";
            const isExpanded = expandedPaths.has(node.path);
            const isActive = activePath === node.path;

            return (
              <div
                key={node.id}
                role="treeitem"
                tabIndex={isActive ? 0 : -1}
                data-path={node.path}
                aria-expanded={isDir ? isExpanded : undefined}
                aria-selected={isActive}
                className={`flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue ${
                  isActive ? "bg-ironlore-slate-hover font-medium" : "hover:bg-ironlore-slate-hover"
                }`}
                onClick={() => handleSelect(node.path, node.type)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleSelect(node.path, node.type);
                  }
                }}
              >
                {isDir ? (
                  isExpanded ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-secondary" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-secondary" />
                  )
                ) : (
                  <FileIcon type={node.type} />
                )}
                <span className="truncate">{node.name}</span>
              </div>
            );
          })
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
    </nav>
  );
}
