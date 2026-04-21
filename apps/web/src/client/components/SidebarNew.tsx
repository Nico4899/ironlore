import type { PageType } from "@ironlore/core";
import {
  BookOpen,
  Captions,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  FileCode,
  FilePlus,
  FileSpreadsheet,
  FileText,
  FileType,
  FolderClosed,
  Home,
  Image,
  Inbox as InboxIcon,
  Mail,
  Music,
  PanelLeftClose,
  PanelLeftOpen,
  Terminal as TerminalIcon,
  Video,
  Workflow,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceActivity } from "../hooks/useWorkspaceActivity.js";
import {
  createFolder,
  createPage,
  deleteFolder,
  deletePage,
  fetchTree,
  movePage,
} from "../lib/api.js";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, useAppStore } from "../stores/app.js";
import { useAuthStore } from "../stores/auth.js";
import { useTreeStore } from "../stores/tree.js";
import { MOTION } from "../styles/motion.js";
import { Logo } from "./Logo.js";
import { Reuleaux as ReuleauxIcon } from "./primitives/index.js";

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
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  // Dev-mode gates the terminal affordance — the button only
  //  renders when Settings → General → Developer mode is On. Keeps
  //  the shell free of power-user noise for non-technical users.
  const devMode = useAppStore((s) => s.devMode);
  const activePath = useAppStore((s) => s.activePath);
  const nodes = useTreeStore((s) => s.nodes);
  // Shared activity source — powers the INBOX tab badge + the
  //  active-agents strip. Polls on a 10 s tick.
  const workspaceActivity = useWorkspaceActivity();

  /**
   * Drag state for the right-edge resize handle. Pointer-capture on
   * the handle, not on document, so the drag survives a slow mouse
   * even if it briefly exits the sidebar bounds. On drag end a width
   * below `SIDEBAR_MIN_WIDTH - 20` snaps back to the minimum instead
   * of hiding — per docs/09-ui-and-brand.md §Sidebar resize:
   * "below 200 in a single drag it snaps to 220 rather than hiding."
   * Hiding is a separate keyboard action (⌘B).
   */
  const resizeState = useRef<{ dragging: boolean } | null>(null);
  if (resizeState.current === null) resizeState.current = { dragging: false };

  const handleResizeDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeState.current) return;
    resizeState.current.dragging = true;
    (e.target as Element).setPointerCapture(e.pointerId);
    e.preventDefault();
  }, []);

  const handleResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeState.current?.dragging) return;
    // The sidebar's left edge is x=0 of the viewport, so client X is
    //  the width directly. Clamp in the store (it enforces 220..420).
    const raw = e.clientX;
    // Snap: if user drags below 200 px, snap to the minimum rather
    //  than leaving the sidebar at a non-spec width.
    const next = raw < 200 ? SIDEBAR_MIN_WIDTH : raw;
    useAppStore.getState().setSidebarWidth(next);
  }, []);

  const handleResizeUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeState.current) return;
    resizeState.current.dragging = false;
    (e.target as Element).releasePointerCapture(e.pointerId);
  }, []);

  const handleResizeKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 20 : 5;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        useAppStore.getState().setSidebarWidth(sidebarWidth - step);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        useAppStore.getState().setSidebarWidth(sidebarWidth + step);
      } else if (e.key === "Home") {
        e.preventDefault();
        useAppStore.getState().setSidebarWidth(SIDEBAR_MIN_WIDTH);
      } else if (e.key === "End") {
        e.preventDefault();
        useAppStore.getState().setSidebarWidth(SIDEBAR_MAX_WIDTH);
      }
    },
    [sidebarWidth],
  );

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [slideDir, setSlideDir] = useState<"left" | "right" | null>(null);
  // DnD state — the string is either a folder path (drop-into), or one of
  // the sentinels "__root__" / "__up__" for breadcrumb targets.
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const collapsed = !sidebarOpen;

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
  /**
   * Drill into a folder — the current list slides LEFT off-screen
   * (ease-in-out, `--motion-transit`); when the timer matches the
   * transition we swap the folder and slide the new list in from
   * the right. Semantically a stack push.
   */
  const drillInto = useCallback((folderPath: string) => {
    setSlideDir("left");
    setTimeout(() => {
      useAppStore.getState().setSidebarFolder(folderPath);
      setSlideDir(null);
    }, MOTION.transit);
  }, []);

  /** Drill up — mirror of `drillInto`; stack pop. */
  const drillUp = useCallback(() => {
    setSlideDir("right");
    setTimeout(() => {
      const parts = sidebarFolder.split("/");
      parts.pop();
      useAppStore.getState().setSidebarFolder(parts.join("/"));
      setSlideDir(null);
    }, MOTION.transit);
  }, [sidebarFolder]);

  const drillToRoot = useCallback(() => {
    setSlideDir("right");
    setTimeout(() => {
      useAppStore.getState().setSidebarFolder("");
      setSlideDir(null);
    }, MOTION.transit);
  }, []);

  /**
   * Top-row logo click — "go home." Clears the active file + active
   * agent so the content area lands on the HomePanel; keeps the
   * sidebar on the files tab (the user's existing drill-down context
   * survives). Same intent the retired Header's logo used to carry.
   */
  const goHome = useCallback(() => {
    const store = useAppStore.getState();
    store.setActivePath(null);
    store.setActiveAgentSlug(null);
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

  /**
   * Primary "+ New page" button beneath the tree. Creates an
   * untitled markdown at the currently-drilled-in folder, drops
   * into rename-mode immediately so the user names it inline, and
   * activates the new path so the editor opens it. Replaces the
   * prior "New folder" primary — folder creation stays on the
   * right-click context menu.
   */
  const handleNewPageFromSidebar = useCallback(async () => {
    const folder = sidebarFolder;
    const name = "Untitled";
    const path = folder ? `${folder}/${name}.md` : `${name}.md`;
    try {
      await createPage(path, `# ${name}\n`);
      useAppStore.getState().setActivePath(path);
      setEditingPath(path);
      setEditingValue(name);
    } catch {
      /* server error — file-watcher will reconcile eventually */
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
      // `.agents/` is a reserved, load-bearing directory — every
      //  installed persona lives under it. Blocking deletion at the
      //  UI prevents the "oops" case where a user collapses their
      //  entire agent roster with one right-click. Individual
      //  `.agents/<slug>/` subfolders can still be deleted (that's
      //  how you uninstall an agent).
      if (type === "directory" && path === ".agents") {
        window.alert(
          "The .agents folder is reserved and can't be deleted. To remove a single agent, delete its subfolder under .agents/ instead.",
        );
        return;
      }
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


  return (
    <aside
      className="sidebar-chrome relative flex h-full shrink-0 flex-col"
      style={{
        // Fixed 56 px when collapsed; otherwise the user-dragged
        //  width out of `useAppStore` (clamped 220..420 by the store).
        width: collapsed ? 56 : sidebarWidth,
      }}
    >
      {/*
       * Sidebar top row — the app's only identity surface after the
       * Header was retired.
       *   · Expanded: Ironlore mark on the left, collapse-chevron
       *     button on the right. Clicking the mark returns to Home.
       *   · Collapsed: the mark is the whole cell; on hover an
       *     expand-chevron fades up and overlays it so the click
       *     target is always the entire strip.
       * Height matches the ProjectTile row so the two stacked panels
       * feel like one block.
       */}
      {collapsed ? (
        <button
          type="button"
          onClick={() => useAppStore.getState().toggleSidebar()}
          className="il-sidebar-toptile group relative flex h-10 w-full items-center justify-center border-b border-border outline-none hover:bg-ironlore-slate-hover focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
          aria-label="Expand sidebar"
          title="Expand sidebar (⌘B)"
        >
          <span
            className="il-sidebar-toptile__logo"
            style={{ display: "inline-flex" }}
            aria-hidden="true"
          >
            <Logo size={20} />
          </span>
          <span
            className="il-sidebar-toptile__icon"
            style={{ display: "inline-flex" }}
            aria-hidden="true"
          >
            <PanelLeftOpen className="h-4 w-4 text-primary" />
          </span>
        </button>
      ) : (
        <div className="relative flex h-10 items-center justify-between gap-2 border-b border-border px-2">
          <button
            type="button"
            onClick={goHome}
            className="flex items-center rounded-[3px] p-1 outline-none hover:bg-ironlore-slate-hover focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
            aria-label="Ironlore home"
            title="Home"
          >
            <Logo size={20} />
          </button>
          <button
            type="button"
            onClick={() => useAppStore.getState().toggleSidebar()}
            className="flex h-7 w-7 items-center justify-center rounded text-secondary outline-none hover:bg-ironlore-slate-hover hover:text-primary focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
            aria-label="Collapse sidebar"
            title="Collapse sidebar (⌘B)"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* ─── Project switcher tile ───
       *  Full tile per docs/08 §Project switcher UX. Clickable
       *  surface mirrors the Cmd+P palette. Collapsed sidebar renders
       *  a compact square with just the gradient mark + pulse. */}
      <ProjectTile collapsed={collapsed} />

      {/*
       * Primary tabs — `FILES` and `INBOX` per docs/09-ui-and-brand.md
       * §Sidebar. Mono uppercase 10.5/0.06em with a 1.5 px blue
       * underline on the active tab; the underline's `margin-bottom:
       * -1px` tucks it under the parent border so the rule reads as
       * continuous. INBOX carries an amber counter badge from
       * `useWorkspaceActivity` — the whole tab row suppresses the
       * badge at zero rather than rendering a hollow chip. Collapsed
       * sidebar shows the two tabs as small icon buttons stacked.
       */}
      <SidebarTabs
        collapsed={collapsed}
        active={sidebarTab}
        inboxCount={workspaceActivity.inboxCount}
        onSelect={(tab) => useAppStore.getState().setSidebarTab(tab)}
      />

      {/* ─── Folder breadcrumb (when drilled in). Rendered regardless
       *  of `sidebarTab` — the tree stays visible even when Inbox is
       *  the active main-view surface, matching screen-more.jsx
       *  ScreenInbox (sidebar tree + content-area inbox). */}
      {!collapsed && sidebarFolder && (
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

      {/*
       * File/folder list — the FILES tab body. Slide animation is
       * directionally meaningful: drilling INTO a folder sends the
       * current list left (new content enters from the right); going
       * back up reverses it. `ease-in-out` pairs with
       * `--motion-transit` (180 ms) so the direction reads before the
       * motion settles.
       */}
      {!collapsed && (
        // biome-ignore lint/a11y/noStaticElementInteractions: context menu on container
        <div
          className={`flex-1 overflow-y-auto px-1 py-1 transition-transform duration-(--motion-transit) ease-in-out ${
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

      {/* Collapsed: no list shown — the ActiveAgentsStrip + bottom
       *  rail still render below. */}
      {collapsed && <div className="flex-1" />}

      {/* Inbox is now a full-screen surface routed via the content
       *  area (ContentArea reads `sidebarTab === "inbox"` and renders
       *  <InboxPanel /> in place of the editor). The sidebar's INBOX
       *  tab is the trigger + state indicator; the tree stays
       *  visible behind it. */}

      {/* ─── Agents panel — all installed agents, always visible. Was
       *  `ActiveAgentsStrip` (running-only); promoted to a first-class
       *  sidebar surface with a `+ add agent` affordance. ─── */}
      <AgentsPanel collapsed={collapsed} />

      {/* ─── Divider ─── */}
      <div className="border-t border-border" />

      {/*
       * Bottom rail — trimmed to just the dev-mode terminal button.
       * Search / Settings / Theme / Profile are now owned by the
       * AppHeader (logo · breadcrumb · theme · search · inbox ·
       * profile). Keeping the rail as an empty shell would be wasted
       * vertical space; we only render it when there's actually
       * something to show (dev-mode on).
       */}
      {devMode && (
        <div className={`flex flex-col gap-0.5 px-1 py-1.5 ${collapsed ? "items-center" : ""}`}>
          <SidebarBottomTab
            icon={TerminalIcon}
            label="Terminal (Ctrl+`)"
            collapsed={collapsed}
            onClick={() => useAppStore.getState().toggleTerminal()}
          />
        </div>
      )}

      {/* ─── New-page button (expanded only). Replaces the prior
       *  "New folder" primary button; folder creation still lives on
       *  the tree's right-click menu + context-folder actions. Per
       *  the sidebar brief: "Add + button below file structure to
       *  add new page and remove it from the editor view at the
       *  top." */}
      {!collapsed && (
        <div className="flex items-center gap-1 border-t border-border px-2 py-2">
          <button
            type="button"
            onClick={handleNewPageFromSidebar}
            className="btn-depth flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border py-1.5 text-xs text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
          >
            <FilePlus className="h-3.5 w-3.5" />
            New page
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

      {/*
       * Right-edge resize handle per docs/09-ui-and-brand.md §Sidebar
       * resize: a 1 px border at rest, thickens to 3 px
       * `var(--il-blue)` on hover or while focused. Pointer drag
       * updates `sidebarWidth` (clamped 220..420 in the store). Below
       * 200 px of raw drag we snap to the minimum rather than hide —
       * hiding is a separate keyboard action (⌘B). Keyboard:
       * ArrowLeft/ArrowRight ±5 px (±20 with Shift), Home/End jump to
       * min/max.
       */}
      {!collapsed && (
        // biome-ignore lint/a11y/useSemanticElements: <hr> has no interactive affordance; this separator must accept pointer, focus, and key events
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onPointerDown={handleResizeDown}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeUp}
          onKeyDown={handleResizeKey}
          className="il-sidebar-resize"
        />
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * Two-tab bar — `FILES` and `INBOX`. Expanded: mono uppercase
 * labels with a 1.5 px blue underline on the active tab (margin
 * −1 px so the underline replaces the parent's border). Collapsed:
 * stacked icon buttons (Home for files, Inbox for inbox) with the
 * same blue-tint active state. INBOX badge is an amber counter
 * derived from `useWorkspaceActivity`; suppressed at zero.
 */
function SidebarTabs({
  collapsed,
  active,
  inboxCount,
  onSelect,
}: {
  collapsed: boolean;
  active: "files" | "inbox";
  inboxCount: number;
  onSelect: (tab: "files" | "inbox") => void;
}) {
  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-0.5 border-b border-border px-1 py-1.5">
        <SidebarBottomTab icon={Home} label="Files" collapsed onClick={() => onSelect("files")} />
        <SidebarBottomTab
          icon={InboxIcon}
          label="Inbox"
          collapsed
          badge={inboxCount > 0 ? inboxCount : undefined}
          onClick={() => onSelect("inbox")}
        />
      </div>
    );
  }

  return (
    <div className="flex items-end gap-2 border-b border-border px-3" style={{ height: 30 }}>
      <SidebarTabPill label="files" active={active === "files"} onClick={() => onSelect("files")} />
      <SidebarTabPill
        label="inbox"
        active={active === "inbox"}
        badge={inboxCount > 0 ? inboxCount : undefined}
        onClick={() => onSelect("inbox")}
      />
    </div>
  );
}

function SidebarTabPill({
  label,
  active,
  badge,
  onClick,
}: {
  label: string;
  active: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="flex items-center gap-1.5 bg-transparent font-mono uppercase outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
      style={{
        padding: "6px 4px 7px",
        marginBottom: -1,
        fontSize: 10.5,
        letterSpacing: "0.06em",
        color: active ? "var(--il-text)" : "var(--il-text3)",
        borderBottom: `1.5px solid ${active ? "var(--il-blue)" : "transparent"}`,
      }}
    >
      {label}
      {badge !== undefined && (
        <span
          aria-hidden="true"
          className="inline-flex items-center justify-center"
          style={{
            minWidth: 14,
            height: 14,
            padding: "0 4px",
            borderRadius: 7,
            fontSize: 10.5,
            background: "var(--il-amber)",
            color: "var(--il-bg)",
            letterSpacing: 0,
          }}
        >
          {badge}
        </span>
      )}
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
 * Project-switcher tile in the sidebar. Matches the design-system
 * mockup: gradient mark (blue → violet) + project name + "· N
 * projects" subline + chevron. Clicking opens the Cmd+P palette so
 * there's exactly one switching code path.
 *
 * Collapsed sidebar collapses the tile to a 24×24 gradient square with
 * a pulse when agents are working — the full name is hidden behind the
 * expand affordance.
 */
function ProjectTile({ collapsed }: { collapsed: boolean }) {
  const currentProjectId = useAuthStore((s) => s.currentProjectId);
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    // Lazy one-shot — the switcher itself keeps the list fresh, so
    //  the tile only needs the count once per session. Fails silently
    //  (the tile still renders the project id if this errors out).
    void import("../lib/api.js").then(async (mod) => {
      try {
        const list = await mod.fetchProjects();
        setCount(list.length);
      } catch {
        setCount(null);
      }
    });
  }, []);

  if (!currentProjectId) return null;
  const onClick = () => useAppStore.getState().toggleProjectSwitcher();

  if (collapsed) {
    return (
      <div className="flex items-center justify-center border-b border-border px-2 py-2">
        <button
          type="button"
          onClick={onClick}
          title={`${currentProjectId} — switch project (⌘P)`}
          aria-label="Switch project"
          className="h-6 w-6 rounded-[3px] outline-none transition-opacity hover:opacity-80 focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
          style={{
            background:
              "linear-gradient(135deg, var(--il-blue), var(--il-violet, oklch(0.70 0.17 300)))",
          }}
        />
      </div>
    );
  }

  return (
    <div className="border-b border-border px-2 py-2">
      <button
        type="button"
        onClick={onClick}
        title="Switch project (⌘P)"
        className="flex w-full items-center gap-2 rounded-[3px] border px-2 py-1.5 text-left outline-none transition-colors hover:bg-ironlore-slate-hover focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
        style={{
          borderColor: "var(--il-border-soft)",
          background: "var(--il-slate-elev)",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 16,
            height: 16,
            borderRadius: 3,
            background:
              "linear-gradient(135deg, var(--il-blue), var(--il-violet, oklch(0.70 0.17 300)))",
            flexShrink: 0,
          }}
        />
        <span style={{ flex: 1, lineHeight: 1.2, minWidth: 0, display: "block" }}>
          <span
            className="block truncate"
            style={{ fontSize: 12.5, fontWeight: 500, color: "var(--il-text)" }}
          >
            {currentProjectId}
          </span>
          <span
            className="font-mono"
            style={{
              fontSize: 10.5,
              color: "var(--il-text3)",
              letterSpacing: "0.04em",
            }}
          >
            {count === null ? "· switch project" : `${count} project${count === 1 ? "" : "s"}`}
          </span>
        </span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-secondary" />
      </button>
    </div>
  );
}

/**
 * Active-agents strip — surfaces the live workspace activity above the
 * bottom rail. Matches the design-system mockup: mono overline with
 * Reuleaux pulse + count, then a compact per-agent row with pip,
 * slug, and step label. Only renders when at least one agent is
 * running (the rest of the agents already have a home on the Home
 * screen). Clicking a row opens that agent's detail page.
 */
/**
 * AgentsPanel — every installed agent, not just the ones running.
 *
 * Replaces the prior `ActiveAgentsStrip` (which hid entirely when no
 * agent was running). Per the sidebar rework brief, the sidebar now
 * promotes agents to a first-class surface: an `AGENTS` separator,
 * one row per agent with a state-coloured Reuleaux (blue-spin =
 * running, amber = paused, neutral = queued/idle), the step label
 * while running, and a `+ Add agent` button below the list.
 *
 * Clicking a row routes the content area to the agent's detail page
 * via `setActiveAgentSlug`. Clicking `+` prompts for a slug and
 * scaffolds `.agents/<slug>/persona.md` with a minimal frontmatter
 * + prose template — no new endpoint needed; the server picks the
 * persona up via the file watcher.
 */
function AgentsPanel({ collapsed }: { collapsed: boolean }) {
  const activity = useWorkspaceActivity();
  const agents = activity.agents;
  const runningCount = activity.runningCount;

  const onAdd = useCallback(async () => {
    // Light prompt for scope — a dedicated wizard is future work.
    //  Slug rules mirror the persona file-system naming constraints.
    const slug = window.prompt("New agent slug (lowercase, dashes only):", "");
    if (!slug) return;
    const clean = slug.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(clean)) {
      window.alert("Slug must be 3–32 chars, lowercase letters/digits/dashes; no leading/trailing dash.");
      return;
    }
    const path = `.agents/${clean}/persona.md`;
    const template =
      "---\n" +
      `slug: ${clean}\n` +
      "description: \n" +
      "heartbeat: \n" +
      "review_mode: inbox\n" +
      "tools: []\n" +
      "scope:\n" +
      "  pages: []\n" +
      "  writable_kinds: []\n" +
      "---\n\n" +
      `# ${clean}\n\nDescribe what this agent does.\n`;
    try {
      await createPage(path, template);
      useAppStore.getState().setActivePath(path);
    } catch {
      window.alert("Couldn't create that agent. A persona with that slug may already exist.");
    }
  }, []);

  if (collapsed) {
    // Collapsed rail: single pip summarising any running agents.
    //  Clicking jumps to the first running (or any) agent's detail
    //  so the collapsed state still surfaces agent activity.
    if (agents.length === 0) return null;
    const running = agents.find((a) => a.running);
    const target = running ?? agents[0];
    return (
      <button
        type="button"
        onClick={() => useAppStore.getState().setActiveAgentSlug(target?.slug ?? null)}
        className="mx-2 my-2 flex items-center justify-center rounded-[3px] py-1 outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
        title={runningCount > 0 ? `${runningCount} running` : `${agents.length} agents`}
        style={
          runningCount > 0
            ? { background: "color-mix(in oklch, var(--il-blue) 10%, transparent)" }
            : undefined
        }
      >
        <ReuleauxIcon
          size={7}
          color={runningCount > 0 ? "var(--il-blue)" : "var(--il-text3)"}
          spin={runningCount > 0}
        />
      </button>
    );
  }

  return (
    <div className="border-t border-border px-3 py-2.5">
      {/* Mono `AGENTS` overline — the separator the user asked for.
       *  Trailing meta echoes the Home §01 grammar (`N RUNNING · N
       *  QUEUED`) so the vocabulary is consistent across surfaces. */}
      <div
        className="mb-2 flex items-center gap-2 font-mono uppercase"
        style={{ fontSize: 10.5, color: "var(--il-text3)", letterSpacing: "0.08em" }}
      >
        <span>Agents</span>
        <span className="flex-1" />
        <span style={{ color: "var(--il-text4)" }}>
          {runningCount > 0 ? `${runningCount} running` : `${agents.length}`}
        </span>
      </div>

      {agents.length === 0 ? (
        <div
          style={{
            fontSize: 11.5,
            color: "var(--il-text3)",
            padding: "4px 2px 8px",
            fontStyle: "italic",
          }}
        >
          No agents installed yet.
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {agents.map((a) => {
            // Pip colour vocabulary matches the rest of the app:
            //  blue-spin = running, amber = paused, neutral = queued.
            const paused = a.status === "paused";
            const pipColor = a.running
              ? "var(--il-blue)"
              : paused
                ? "var(--il-amber)"
                : "var(--il-text3)";
            const label = a.running ? a.stepLabel : paused ? "paused" : "idle";
            return (
              <button
                key={a.slug}
                type="button"
                onClick={() => useAppStore.getState().setActiveAgentSlug(a.slug)}
                className="flex items-center gap-2 rounded-[3px] px-1 py-0.5 text-left outline-none hover:bg-ironlore-slate-hover focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
              >
                <ReuleauxIcon size={7} color={pipColor} spin={a.running} />
                <span
                  className="flex-1 truncate"
                  style={{ fontSize: 12, color: "var(--il-text2)" }}
                >
                  {a.slug}
                </span>
                {label && (
                  <span
                    className="font-mono"
                    style={{
                      fontSize: 10.5,
                      color: a.running
                        ? "var(--il-blue)"
                        : paused
                          ? "var(--il-amber)"
                          : "var(--il-text4)",
                      letterSpacing: "0.04em",
                    }}
                  >
                    {label}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* + Add agent — scaffolds `.agents/<slug>/persona.md` from a
       *  template so the persona engine picks it up on next poll. */}
      <button
        type="button"
        onClick={onAdd}
        className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-[3px] border border-dashed outline-none hover:bg-ironlore-slate-hover focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
        style={{
          padding: "4px 6px",
          borderColor: "var(--il-border-soft)",
          fontSize: 10.5,
          color: "var(--il-text3)",
          letterSpacing: "0.04em",
        }}
        title="Create a new agent persona"
      >
        <span aria-hidden="true" style={{ fontFamily: "var(--font-mono)" }}>+</span>
        <span className="font-mono uppercase">add agent</span>
      </button>
    </div>
  );
}
