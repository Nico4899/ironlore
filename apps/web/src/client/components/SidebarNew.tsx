import type { PageType } from "@ironlore/core";
import {
  BookOpen,
  Bot,
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
  FolderOpen,
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
import type React from "react";
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
import { FolderPeekButton } from "./FolderPeek.js";
import { Logo } from "./Logo.js";
import { Reuleaux as ReuleauxIcon } from "./primitives/index.js";

// ---------------------------------------------------------------------------
// File icon — each type gets its own color
// ---------------------------------------------------------------------------

function FileIcon({ type, open }: { type: PageType | "directory"; open?: boolean }) {
  const base = "h-4 w-4 shrink-0";
  switch (type) {
    case "directory":
      return open ? (
        <FolderOpen className={`${base} icon-folder`} />
      ) : (
        <FolderClosed className={`${base} icon-folder`} />
      );
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
  // the sentinels "__root__" / "__up__" for breadcrumb targets, or a file
  // path when the cursor is over a file row (in which case `dropEdge`
  // describes whether the drop will land before/after that row — both
  // resolve to "into the parent folder" because the tree is alphabetically
  // sorted with no per-folder ordering primitive).
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dropEdge, setDropEdge] = useState<"before" | "after" | null>(null);

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

  // ─── ARIA tree: focused-row state + keyboard nav ──────────────────
  // Tracks which `treeitem` currently owns `tabIndex={0}`. Mouse
  // clicks set it via `onClick`; keyboard arrows move it via the
  // container `onKeyDown`. The active file (`activePath`) seeds the
  // initial focus so screen-reader users land on the page they're
  // already reading. See docs/09-ui-and-brand.md §Sidebar a11y +
  // WAI-ARIA Authoring Practices §Tree View.
  const [focusedTreeIdx, setFocusedTreeIdx] = useState<number>(0);
  const treeItemRefs = useRef<Array<HTMLDivElement | null>>([]);

  const focusTreeItem = useCallback((idx: number) => {
    setFocusedTreeIdx(idx);
    // Defer to the next frame so the ref array has been updated by
    // the new render before we try to .focus() — otherwise the
    // first render after a drill-into still holds the old refs.
    requestAnimationFrame(() => {
      treeItemRefs.current[idx]?.focus();
    });
  }, []);

  // Seed `focusedTreeIdx` to the active file's row so screen-reader
  // users land on what they're reading. Reset to 0 on folder drill.
  // Pure index recompute: re-running on visibleItems / activePath
  // changes is cheap because `findIndex` is O(items-in-view).
  useEffect(() => {
    if (visibleItems.length === 0) {
      setFocusedTreeIdx(0);
      return;
    }
    const activeIdx = visibleItems.findIndex((it) => it.path === activePath);
    setFocusedTreeIdx((prev) => {
      if (activeIdx >= 0) return activeIdx;
      // Active file isn't in the current folder view — keep prev if
      // it's still in range, otherwise pin to first item.
      return prev < visibleItems.length ? prev : 0;
    });
  }, [visibleItems, activePath]);

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
      setDropEdge(null);
    } else {
      e.dataTransfer.dropEffect = "none";
      setDropTarget(null);
      setDropEdge(null);
    }
  }, []);

  /**
   * Row-level dragOver that picks "into folder" vs "before / after sibling"
   * based on cursor Y. For folders, the middle band is "drop into" (existing
   * behaviour, ring + open-folder icon); the top/bottom bands resolve to
   * "drop into the parent folder" for both files and folders. The line is
   * cosmetic — there is no per-folder ordering primitive, so before/after
   * land in the same parent regardless of which edge was picked.
   */
  const handleRowDragOver = useCallback(
    (e: React.DragEvent, item: { path: string; type: PageType | "directory" }) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const y = e.clientY - rect.top;
      const third = rect.height / 3;
      const isDir = item.type === "directory";
      if (isDir && y > third && y < rect.height - third) {
        setDropTarget(item.path);
        setDropEdge(null);
        return;
      }
      setDropTarget(item.path);
      setDropEdge(y < rect.height / 2 ? "before" : "after");
    },
    [],
  );

  const handleDragLeave = useCallback(() => {
    setDropTarget(null);
    setDropEdge(null);
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
      setDropEdge(null);
      const sourcePath = e.dataTransfer.getData("text/plain");
      if (!sourcePath) return;
      await performMove(sourcePath, targetDir);
    },
    [performMove],
  );

  /**
   * Row-level drop. When `dropEdge` is set (cursor was on a row's
   * top/bottom band), the move resolves to the parent folder of the
   * row — not into the row itself. Folder rows with a centred drop
   * fall through to `handleDrop(item.path)` to land inside.
   */
  const handleRowDrop = useCallback(
    async (e: React.DragEvent, item: { path: string; type: PageType | "directory" }) => {
      e.preventDefault();
      const edge = dropEdge;
      setDropTarget(null);
      setDropEdge(null);
      const sourcePath = e.dataTransfer.getData("text/plain");
      if (!sourcePath) return;
      if (item.type === "directory" && !edge) {
        await performMove(sourcePath, item.path);
        return;
      }
      // Edge or file row → resolve to the parent folder. The current
      //  drill level (`sidebarFolder`) is the parent for everything in
      //  the visible list — items at the root level have parent "".
      const lastSlash = item.path.lastIndexOf("/");
      const parent = lastSlash === -1 ? "" : item.path.slice(0, lastSlash);
      await performMove(sourcePath, parent);
    },
    [dropEdge, performMove],
  );

  /**
   * Primary "+ New page" button beneath the tree. Optimistic: the
   * tree store gets the node first so the row appears instantly;
   * the server round-trip runs in the background and the WS
   * watcher event — when it arrives — is a no-op thanks to
   * `insertNode`'s duplicate-path guard. On server error we
   * `deleteNode` to roll back and surface the failure.
   */
  const handleNewPageFromSidebar = useCallback(async () => {
    const folder = sidebarFolder;
    const name = "Untitled";
    const path = folder ? `${folder}/${name}.md` : `${name}.md`;
    useTreeStore.getState().insertNode({ id: path, name: `${name}.md`, path, type: "markdown" });
    useAppStore.getState().setActivePath(path);
    setEditingPath(path);
    setEditingValue(name);
    try {
      await createPage(path, `# ${name}\n`);
    } catch {
      // Roll back the optimistic insert. The user sees the row
      //  vanish + an alert, which is better than a phantom file.
      useTreeStore.getState().deleteNode(path);
      setEditingPath(null);
      window.alert("Couldn't create that page. The name may already be taken.");
    }
  }, [sidebarFolder]);

  // Global ⌘N / Ctrl+N — invoke the same flow the bottom rail's
  //  click triggers. Suppressed when the user is typing in an input,
  //  textarea, or contentEditable surface (the editor) so the chord
  //  doesn't steal a literal "N" keystroke. The browser may still
  //  intercept ⌘N on its own to open a new window — preventDefault
  //  is best-effort; the rail's click is the guaranteed path.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
        const ae = document.activeElement as HTMLElement | null;
        const tag = ae?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || ae?.isContentEditable) return;
        e.preventDefault();
        void handleNewPageFromSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleNewPageFromSidebar]);

  // Rename (optimistic). The tree store moves the node right away
  //  so the label flips in place; server failure rolls it back.
  //  Captures the original node's `type` before the move so the
  //  rollback preserves the file kind. On success, surfaces a
  //  rename-rewrite toast when other pages link to the old path —
  //  see docs/03-editor.md §Rename-rewrite.
  const commitRename = useCallback(async (oldPath: string, newName: string) => {
    if (!newName.trim()) {
      setEditingPath(null);
      return;
    }
    const parts = oldPath.split("/");
    parts[parts.length - 1] = newName;
    const newPath = parts.join("/");
    setEditingPath(null);
    if (newPath === oldPath) return;

    const surfaceRewriteToast = (count: number | undefined) => {
      if (typeof count !== "number" || count <= 0) return;
      void import("./RewriteLinksToast.js").then(({ showRewriteLinksToast }) => {
        showRewriteLinksToast({ oldPath, newPath, count });
      });
    };

    const snapshot = useTreeStore.getState().nodes.find((n) => n.path === oldPath);
    if (!snapshot) {
      // Unknown node — don't try an optimistic move. Just issue
      //  the server call and let the watcher reconcile.
      try {
        const res = await movePage(oldPath, newPath);
        surfaceRewriteToast(res.inboundLinkCount);
      } catch {
        /* */
      }
      return;
    }
    useTreeStore.getState().moveNode(oldPath, newPath, newName, snapshot.type);
    try {
      const res = await movePage(oldPath, newPath);
      surfaceRewriteToast(res.inboundLinkCount);
    } catch {
      useTreeStore.getState().moveNode(newPath, oldPath, snapshot.name, snapshot.type);
      window.alert("Rename failed — the old path was restored.");
    }
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

      // Optimistic delete — yank the node (and children, via the
      //  store's `deleteNode` prefix match) before the server
      //  round-trip. Snapshot for rollback on failure.
      const snapshot = useTreeStore
        .getState()
        .nodes.filter((n) => n.path === path || n.path.startsWith(`${path}/`));
      useTreeStore.getState().deleteNode(path);
      try {
        if (type === "directory") await deleteFolder(path);
        else await deletePage(path);
      } catch {
        // Roll back every affected node. The store's insertNode is
        //  idempotent on path so a WS `tree:delete` landing after
        //  this rollback just no-ops.
        for (const n of snapshot) useTreeStore.getState().insertNode(n);
        window.alert("Delete failed. The file was restored.");
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
    // Optimistic insert — see handleNewPageFromSidebar for the
    //  pattern. Rollback on server error.
    useTreeStore.getState().insertNode({ id: path, name: `${name}.md`, path, type: "markdown" });
    if (folder && folder !== sidebarFolder) useAppStore.getState().setSidebarFolder(folder);
    useAppStore.getState().setActivePath(path);
    setEditingPath(path);
    setEditingValue(name);
    try {
      await createPage(path, `# ${name}\n`);
    } catch {
      useTreeStore.getState().deleteNode(path);
      setEditingPath(null);
      window.alert("Couldn't create that page.");
    }
  }, [contextMenu, sidebarFolder]);

  const ctxNewFolder = useCallback(async () => {
    if (!contextMenu) return;
    const folder = contextMenu.targetFolder;
    const name = "Untitled";
    const path = folder ? `${folder}/${name}` : name;
    setContextMenu(null);
    // Optimistic insert — directory nodes carry `type: "directory"`
    //  in the tree store. Rollback on server error.
    useTreeStore.getState().insertNode({ id: path, name, path, type: "directory" });
    if (folder && folder !== sidebarFolder) useAppStore.getState().setSidebarFolder(folder);
    setEditingPath(path);
    setEditingValue(name);
    try {
      await createFolder(path);
    } catch {
      useTreeStore.getState().deleteNode(path);
      setEditingPath(null);
      window.alert("Couldn't create that folder.");
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

      {/* ─── Folder breadcrumb (when drilled in). Hidden on the
       *  Agents tab (which fully owns the sidebar body); kept on the
       *  Inbox tab so the tree stays visible behind the content-area
       *  inbox surface. */}
      {!collapsed && sidebarTab !== "agents" && sidebarFolder && (
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
       * motion settles. Hidden on the Agents tab (which owns the
       * sidebar body); rendered for Files + Inbox (Inbox still shows
       * the tree behind the content-area inbox surface).
       */}
      {!collapsed && sidebarTab !== "agents" && (
        <div
          className={`flex-1 overflow-y-auto px-1 py-1 transition-transform duration-(--motion-transit) ease-in-out ${
            slideDir === "left"
              ? "-translate-x-full opacity-0"
              : slideDir === "right"
                ? "translate-x-full opacity-0"
                : "translate-x-0 opacity-100"
          }`}
        >
          <div
            role="tree"
            aria-label="Files and folders"
            onContextMenu={(e) => handleContextMenu(e)}
            onKeyDown={(e) => {
              // WAI-ARIA Authoring Practices §Tree View pattern.
              // Drilling, not expansion, models the existing UX:
              // ArrowRight enters a directory; ArrowLeft pops up.
              // Renames and inputs claim their own keys via
              // stopPropagation, so the rename input above stays
              // usable while focus is technically inside the tree.
              if (visibleItems.length === 0) return;
              const focused = visibleItems[focusedTreeIdx];
              switch (e.key) {
                case "ArrowDown": {
                  e.preventDefault();
                  focusTreeItem(Math.min(focusedTreeIdx + 1, visibleItems.length - 1));
                  return;
                }
                case "ArrowUp": {
                  e.preventDefault();
                  focusTreeItem(Math.max(focusedTreeIdx - 1, 0));
                  return;
                }
                case "Home": {
                  e.preventDefault();
                  focusTreeItem(0);
                  return;
                }
                case "End": {
                  e.preventDefault();
                  focusTreeItem(visibleItems.length - 1);
                  return;
                }
                case "ArrowRight": {
                  if (focused?.type === "directory") {
                    e.preventDefault();
                    drillInto(focused.path);
                  }
                  return;
                }
                case "ArrowLeft": {
                  if (sidebarFolder) {
                    e.preventDefault();
                    drillUp();
                  }
                  return;
                }
                case " ":
                case "Enter": {
                  if (!focused) return;
                  if (editingPath === focused.path) return;
                  e.preventDefault();
                  if (focused.type === "directory") drillInto(focused.path);
                  else openFile(focused.path);
                  return;
                }
              }
            }}
          >
            {visibleItems.length === 0 && (
              <div className="py-8 text-center text-xs text-secondary">No pages yet</div>
            )}
            {visibleItems.map((item, itemIdx) => {
              const isDir = item.type === "directory";
              const isActive = activePath === item.path;
              const isEditing = editingPath === item.path;

              const isDropTarget = isDir && dropTarget === item.path && dropEdge === null;
              const isFocusedRow = itemIdx === focusedTreeIdx;
              const showLineBefore = dropTarget === item.path && dropEdge === "before";
              const showLineAfter = dropTarget === item.path && dropEdge === "after";
              return (
                // The row is `role="treeitem"` (semantic). Keyboard
                // activation is handled by the parent tree's
                // `onKeyDown`, not this row, so biome's
                // useKeyWithClickEvents rule is satisfied at the
                // tree level rather than per-row.
                // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activation handled at tree-container level
                <div
                  key={item.path}
                  ref={(el) => {
                    treeItemRefs.current[itemIdx] = el;
                  }}
                  className={`group relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-all duration-(--motion-snap) ${
                    isActive
                      ? "sidebar-item-active text-primary"
                      : isDropTarget
                        ? "border border-ironlore-blue bg-ironlore-slate-hover text-primary"
                        : "text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
                  }`}
                  draggable={!isDir && !isEditing}
                  onDragStart={(e) => !isDir && handleDragStart(e, item.path)}
                  onDragOver={(e) => handleRowDragOver(e, item)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => void handleRowDrop(e, item)}
                  onClick={() => {
                    if (isEditing) return;
                    setFocusedTreeIdx(itemIdx);
                    if (isDir) drillInto(item.path);
                    else openFile(item.path);
                  }}
                  onContextMenu={(e) => {
                    e.stopPropagation();
                    handleContextMenu(e, item.path, item.type, item.name);
                  }}
                  role="treeitem"
                  // `aria-level` reflects the current drill depth so
                  //  screen readers announce nested folders correctly.
                  //  Root listing = level 1; one-deep folder = level 2;
                  //  etc. Computed from `sidebarFolder`'s slash count.
                  aria-level={
                    sidebarFolder === "" ? 1 : sidebarFolder.split("/").filter(Boolean).length + 1
                  }
                  aria-selected={isActive}
                  // `aria-expanded` deliberately omitted: the sidebar
                  //  uses drill-into navigation rather than tree
                  //  expand/collapse, so claiming `aria-expanded={false}`
                  //  every time was a false signal to assistive tech.
                  //  Drop the attribute and let directories carry their
                  //  semantics through `role="treeitem"` + the click
                  //  handler that switches `sidebarFolder`.
                  tabIndex={isFocusedRow ? 0 : -1}
                >
                  {/* Drop-line indicator: 2 px line above (before) or
                   *  below (after) the row. Both edges resolve to
                   *  "drop into the parent folder" — the line is a
                   *  placement *cue*, not an ordering primitive. */}
                  {showLineBefore && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-1 -top-px h-0.5 rounded-full"
                      style={{ background: "var(--il-blue)" }}
                    />
                  )}
                  {showLineAfter && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-1 -bottom-px h-0.5 rounded-full"
                      style={{ background: "var(--il-blue)" }}
                    />
                  )}
                  <FileIcon type={item.type} open={isDropTarget} />
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
                    <>
                      <FolderPeekButton folder={item} />
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-secondary opacity-0 group-hover:opacity-100" />
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {/* "+ New page" used to live as the last row of the file list,
           *  but it gets buried below the fold in long trees. The trigger
           *  has moved to the sticky bottom rail (see NewPageRail below);
           *  this comment is retained for orientation. */}
        </div>
      )}

      {/* Collapsed: no list shown — the bottom rail still renders. */}
      {collapsed && <div className="flex-1" />}

      {/* Inbox is a full-screen surface routed via the content
       *  area (ContentArea reads `sidebarTab === "inbox"` and renders
       *  <InboxPanel /> in place of the editor). The sidebar's INBOX
       *  tab is the trigger + state indicator; the tree stays
       *  visible behind it. */}

      {/* ─── Agents tab body ─── promoted from a footer section to a
       *  full-body sidebar surface. Renders only when the AGENTS tab
       *  is active; the file tree above is hidden in that mode so
       *  the agent list owns the scroll. */}
      {!collapsed && sidebarTab === "agents" && <AgentsPanel collapsed={false} expanded />}

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

      {/* ─── Sticky "New page" rail ─── full-width primary action that
       *  always sits at the bottom of the sidebar regardless of how
       *  long the tree gets. The chord chip mirrors the global ⌘N
       *  binding wired below in a useEffect. */}
      {!collapsed && <NewPageRail onClick={handleNewPageFromSidebar} />}

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
  active: "files" | "agents" | "inbox";
  inboxCount: number;
  onSelect: (tab: "files" | "agents" | "inbox") => void;
}) {
  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-0.5 border-b border-border px-1 py-1.5">
        <SidebarBottomTab icon={Home} label="Files" collapsed onClick={() => onSelect("files")} />
        <SidebarBottomTab icon={Bot} label="Agents" collapsed onClick={() => onSelect("agents")} />
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

  // Full-width tabs that span the sidebar — each cell is 1/3 of the
  //  bar. Active tab fills with `var(--il-slate-elev)` AND shows its
  //  label; inactive tabs show only the icon (the full label only
  //  appears on the selected tab so the bar reads cleanly even at
  //  narrow widths). Mirrors mobile-bottom-nav patterns where the
  //  active label provides the "you are here" cue and the inactive
  //  icons stay scannable.
  return (
    <div
      className="grid border-b border-border"
      style={{
        gridTemplateColumns: "1fr 1fr 1fr",
        height: 36,
      }}
    >
      <SidebarTabPill
        icon={Home}
        label="Files"
        active={active === "files"}
        onClick={() => onSelect("files")}
      />
      <SidebarTabPill
        icon={Bot}
        label="Agents"
        active={active === "agents"}
        onClick={() => onSelect("agents")}
      />
      <SidebarTabPill
        icon={InboxIcon}
        label="Inbox"
        active={active === "inbox"}
        badge={inboxCount > 0 ? inboxCount : undefined}
        onClick={() => onSelect("inbox")}
      />
    </div>
  );
}

function SidebarTabPill({
  icon: Icon,
  label,
  active,
  badge,
  onClick,
}: {
  icon?: React.ComponentType<{ className?: string }>;
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
      aria-label={label}
      className="flex items-center justify-center gap-1.5 outline-none transition-colors duration-(--motion-snap) focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
      style={{
        background: active ? "var(--il-slate-elev)" : "transparent",
        color: active ? "var(--il-text)" : "var(--il-text3)",
        fontFamily: "var(--font-sans)",
        fontSize: 12.5,
        fontWeight: active ? 500 : 400,
        // Subtle bottom rule on active so the tab still reads as
        //  "selected" even when the bg-color tint is muted.
        boxShadow: active ? "inset 0 -1.5px 0 var(--il-blue)" : "none",
      }}
    >
      {Icon && <Icon className="h-4 w-4 shrink-0" />}
      {/* Active tab shows the label; inactive tabs are icon-only.
       *  The icon's `aria-label` (set on the button) carries the
       *  semantic name for screen readers regardless. */}
      {active && <span className="truncate">{label}</span>}
      {badge !== undefined && (
        <span
          aria-hidden="true"
          className="inline-flex items-center justify-center"
          style={{
            minWidth: 14,
            height: 14,
            padding: "0 4px",
            borderRadius: 7,
            fontSize: 10,
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
function AgentsPanel({ collapsed, expanded }: { collapsed: boolean; expanded?: boolean }) {
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
      window.alert(
        "Slug must be 3–32 chars, lowercase letters/digits/dashes; no leading/trailing dash.",
      );
      return;
    }
    const path = `.agents/${clean}/persona.md`;
    // Title-case the slug for the display `name:` — `web-scraper` →
    //  `Web Scraper`. The persona parser falls back to slug when
    //  `name` is missing, but every UI surface that lists agents
    //  reads `name` first; without it, the new agent renders as its
    //  raw slug everywhere (Settings → Agents, AI panel picker,
    //  Inbox attribution column).
    const displayName = clean
      .split("-")
      .filter(Boolean)
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join(" ");
    const template =
      "---\n" +
      `name: ${displayName}\n` +
      `slug: ${clean}\n` +
      "description: \n" +
      "heartbeat: \n" +
      "review_mode: inbox\n" +
      "tools: []\n" +
      "scope:\n" +
      "  pages: []\n" +
      "  writable_kinds: []\n" +
      "---\n\n" +
      `# ${displayName}\n\nDescribe what this agent does.\n`;
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
    <div
      className={
        expanded ? "flex-1 overflow-y-auto px-3 py-2.5" : "border-t border-border px-3 py-2.5"
      }
    >
      {/* Mono `AGENTS` overline — the separator the user asked for.
       *  Trailing meta echoes the Home §01 grammar (`N RUNNING · N
       *  QUEUED`) so the vocabulary is consistent across surfaces.
       *  When `expanded` (Agents tab body), the overline is hidden
       *  because the SidebarTabs row already labels the surface. */}
      {!expanded && (
        <div
          className="mb-2 flex items-center gap-2 font-mono uppercase"
          style={{ fontSize: 10.5, color: "var(--il-text3)", letterSpacing: "0.08em" }}
        >
          <span>Agents</span>
          <span className="flex-1" />
          {/* Counter is status text — uses text3 (AA-clearing) rather
           *  than text4 so screen-readers + low-vision users can read
           *  the running / total count. */}
          <span style={{ color: "var(--il-text3)" }}>
            {runningCount > 0 ? `${runningCount} running` : `${agents.length}`}
          </span>
        </div>
      )}

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
                      // Status text — text3 clears WCAG AA, text4
                      // does not. Running / paused use signal
                      // colours that already clear contrast.
                      color: a.running
                        ? "var(--il-blue)"
                        : paused
                          ? "var(--il-amber)"
                          : "var(--il-text3)",
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
        <span aria-hidden="true" style={{ fontFamily: "var(--font-mono)" }}>
          +
        </span>
        <span className="font-mono uppercase">add agent</span>
      </button>
    </div>
  );
}

/**
 * NewPageRail — full-width sticky bottom action that creates a new
 * page in the current `sidebarFolder` (or at the vault root when
 * none is drilled into). Mirrors the click target wired into the
 * global ⌘N keymap. Larger than tree rows on purpose: this is the
 * primary creation affordance for the whole sidebar.
 */
function NewPageRail({ onClick }: { onClick: () => void }) {
  const isMac = typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  const chord = isMac ? "⌘N" : "Ctrl+N";
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full shrink-0 items-center gap-2 px-3 outline-none transition-colors hover:bg-ironlore-slate-hover focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
      style={{
        height: 36,
        borderTop: "1px solid var(--il-border-soft)",
        background: "var(--il-slate)",
        color: "var(--il-text)",
        fontSize: 13.5,
        fontWeight: 500,
        textAlign: "left",
      }}
      title={`Create a new page (${chord})`}
    >
      <FilePlus className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="flex-1 truncate">New page</span>
      <span
        aria-hidden="true"
        className="font-mono"
        style={{
          fontSize: 11,
          color: "var(--il-text3)",
          letterSpacing: "0.04em",
        }}
      >
        {chord}
      </span>
    </button>
  );
}
