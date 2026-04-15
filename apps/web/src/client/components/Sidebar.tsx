import type { PageType } from "@ironlore/core";
import { messages } from "@ironlore/core";
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
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createFolder,
  createPage,
  deleteFolder,
  deletePage,
  fetchTree,
  movePage,
} from "../lib/api.js";
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

interface MenuState {
  path: string;
  type: PageType | "directory";
  name: string;
  x: number;
  y: number;
}

/** Pending inline-edit for a tree row (rename or new-in-folder). */
interface PendingEdit {
  kind: "rename" | "new-file" | "new-folder";
  parentPath: string; // directory containing the row
  targetPath?: string; // rename target (existing path)
  initial: string;
}

export function Sidebar() {
  const width = useAppStore((s) => s.sidebarWidth);
  const activePath = useAppStore((s) => s.activePath);
  const nodes = useTreeStore((s) => s.nodes);
  const expandedPaths = useTreeStore((s) => s.expandedPaths);
  const loading = useTreeStore((s) => s.loading);
  const treeRef = useRef<HTMLDivElement>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [edit, setEdit] = useState<PendingEdit | null>(null);

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

  // Close the context menu on outside click or Escape.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const handleSelect = useCallback((path: string, type: string) => {
    if (type === "directory") {
      useTreeStore.getState().toggleExpanded(path);
    } else {
      useAppStore.getState().setActivePath(path);
    }
  }, []);

  const handleDragStart = useCallback((e: React.DragEvent, path: string) => {
    e.dataTransfer.setData("text/plain", path);
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, path: string, isDir: boolean) => {
    if (!isDir) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTarget(path);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDropTarget(null);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent, targetDir: string) => {
    e.preventDefault();
    setDropTarget(null);
    const sourcePath = e.dataTransfer.getData("text/plain");
    if (!sourcePath) return;

    const fileName = sourcePath.includes("/")
      ? sourcePath.slice(sourcePath.lastIndexOf("/") + 1)
      : sourcePath;
    const destination = `${targetDir}/${fileName}`;

    if (sourcePath === destination) return;

    try {
      await movePage(sourcePath, destination);
    } catch {
      // Move failed — tree state is unchanged
    }
  }, []);

  const openMenu = useCallback(
    (e: React.MouseEvent, path: string, type: PageType | "directory", name: string) => {
      e.preventDefault();
      e.stopPropagation();
      setMenu({ path, type, name, x: e.clientX, y: e.clientY });
    },
    [],
  );

  const parentOf = useCallback((path: string): string => {
    const idx = path.lastIndexOf("/");
    return idx === -1 ? "" : path.slice(0, idx);
  }, []);

  const startRename = useCallback((path: string, name: string) => {
    setEdit({
      kind: "rename",
      parentPath: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
      targetPath: path,
      initial: name,
    });
  }, []);

  const startNewFile = useCallback((parentPath: string) => {
    setEdit({ kind: "new-file", parentPath, initial: "" });
    useTreeStore.getState().expandedPaths.add(parentPath);
  }, []);

  const startNewFolder = useCallback((parentPath: string) => {
    setEdit({ kind: "new-folder", parentPath, initial: "" });
    useTreeStore.getState().expandedPaths.add(parentPath);
  }, []);

  const commitEdit = useCallback(
    async (value: string) => {
      if (!edit) return;
      const trimmed = value.trim();
      if (!trimmed) {
        setEdit(null);
        return;
      }

      try {
        if (edit.kind === "rename" && edit.targetPath) {
          const dest = edit.parentPath ? `${edit.parentPath}/${trimmed}` : trimmed;
          if (dest === edit.targetPath) {
            setEdit(null);
            return;
          }
          await movePage(edit.targetPath, dest);
          if (useAppStore.getState().activePath === edit.targetPath) {
            useAppStore.getState().setActivePath(dest);
          }
        } else if (edit.kind === "new-file") {
          const fileName = trimmed.includes(".") ? trimmed : `${trimmed}.md`;
          const fullPath = edit.parentPath ? `${edit.parentPath}/${fileName}` : fileName;
          const title = fileName.replace(/\.md$/, "");
          await createPage(fullPath, `# ${title}\n`);
          useAppStore.getState().setActivePath(fullPath);
        } else if (edit.kind === "new-folder") {
          const fullPath = edit.parentPath ? `${edit.parentPath}/${trimmed}` : trimmed;
          await createFolder(fullPath);
        }
      } catch {
        // Failed — leave tree alone, close editor
      } finally {
        setEdit(null);
      }
    },
    [edit],
  );

  const handleDelete = useCallback(
    async (path: string, type: PageType | "directory", name: string) => {
      const template =
        type === "directory" ? messages.sidebarDeleteFolderConfirm : messages.sidebarDeleteFileConfirm;
      const confirmMsg = template.replace("{name}", name);
      if (!window.confirm(confirmMsg)) return;

      try {
        if (type === "directory") {
          await deleteFolder(path);
        } else {
          await deletePage(path);
        }
        if (useAppStore.getState().activePath === path) {
          useAppStore.getState().setActivePath(null);
        }
      } catch {
        // Delete failed — tree unchanged
      }
    },
    [],
  );

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
        case "F2": {
          e.preventDefault();
          const path = focused.dataset.path ?? "";
          const node = nodes.find((n) => n.path === path);
          if (node) startRename(node.path, node.name);
          break;
        }
        case "Delete":
        case "Backspace": {
          if (e.key === "Backspace" && !(e.metaKey || e.ctrlKey)) break;
          e.preventDefault();
          const path = focused.dataset.path ?? "";
          const node = nodes.find((n) => n.path === path);
          if (node) void handleDelete(node.path, node.type, node.name);
          break;
        }
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
    [nodes, expandedPaths, startRename, handleDelete],
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
        onContextMenu={(e) => {
          // Right-click on empty tree area → "new" menu anchored to root
          if (e.target === e.currentTarget) {
            e.preventDefault();
            setMenu({ path: "", type: "directory", name: "/", x: e.clientX, y: e.clientY });
          }
        }}
      >
        {loading ? (
          <p className="px-2 py-4 text-xs text-secondary">Loading...</p>
        ) : nodes.length === 0 && !edit ? (
          <p className="px-2 py-4 text-xs text-secondary">No pages yet</p>
        ) : (
          <>
            {nodes.map((node) => {
              const isDir = node.type === "directory";
              const isExpanded = expandedPaths.has(node.path);
              const isActive = activePath === node.path;
              const isRenaming = edit?.kind === "rename" && edit.targetPath === node.path;

              if (isRenaming) {
                return (
                  <InlineEditRow
                    key={node.id}
                    initial={edit.initial}
                    onCommit={commitEdit}
                    onCancel={() => setEdit(null)}
                  />
                );
              }

              return (
                <div
                  key={node.id}
                  role="treeitem"
                  tabIndex={isActive ? 0 : -1}
                  data-path={node.path}
                  aria-expanded={isDir ? isExpanded : undefined}
                  aria-selected={isActive}
                  draggable={!isDir}
                  className={`flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue ${
                    isActive
                      ? "bg-ironlore-slate-hover font-medium"
                      : dropTarget === node.path
                        ? "border border-ironlore-blue bg-ironlore-slate-hover"
                        : "hover:bg-ironlore-slate-hover"
                  }`}
                  onClick={() => handleSelect(node.path, node.type)}
                  onContextMenu={(e) => openMenu(e, node.path, node.type, node.name)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleSelect(node.path, node.type);
                    }
                  }}
                  onDragStart={(e) => handleDragStart(e, node.path)}
                  onDragOver={(e) => handleDragOver(e, node.path, isDir)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => {
                    if (isDir) handleDrop(e, node.path);
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
            })}
            {edit && edit.kind !== "rename" && (
              <InlineEditRow
                initial={edit.initial}
                onCommit={commitEdit}
                onCancel={() => setEdit(null)}
                placeholder={edit.kind === "new-folder" ? "folder-name" : "page-name"}
              />
            )}
          </>
        )}
      </div>

      {/* Context menu */}
      {menu && (
        <ContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onRename={() => {
            if (menu.path) startRename(menu.path, menu.name);
          }}
          onDelete={() => {
            if (menu.path) void handleDelete(menu.path, menu.type, menu.name);
          }}
          onNewFile={() => {
            const parent = menu.type === "directory" ? menu.path : parentOf(menu.path);
            startNewFile(parent);
          }}
          onNewFolder={() => {
            const parent = menu.type === "directory" ? menu.path : parentOf(menu.path);
            startNewFolder(parent);
          }}
        />
      )}

      {/* New page button */}
      <NewPageFooter />
    </nav>
  );
}

