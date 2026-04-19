import type { PageType } from "@ironlore/core";
import {
  BookOpen,
  Boxes,
  Captions,
  ChevronLeft,
  ChevronRight,
  Compass,
  FileCode,
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
  Settings as SettingsIcon,
  Sun,
  TerminalSquare,
  Video,
  Workflow,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
// File icon — each type gets its own color
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
// Context menu state
// ---------------------------------------------------------------------------

interface ContextMenuState {
  x: number;
  y: number;
  targetFolder: string;
  itemPath?: string;
  itemType?: PageType | "directory";
  itemName?: string;
}

// ---------------------------------------------------------------------------
// Main Sidebar
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
  const [slideDir, setSlideDir] = useState<"left" | "right" | null>(null);
  const [hovered, setHovered] = useState(false);
  // DnD state — the string is either a folder path (drop-into), or one of
  // the sentinels "__root__" / "__up__" for breadcrumb targets.
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const collapsed = !sidebarOpen;
  const inboxCount = 2; // placeholder

  // Load tree on mount
  useEffect(() => {
    fetchTree()
      .then(({ pages }) => {
        useTreeStore
          .getState()
          .setNodes(pages.map((p) => ({ id: p.path, name: p.name, path: p.path, type: p.type })));
      })
      .catch(() => {});
  }, []);

  // Items at current folder level
  const visibleItems = useMemo(() => {
    const prefix = sidebarFolder ? `${sidebarFolder}/` : "";
    return nodes
      .filter((n) => {
        if (sidebarFolder === "") return !n.path.includes("/");
        if (!n.path.startsWith(prefix)) return false;
        return !n.path.slice(prefix.length).includes("/");
      })
      .sort((a, b) => {
        const ad = a.type === "directory" ? 0 : 1;
        const bd = b.type === "directory" ? 0 : 1;
        if (ad !== bd) return ad - bd;
        return a.name.localeCompare(b.name);
      });
  }, [nodes, sidebarFolder]);

  // Navigation
  const drillInto = useCallback((folderPath: string) => {
    setSlideDir("left");
    setTimeout(() => {
      useAppStore.getState().setSidebarFolder(folderPath);
      setSlideDir(null);
    }, 150);
  }, []);

  const drillUp = useCallback(() => {
    setSlideDir("right");
    setTimeout(() => {
      const parts = sidebarFolder.split("/");
      parts.pop();
      useAppStore.getState().setSidebarFolder(parts.join("/"));
      setSlideDir(null);
    }, 150);
  }, [sidebarFolder]);

  const drillToRoot = useCallback(() => {
    setSlideDir("right");
    setTimeout(() => {
      useAppStore.getState().setSidebarFolder("");
      setSlideDir(null);
    }, 150);
  }, []);

  const openFile = useCallback((path: string) => {
    useAppStore.getState().setActivePath(path);
  }, []);

  // ─── Drag and drop (file moves) ──────────────────────────────────
  // Files can be dragged onto any folder row in the current view, or
  // onto the breadcrumb Home/up buttons to move out of the current
  // folder. The backend (POST /pages/:path/move) handles the sidecar
  // move and WS broadcast; the tree store picks up the resulting
  // tree:move event without a full refresh.
  const handleDragStart = useCallback((e: React.DragEvent, path: string) => {
    e.dataTransfer.setData("text/plain", path);
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, target: string, valid: boolean) => {
    e.preventDefault();
    if (valid) {
      e.dataTransfer.dropEffect = "move";
      setDropTarget(target);
    } else {
      e.dataTransfer.dropEffect = "none";
      setDropTarget(null);
    }
  }, []);

  const handleDragLeave = useCallback(() => {
    setDropTarget(null);
  }, []);

  const performMove = useCallback(async (sourcePath: string, targetDir: string) => {
    const fileName = sourcePath.includes("/")
      ? sourcePath.slice(sourcePath.lastIndexOf("/") + 1)
      : sourcePath;
    const destination = targetDir ? `${targetDir}/${fileName}` : fileName;
    if (sourcePath === destination) return;
    try {
      await movePage(sourcePath, destination);
    } catch {
      // Move failed — tree state unchanged, WS would revert optimistic UI.
    }
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent, targetDir: string) => {
      e.preventDefault();
      setDropTarget(null);
      const sourcePath = e.dataTransfer.getData("text/plain");
      if (!sourcePath) return;
      await performMove(sourcePath, targetDir);
    },
    [performMove],
  );

  // New folder (only in expanded sidebar)
  const handleNewFolder = useCallback(async () => {
    const folder = sidebarFolder;
    const name = "Untitled";
    const path = folder ? `${folder}/${name}` : name;
    try {
      await createFolder(path);
      setEditingPath(path);
      setEditingValue(name);
    } catch {
      /* */
    }
  }, [sidebarFolder]);

  // Rename
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
        /* */
      }
    }
    setEditingPath(null);
  }, []);

  // Delete
  const handleDelete = useCallback(
    async (path: string, type: PageType | "directory", name: string) => {
      const msg =
        type === "directory"
          ? `Delete folder "${name}" and all its contents?`
          : `Delete "${name}"?`;
      if (!window.confirm(msg)) return;
      try {
        if (type === "directory") await deleteFolder(path);
        else await deletePage(path);
      } catch {
        /* */
      }
    },
    [],
  );

  // Context menu
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

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu]);

  const ctxNewFile = useCallback(async () => {
    if (!contextMenu) return;
    const folder = contextMenu.targetFolder;
    const name = "Untitled";
    const path = folder ? `${folder}/${name}.md` : `${name}.md`;
    setContextMenu(null);
    try {
      await createPage(path, `# ${name}\n`);
      if (folder && folder !== sidebarFolder) useAppStore.getState().setSidebarFolder(folder);
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
      if (folder && folder !== sidebarFolder) useAppStore.getState().setSidebarFolder(folder);
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

  const handleLogout = useCallback(async () => {
    try {
      await logout();
      useAuthStore.getState().checkSession();
    } catch {
      /* */
    }
  }, []);

  return (
    <aside
      className={`sidebar-chrome flex h-full shrink-0 flex-col transition-all ${
        collapsed ? "w-14" : "w-64"
      }`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* ─── Top: Logo / collapse toggle ─── */}
      <div className="relative flex items-center gap-2 border-b border-border px-3 py-2.5">
        {/* Logo — visible when NOT hovered (or when expanded) */}
        <div
          className={`flex h-6 w-6 shrink-0 items-center justify-center transition-opacity duration-(--motion-snap) ${
            collapsed && hovered ? "opacity-0" : "opacity-100"
          }`}
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
            <circle cx="9" cy="10" r="6" fill="oklch(0.65 0.18 250)" opacity="0.7" />
            <circle cx="15" cy="10" r="6" fill="oklch(0.65 0.15 160)" opacity="0.7" />
            <circle cx="12" cy="15" r="6" fill="oklch(0.70 0.15 80)" opacity="0.7" />
          </svg>
        </div>
        {/* Collapse/expand — overlays the logo position, visible on hover */}
        <button
          type="button"
          onClick={() => useAppStore.getState().toggleSidebar()}
          className={`absolute left-3 flex h-6 w-6 items-center justify-center rounded text-secondary transition-opacity duration-(--motion-snap) hover:bg-ironlore-slate-hover hover:text-primary ${
            collapsed ? (hovered ? "opacity-100" : "opacity-0") : "opacity-0 hover:opacity-100"
          }`}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" />
          ) : (
            <PanelLeftClose className="h-4 w-4" />
          )}
        </button>
        {!collapsed && (
          <>
            <span className="text-sm font-semibold tracking-tight text-primary">ironlore</span>
            <ProjectChip />
            <div className="flex-1" />
            {/* Expand collapse visible on hover in expanded mode */}
            <button
              type="button"
              onClick={() => useAppStore.getState().toggleSidebar()}
              className="rounded p-1 text-secondary opacity-0 transition-opacity hover:bg-ironlore-slate-hover hover:text-primary group-hover:opacity-100"
              style={{ opacity: hovered ? 1 : 0 }}
              aria-label="Collapse sidebar"
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>

      {/* ─── Vertical tabs: Home / Search / Explore ─── */}
      <div
        className={`flex flex-col gap-0.5 border-b border-border px-1 py-1.5 ${collapsed ? "items-center" : ""}`}
      >
        <SidebarNavTab
          icon={Home}
          label="Home"
          collapsed={collapsed}
          active={sidebarTab === "home"}
          onClick={() => useAppStore.getState().setSidebarTab("home")}
        />
        <SidebarNavTab
          icon={Search}
          label="Search"
          collapsed={collapsed}
          active={false}
          onClick={() => useAppStore.getState().toggleSearchDialog()}
        />
        <SidebarNavTab
          icon={Compass}
          label="Explore"
          collapsed={collapsed}
          active={sidebarTab === "explore"}
          onClick={() => useAppStore.getState().setSidebarTab("explore")}
        />
      </div>

      {/* ─── Folder breadcrumb (when drilled in) ─── */}
      {!collapsed && sidebarFolder && sidebarTab === "home" && (
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5 text-xs text-secondary">
          <button
            type="button"
            onClick={drillToRoot}
            onDragOver={(e) => handleDragOver(e, "__root__", true)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => void handleDrop(e, "")}
            className={`rounded p-0.5 hover:bg-ironlore-slate-hover hover:text-primary ${
              dropTarget === "__root__"
                ? "ring-1 ring-ironlore-blue bg-ironlore-slate-hover text-primary"
                : ""
            }`}
            title="Go to root (drop here to move to root)"
          >
            <Home className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={drillUp}
            onDragOver={(e) => handleDragOver(e, "__up__", true)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => {
              const parts = sidebarFolder.split("/");
              parts.pop();
              void handleDrop(e, parts.join("/"));
            }}
            className={`rounded p-0.5 hover:bg-ironlore-slate-hover hover:text-primary ${
              dropTarget === "__up__"
                ? "ring-1 ring-ironlore-blue bg-ironlore-slate-hover text-primary"
                : ""
            }`}
            title="Go up one level (drop here to move up)"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="truncate font-medium text-primary">
            {sidebarFolder.split("/").pop()}
          </span>
        </div>
      )}

      {/* ─── File/folder list (scrollable, home tab only, expanded only) ─── */}
      {!collapsed && sidebarTab === "home" && (
        // biome-ignore lint/a11y/noStaticElementInteractions: context menu on container
        <div
          className={`flex-1 overflow-y-auto px-1 py-1 transition-transform duration-(--motion-transit) ${
            slideDir === "left"
              ? "-translate-x-full opacity-0"
              : slideDir === "right"
                ? "translate-x-full opacity-0"
                : "translate-x-0 opacity-100"
          }`}
          onContextMenu={(e) => handleContextMenu(e)}
        >
          {visibleItems.length === 0 && (
            <div className="py-8 text-center text-xs text-secondary">No pages yet</div>
          )}
          {visibleItems.map((item) => {
            const isDir = item.type === "directory";
            const isActive = activePath === item.path;
            const isEditing = editingPath === item.path;

            const isDropTarget = isDir && dropTarget === item.path;
            return (
              // biome-ignore lint/a11y/useSemanticElements: complex interactive row with context menu
              <div
                key={item.path}
                className={`group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-all duration-(--motion-snap) ${
                  isActive
                    ? "sidebar-item-active text-primary"
                    : isDropTarget
                      ? "border border-ironlore-blue bg-ironlore-slate-hover text-primary"
                      : "text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
                }`}
                draggable={!isDir && !isEditing}
                onDragStart={(e) => !isDir && handleDragStart(e, item.path)}
                onDragOver={(e) => handleDragOver(e, item.path, isDir)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => {
                  if (isDir) void handleDrop(e, item.path);
                }}
                onClick={() => {
                  if (isEditing) return;
                  if (isDir) drillInto(item.path);
                  else openFile(item.path);
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
        </div>
      )}

      {/* Collapsed: no file list shown */}
      {collapsed && <div className="flex-1" />}

      {/* Explore/Search placeholders only visible in expanded non-home tabs */}
      {!collapsed && sidebarTab !== "home" && <div className="flex-1" />}

      {/* ─── Divider ─── */}
      <div className="border-t border-border" />

      {/* ─── Fixed bottom section ─── */}
      <div className={`flex flex-col gap-0.5 px-1 py-1.5 ${collapsed ? "items-center" : ""}`}>
        <SidebarBottomTab
          icon={Inbox}
          label="Inbox"
          collapsed={collapsed}
          badge={inboxCount}
          onClick={() => useAppStore.getState().toggleInbox()}
        />
        <SidebarBottomTab
          icon={TerminalSquare}
          label="Terminal"
          collapsed={collapsed}
          onClick={() => useAppStore.getState().toggleTerminal()}
        />
        <SidebarBottomTab
          icon={Boxes}
          label="Switch project (⌘P)"
          collapsed={collapsed}
          onClick={() => useAppStore.getState().toggleProjectSwitcher()}
        />
        <SidebarBottomTab
          icon={SettingsIcon}
          label="Settings"
          collapsed={collapsed}
          onClick={() => useAppStore.getState().toggleSettings()}
        />
        <SidebarBottomTab
          icon={MessageSquare}
          label="Feedback"
          collapsed={collapsed}
          onClick={() => {}}
        />
        <SidebarBottomTab
          icon={theme === "dark" ? Sun : Moon}
          label={theme === "dark" ? "Light mode" : "Dark mode"}
          collapsed={collapsed}
          onClick={() => useAppStore.getState().toggleTheme()}
        />
        <SidebarBottomTab
          icon={LogOut}
          label="Log out"
          collapsed={collapsed}
          onClick={handleLogout}
        />
      </div>

      {/* ─── New folder button (expanded only) ─── */}
      {!collapsed && (
        <div className="flex items-center gap-1 border-t border-border px-2 py-2">
          <button
            type="button"
            onClick={handleNewFolder}
            className="btn-depth flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border py-1.5 text-xs text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
          >
            <FolderPlus className="h-3.5 w-3.5" />
            New folder
          </button>
        </div>
      )}

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
              {contextMenu.itemPath.endsWith(".md") && (
                <ContextMenuItem
                  label="Copy to project…"
                  onClick={() => {
                    const path = contextMenu.itemPath;
                    if (path) useAppStore.getState().openCopyToProject(path);
                    setContextMenu(null);
                  }}
                />
              )}
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

function SidebarNavTab({
  icon: Icon,
  label,
  collapsed,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  collapsed: boolean;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs transition-colors ${
        active
          ? "bg-ironlore-blue/15 font-medium text-primary"
          : "text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
      } ${collapsed ? "justify-center" : ""}`}
      title={collapsed ? label : undefined}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span>{label}</span>}
    </button>
  );
}

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
      aria-label={label}
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

/**
 * Active-project chip in the sidebar header (docs/08-projects-and-
 * isolation.md §Project switcher UX). Clicking it opens the Cmd+P
 * palette. When only one project exists the chip renders as a
 * non-interactive label — the switcher is hidden until a second
 * project appears, matching the "multi-project is opt-in" spec.
 */
function ProjectChip() {
  const currentProjectId = useAuthStore((s) => s.currentProjectId);
  // We optimistically render what the auth store tells us, even before
  //  `/api/projects` has loaded. The ProjectSwitcher fetches that list
  //  itself when the user opens it — no extra HTTP for the chip.
  if (!currentProjectId) return null;
  return (
    <button
      type="button"
      onClick={() => useAppStore.getState().toggleProjectSwitcher()}
      className="rounded border px-1.5 py-0.5 text-xs font-medium text-secondary outline-none transition-colors hover:bg-ironlore-slate-hover hover:text-primary focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
      style={{
        borderColor: "var(--il-border-soft)",
        fontFamily: "var(--font-mono)",
        fontSize: 10.5,
        letterSpacing: "0.04em",
        marginLeft: 8,
      }}
      title="Switch project (Cmd+P)"
    >
      {currentProjectId}
    </button>
  );
}
