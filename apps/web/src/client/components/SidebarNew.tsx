import type { PageType } from "@ironlore/core";
import {
  BookOpen,
  Captions,
  ChevronLeft,
  ChevronRight,
  Compass,
  FileCode,
  FilePlus,
  FileSpreadsheet,
  FileText,
  FileType,
  FolderClosed,
  FolderPlus,
  Home,
  Image,
  Inbox,
  LogOut,
  Mail,
  MessageSquare,
  Moon,
  Music,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Sun,
  TerminalSquare,
  Video,
  Workflow,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createFolder,
  createPage,
  deleteFolder,
  deletePage,
  fetchTree,
  logout,
  movePage,
} from "../lib/api.js";
import { useAppStore } from "../stores/app.js";
import { useAuthStore } from "../stores/auth.js";
import { useTreeStore } from "../stores/tree.js";

// ---------------------------------------------------------------------------
// File icon
// ---------------------------------------------------------------------------

function FileIcon({ type }: { type: PageType | "directory" }) {
  const base = "h-4 w-4 shrink-0";
  switch (type) {
    case "directory":
      return <FolderClosed className={`${base} icon-folder`} />;
    case "markdown":
      return <FileText className={`${base} icon-markdown`} />;
    case "pdf":
      return <FileType className={`${base} icon-pdf`} />;
    case "csv":
      return <FileSpreadsheet className={`${base} icon-csv`} />;
    case "image":
      return <Image className={`${base} icon-image`} />;
    case "video":
      return <Video className={`${base} icon-video`} />;
    case "audio":
      return <Music className={`${base} icon-audio`} />;
    case "source-code":
      return <FileCode className={`${base} icon-code`} />;
    case "mermaid":
      return <Workflow className={`${base} icon-mermaid`} />;
    case "text":
      return <FileText className={`${base} icon-text`} />;
    case "transcript":
      return <Captions className={`${base} icon-markdown`} />;
    case "word":
      return <FileType className={`${base} icon-word`} />;
    case "excel":
      return <FileSpreadsheet className={`${base} icon-excel`} />;
    case "email":
      return <Mail className={`${base} icon-email`} />;
    case "notebook":
      return <BookOpen className={`${base} icon-notebook`} />;
    default:
      return <FileText className={`${base} text-secondary`} />;
  }
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

interface ContextMenuState {
  x: number;
  y: number;
  /** The folder to create items in, or "" for root. */
  targetFolder: string;
  /** If right-clicked on a specific item, its path and type. */
  itemPath?: string;
  itemType?: PageType | "directory";
  itemName?: string;
}

// ---------------------------------------------------------------------------
// Main Sidebar component
// ---------------------------------------------------------------------------

export function SidebarNew() {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const sidebarFolder = useAppStore((s) => s.sidebarFolder);
  const sidebarTab = useAppStore((s) => s.sidebarTab);
  const theme = useAppStore((s) => s.theme);
  const activePath = useAppStore((s) => s.activePath);
  const nodes = useTreeStore((s) => s.nodes);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [creatingType, setCreatingType] = useState<"file" | "folder" | null>(null);
  const [creatingName, setCreatingName] = useState("");
  const [slideDir, setSlideDir] = useState<"left" | "right" | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Load tree on mount
  useEffect(() => {
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
      .catch(() => {});
  }, []);

  // Items visible at the current folder level
  const visibleItems = useMemo(() => {
    const prefix = sidebarFolder ? `${sidebarFolder}/` : "";
    return nodes
      .filter((n) => {
        if (sidebarFolder === "") {
          // Root level: items with no "/" in path
          return !n.path.includes("/");
        }
        // Items directly inside the current folder
        if (!n.path.startsWith(prefix)) return false;
        const rest = n.path.slice(prefix.length);
        return !rest.includes("/");
      })
      .sort((a, b) => {
        // Folders first
        const aDir = a.type === "directory" ? 0 : 1;
        const bDir = b.type === "directory" ? 0 : 1;
        if (aDir !== bDir) return aDir - bDir;
        return a.name.localeCompare(b.name);
      });
  }, [nodes, sidebarFolder]);

  // Drill into a folder with animation
  const drillInto = useCallback((folderPath: string) => {
    setSlideDir("left");
    setTimeout(() => {
      useAppStore.getState().setSidebarFolder(folderPath);
      setSlideDir(null);
    }, 150);
  }, []);

  // Navigate up one level
  const drillUp = useCallback(() => {
    setSlideDir("right");
    setTimeout(() => {
      const parts = sidebarFolder.split("/");
      parts.pop();
      useAppStore.getState().setSidebarFolder(parts.join("/"));
      setSlideDir(null);
    }, 150);
  }, [sidebarFolder]);

  // Navigate to root
  const drillToRoot = useCallback(() => {
    setSlideDir("right");
    setTimeout(() => {
      useAppStore.getState().setSidebarFolder("");
      setSlideDir(null);
    }, 150);
  }, []);

  // Click a file → open it
  const openFile = useCallback((path: string) => {
    useAppStore.getState().setActivePath(path);
  }, []);

  // Create new page
  const handleNewPage = useCallback(async () => {
    const folder = sidebarFolder;
    const name = "Untitled";
    const path = folder ? `${folder}/${name}.md` : `${name}.md`;
    try {
      await createPage(path, `# ${name}\n`);
      useAppStore.getState().setActivePath(path);
      setEditingPath(path);
      setEditingValue(name);
    } catch {
      // Creation failed
    }
  }, [sidebarFolder]);

  // Create new folder
  const handleNewFolder = useCallback(async () => {
    const folder = sidebarFolder;
    const name = "Untitled";
    const path = folder ? `${folder}/${name}` : name;
    try {
      await createFolder(path);
      setEditingPath(path);
      setEditingValue(name);
    } catch {
      // Creation failed
    }
  }, [sidebarFolder]);

  // Rename commit
  const commitRename = useCallback(async (oldPath: string, newName: string) => {
    if (!newName.trim()) {
      setEditingPath(null);
      return;
    }
    const parts = oldPath.split("/");
    parts[parts.length - 1] = newName;
    const newPath = parts.join("/");
    if (newPath !== oldPath) {
      try {
        await movePage(oldPath, newPath);
      } catch {
        // Rename failed
      }
    }
    setEditingPath(null);
  }, []);

  // Delete item
  const handleDelete = useCallback(
    async (path: string, type: PageType | "directory", name: string) => {
      const msg =
        type === "directory"
          ? `Delete folder "${name}" and all its contents?`
          : `Delete "${name}"?`;
      if (!window.confirm(msg)) return;
      try {
        if (type === "directory") {
          await deleteFolder(path);
        } else {
          await deletePage(path);
        }
      } catch {
        // Delete failed
      }
    },
    [],
  );

  // Right-click context menu
  const handleContextMenu = useCallback(
    (
      e: React.MouseEvent,
      itemPath?: string,
      itemType?: PageType | "directory",
      itemName?: string,
    ) => {
      e.preventDefault();
      const targetFolder = itemType === "directory" && itemPath ? itemPath : sidebarFolder;
      setContextMenu({ x: e.clientX, y: e.clientY, targetFolder, itemPath, itemType, itemName });
    },
    [sidebarFolder],
  );

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu]);

  // Context menu create in folder
  const ctxNewFile = useCallback(async () => {
    if (!contextMenu) return;
    const folder = contextMenu.targetFolder;
    const name = "Untitled";
    const path = folder ? `${folder}/${name}.md` : `${name}.md`;
    setContextMenu(null);
    try {
      await createPage(path, `# ${name}\n`);
      // If created in a subfolder, drill into it
      if (folder && folder !== sidebarFolder) {
        useAppStore.getState().setSidebarFolder(folder);
      }
      useAppStore.getState().setActivePath(path);
      setEditingPath(path);
      setEditingValue(name);
    } catch {
      /* */
    }
  }, [contextMenu, sidebarFolder]);

  const ctxNewFolder = useCallback(async () => {
    if (!contextMenu) return;
    const folder = contextMenu.targetFolder;
    const name = "Untitled";
    const path = folder ? `${folder}/${name}` : name;
    setContextMenu(null);
    try {
      await createFolder(path);
      if (folder && folder !== sidebarFolder) {
        useAppStore.getState().setSidebarFolder(folder);
      }
      setEditingPath(path);
      setEditingValue(name);
    } catch {
      /* */
    }
  }, [contextMenu, sidebarFolder]);

  const ctxRename = useCallback(() => {
    if (!contextMenu?.itemPath || !contextMenu.itemName) return;
    setEditingPath(contextMenu.itemPath);
    setEditingValue(contextMenu.itemName);
    setContextMenu(null);
  }, [contextMenu]);

  const ctxDelete = useCallback(() => {
    if (!contextMenu?.itemPath || !contextMenu.itemType || !contextMenu.itemName) return;
    handleDelete(contextMenu.itemPath, contextMenu.itemType, contextMenu.itemName);
    setContextMenu(null);
  }, [contextMenu, handleDelete]);

  // Logout
  const handleLogout = useCallback(async () => {
    try {
      await logout();
      useAuthStore.getState().checkSession();
    } catch {
      /* */
    }
  }, []);

  const collapsed = !sidebarOpen;
  const inboxCount = 2; // Placeholder badge

  return (
    <aside
      className={`sidebar-chrome flex h-full shrink-0 flex-col transition-all ${
        collapsed ? "w-14" : "w-64"
      }`}
    >
      {/* ─── Top: Logo + name + collapse ─── */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        {/* Logo — three overlapping circles */}
        <div className="flex h-6 w-6 shrink-0 items-center justify-center">
          <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
            <circle cx="9" cy="10" r="6" fill="oklch(0.65 0.18 250)" opacity="0.7" />
            <circle cx="15" cy="10" r="6" fill="oklch(0.65 0.15 160)" opacity="0.7" />
            <circle cx="12" cy="15" r="6" fill="oklch(0.70 0.15 80)" opacity="0.7" />
          </svg>
        </div>
        {!collapsed && (
          <span className="text-sm font-semibold tracking-tight text-primary">ironlore</span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => useAppStore.getState().toggleSidebar()}
          className="rounded p-1 text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" />
          ) : (
            <PanelLeftClose className="h-4 w-4" />
          )}
        </button>
      </div>

      {/* ─── Tabs: Home / Search / Explore ─── */}
      {!collapsed && (
        <div className="flex border-b border-border">
          {[
            { id: "home" as const, icon: Home, label: "Home" },
            { id: "search" as const, icon: Search, label: "Search" },
            { id: "explore" as const, icon: Compass, label: "Explore" },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => useAppStore.getState().setSidebarTab(tab.id)}
              className={`flex flex-1 items-center justify-center gap-1.5 py-2 text-xs ${
                sidebarTab === tab.id
                  ? "border-b-2 border-ironlore-blue font-medium text-primary"
                  : "text-secondary hover:text-primary"
              }`}
            >
              <tab.icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* ─── Folder breadcrumb (when drilled in) ─── */}
      {!collapsed && sidebarFolder && sidebarTab === "home" && (
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5 text-xs text-secondary">
          <button
            type="button"
            onClick={drillToRoot}
            className="rounded p-0.5 hover:bg-ironlore-slate-hover hover:text-primary"
            title="Go to root"
          >
            <Home className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={drillUp}
            className="rounded p-0.5 hover:bg-ironlore-slate-hover hover:text-primary"
            title="Go up one level"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="truncate font-medium text-primary">
            {sidebarFolder.split("/").pop()}
          </span>
        </div>
      )}

      {/* ─── File/folder list (scrollable) ─── */}
      {!collapsed && sidebarTab === "home" && (
        // biome-ignore lint/a11y/noStaticElementInteractions: context menu on container
        <div
          ref={listRef}
          className={`flex-1 overflow-y-auto px-1 py-1 transition-transform duration-150 ${
            slideDir === "left"
              ? "-translate-x-full opacity-0"
              : slideDir === "right"
                ? "translate-x-full opacity-0"
                : "translate-x-0 opacity-100"
          }`}
          onContextMenu={(e) => handleContextMenu(e)}
        >
          {visibleItems.length === 0 && !creatingType && (
            <div className="py-8 text-center text-xs text-secondary">No pages yet</div>
          )}
          {visibleItems.map((item) => {
            const isDir = item.type === "directory";
            const isActive = activePath === item.path;
            const isEditing = editingPath === item.path;

            return (
              // biome-ignore lint/a11y/useSemanticElements: complex interactive row with context menu
              <div
                key={item.path}
                className={`group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-all duration-100 ${
                  isActive
                    ? "sidebar-item-active text-primary"
                    : "text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
                }`}
                onClick={() => {
                  if (isEditing) return;
                  if (isDir) {
                    drillInto(item.path);
                  } else {
                    openFile(item.path);
                  }
                }}
                onContextMenu={(e) => {
                  e.stopPropagation();
                  handleContextMenu(e, item.path, item.type, item.name);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !isEditing) {
                    if (isDir) drillInto(item.path);
                    else openFile(item.path);
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <FileIcon type={item.type} />
                {isEditing ? (
                  <input
                    className="flex-1 rounded border border-ironlore-blue bg-transparent px-1 text-sm text-primary focus:outline-none"
                    value={editingValue}
                    onChange={(e) => setEditingValue(e.target.value)}
                    onBlur={() => commitRename(item.path, editingValue)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename(item.path, editingValue);
                      if (e.key === "Escape") setEditingPath(null);
                    }}
                    // biome-ignore lint/a11y/noAutofocus: inline rename needs immediate focus
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="flex-1 truncate">{item.name}</span>
                )}
                {isDir && !isEditing && (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-secondary opacity-0 group-hover:opacity-100" />
                )}
              </div>
            );
          })}

          {/* Inline creation */}
          {creatingType && (
            <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm">
              {creatingType === "folder" ? (
                <FolderClosed className="h-4 w-4 shrink-0 text-secondary" />
              ) : (
                <FileText className="h-4 w-4 shrink-0 text-secondary" />
              )}
              <input
                className="flex-1 rounded border border-ironlore-blue bg-transparent px-1 text-sm text-primary focus:outline-none"
                value={creatingName}
                onChange={(e) => setCreatingName(e.target.value)}
                onBlur={async () => {
                  if (creatingName.trim()) {
                    if (creatingType === "folder") {
                      const path = sidebarFolder
                        ? `${sidebarFolder}/${creatingName}`
                        : creatingName;
                      try {
                        await createFolder(path);
                      } catch {
                        /* */
                      }
                    } else {
                      const name = creatingName.endsWith(".md")
                        ? creatingName
                        : `${creatingName}.md`;
                      const path = sidebarFolder ? `${sidebarFolder}/${name}` : name;
                      try {
                        await createPage(path, `# ${creatingName.replace(/\.md$/, "")}\n`);
                        useAppStore.getState().setActivePath(path);
                      } catch {
                        /* */
                      }
                    }
                  }
                  setCreatingType(null);
                  setCreatingName("");
                }}
                onKeyDown={async (e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") {
                    setCreatingType(null);
                    setCreatingName("");
                  }
                }}
                placeholder="Untitled"
                // biome-ignore lint/a11y/noAutofocus: inline creation needs immediate focus
                autoFocus
              />
            </div>
          )}
        </div>
      )}

      {/* Search tab content */}
      {!collapsed && sidebarTab === "search" && (
        <div className="flex flex-1 items-center justify-center px-4 text-xs text-secondary">
          <button
            type="button"
            onClick={() => useAppStore.getState().toggleSearchDialog()}
            className="flex items-center gap-2 rounded-lg border border-border px-4 py-2 hover:bg-ironlore-slate-hover"
          >
            <Search className="h-4 w-4" />
            Search
          </button>
        </div>
      )}

      {/* Explore tab content (placeholder) */}
      {!collapsed && sidebarTab === "explore" && (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-secondary">
          Explore your knowledge graph. Coming soon.
        </div>
      )}

      {/* Collapsed: just icons for tabs */}
      {collapsed && (
        <div className="flex flex-1 flex-col items-center gap-1 py-2">
          <button
            type="button"
            onClick={() => {
              useAppStore.getState().toggleSidebar();
              useAppStore.getState().setSidebarTab("home");
            }}
            className="rounded p-2 text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
            title="Home"
          >
            <Home className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => useAppStore.getState().toggleSearchDialog()}
            className="rounded p-2 text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
            title="Search"
          >
            <Search className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              useAppStore.getState().toggleSidebar();
              useAppStore.getState().setSidebarTab("explore");
            }}
            className="rounded p-2 text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
            title="Explore"
          >
            <Compass className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* ─── Divider ─── */}
      <div className="border-t border-border" />

      {/* ─── Fixed bottom section ─── */}
      <div className="flex flex-col gap-0.5 px-1 py-1.5">
        {/* Agent Inbox */}
        <SidebarBottomTab
          icon={Inbox}
          label="Inbox"
          collapsed={collapsed}
          badge={inboxCount}
          onClick={() => useAppStore.getState().toggleInbox()}
        />
        {/* AI Panel */}
        <SidebarBottomTab
          icon={({ className }: { className?: string }) => (
            <svg
              viewBox="0 0 24 24"
              className={className}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <title>AI</title>
              <path d="M12 3v2m0 14v2M5.6 5.6l1.4 1.4m10 10l1.4 1.4M3 12h2m14 0h2M5.6 18.4l1.4-1.4m10-10l1.4-1.4" />
              <circle cx="12" cy="12" r="4" />
            </svg>
          )}
          label="AI"
          collapsed={collapsed}
          onClick={() => useAppStore.getState().toggleAIPanel()}
        />
        {/* Terminal */}
        <SidebarBottomTab
          icon={TerminalSquare}
          label="Terminal"
          collapsed={collapsed}
          onClick={() => useAppStore.getState().toggleTerminal()}
        />
        {/* Feedback (placeholder) */}
        <SidebarBottomTab
          icon={MessageSquare}
          label="Feedback"
          collapsed={collapsed}
          onClick={() => {}}
        />
        {/* Theme toggle */}
        <SidebarBottomTab
          icon={theme === "dark" ? Sun : Moon}
          label={theme === "dark" ? "Light mode" : "Dark mode"}
          collapsed={collapsed}
          onClick={() => useAppStore.getState().toggleTheme()}
        />
        {/* Logout */}
        <SidebarBottomTab
          icon={LogOut}
          label="Log out"
          collapsed={collapsed}
          onClick={handleLogout}
        />
      </div>

      {/* ─── New page / New folder buttons ─── */}
      <div className="flex items-center gap-1 border-t border-border px-2 py-2">
        <button
          type="button"
          onClick={handleNewPage}
          className={`btn-depth flex flex-1 items-center justify-center gap-1.5 rounded-md bg-ironlore-blue py-1.5 text-xs font-medium text-white hover:bg-ironlore-blue-strong ${collapsed ? "px-2" : "px-3"}`}
        >
          <FilePlus className="h-3.5 w-3.5" />
          {!collapsed && "New page"}
        </button>
        <button
          type="button"
          onClick={handleNewFolder}
          className="rounded-md border border-border p-1.5 text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
          title="New folder"
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* ─── Context menu ─── */}
      {contextMenu && (
        <div
          className="surface-glass fixed z-50 rounded-lg py-1"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <ContextMenuItem label="New file" onClick={ctxNewFile} />
          <ContextMenuItem label="New folder" onClick={ctxNewFolder} />
          {contextMenu.itemPath && (
            <>
              <div className="my-1 border-t border-border" />
              <ContextMenuItem label="Rename" onClick={ctxRename} />
              <ContextMenuItem label="Delete" onClick={ctxDelete} danger />
            </>
          )}
        </div>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SidebarBottomTab({
  icon: Icon,
  label,
  collapsed,
  badge,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  collapsed: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs text-secondary hover:bg-ironlore-slate-hover hover:text-primary ${collapsed ? "justify-center" : ""}`}
      title={collapsed ? label : undefined}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span>{label}</span>}
      {badge !== undefined && badge > 0 && (
        <span className="badge-glow absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-signal-red px-1 text-[10px] font-bold text-white">
          {badge}
        </span>
      )}
    </button>
  );
}

function ContextMenuItem({
  label,
  onClick,
  danger,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`block w-full px-4 py-1.5 text-left text-xs ${
        danger
          ? "text-signal-red hover:bg-signal-red/10"
          : "text-primary hover:bg-ironlore-slate-hover"
      }`}
    >
      {label}
    </button>
  );
}