interface ContextMenuProps {
  menu: MenuState;
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
}

function ContextMenu({
  menu,
  onClose,
  onRename,
  onDelete,
  onNewFile,
  onNewFolder,
}: ContextMenuProps) {
  const isDir = menu.type === "directory";
  const isRoot = menu.path === "";

  const item = (
    label: string,
    onClick: () => void,
    opts: { danger?: boolean; disabled?: boolean } = {},
  ) => (
    <button
      type="button"
      disabled={opts.disabled}
      className={`block w-full px-3 py-1.5 text-left text-xs outline-none hover:bg-ironlore-slate-hover disabled:opacity-40 disabled:hover:bg-transparent ${
        opts.danger ? "text-red-400" : "text-primary"
      }`}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
        onClick();
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      role="menu"
      className="fixed z-50 min-w-40 rounded border border-border bg-ironlore-slate py-1 shadow-lg"
      style={{ left: menu.x, top: menu.y }}
      onClick={(e) => e.stopPropagation()}
    >
      {item(messages.sidebarNewFile, onNewFile, { disabled: !isDir && !isRoot })}
      {item(messages.sidebarNewFolder, onNewFolder, { disabled: !isDir && !isRoot })}
      {!isRoot && (
        <>
          <div className="my-1 border-t border-border" />
          {item(messages.sidebarRename, onRename)}
          {item(messages.sidebarDelete, onDelete, { danger: true })}
        </>
      )}
    </div>
  );
}

interface InlineEditRowProps {
  initial: string;
  placeholder?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

function InlineEditRow({ initial, placeholder, onCommit, onCancel }: InlineEditRowProps) {
  const [value, setValue] = useState(initial);

  return (
    <div className="flex items-center gap-1.5 px-2 py-1">
      <input
        ref={(el) => el?.focus()}
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit(value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => onCommit(value)}
        className="flex-1 rounded border border-ironlore-blue bg-transparent px-2 py-0.5 text-sm text-primary outline-none"
      />
    </div>
  );
}

function NewPageFooter() {
  const [creating, setCreating] = useState(false);
  const [pageName, setPageName] = useState("");
  const activePath = useAppStore((s) => s.activePath);

  const handleCreate = useCallback(async () => {
    const name = pageName.trim();
    if (!name) return;

    const activeNode = useTreeStore.getState().nodes.find((n) => n.path === activePath);
    let parentDir = "";
    if (activeNode) {
      parentDir =
        activeNode.type === "directory"
          ? activeNode.path
          : activeNode.path.includes("/")
            ? activeNode.path.slice(0, activeNode.path.lastIndexOf("/"))
            : "";
    }

    const fileName = name.endsWith(".md") ? name : `${name}.md`;
    const fullPath = parentDir ? `${parentDir}/${fileName}` : fileName;
    const title = name.replace(/\.md$/, "");

    try {
      await createPage(fullPath, `# ${title}\n`);
      useAppStore.getState().setActivePath(fullPath);
      setCreating(false);
      setPageName("");
    } catch {
      // Error creating page — stay in create mode
    }
  }, [pageName, activePath]);

  if (creating) {
    return (
      <div className="border-t border-border px-3 py-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleCreate();
          }}
          className="flex gap-1"
        >
          <input
            ref={(el) => el?.focus()}
            type="text"
            value={pageName}
            onChange={(e) => setPageName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setCreating(false);
                setPageName("");
              }
            }}
            placeholder="Page name"
            className="flex-1 rounded border border-border bg-transparent px-2 py-1 text-xs text-primary focus:border-ironlore-blue focus:outline-none"
          />
          <button
            type="submit"
            disabled={!pageName.trim()}
            className="rounded bg-ironlore-blue px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            Add
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="border-t border-border px-3 py-2">
      <button
        type="button"
        className="w-full rounded bg-ironlore-blue px-3 py-1.5 text-xs font-medium text-white"
        onClick={() => setCreating(true)}
      >
        {messages.sidebarNewPage}
      </button>
    </div>
  );
}
