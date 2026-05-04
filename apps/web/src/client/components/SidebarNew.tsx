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
  Moon,
  Music,
  PanelLeftClose,
  PanelLeftOpen,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Sun,
  Terminal as TerminalIcon,
  Video,
  Workflow,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceActivity } from "../hooks/useWorkspaceActivity.js";
import {
  activateAgent,
  createFolder,
  createPage,
  deleteFolder,
  deletePage,
  fetchLibraryTemplates,
  fetchTree,
  type LibraryTemplate,
  movePage,
} from "../lib/api.js";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, useAppStore } from "../stores/app.js";
import { useAuthStore } from "../stores/auth.js";
import { useTreeStore } from "../stores/tree.js";
import { MOTION } from "../styles/motion.js";
import { FolderPeekButton } from "./FolderPeek.js";
import { InboxPanel } from "./InboxPanel.js";
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

  // ─── Touchpad two-finger horizontal swipe → drill / back ─────────
  //  Per the redesign brief: swipe right-to-left (positive deltaX in
  //  macOS wheel events) shows sub-content (drill into the focused
  //  directory if any); swipe left-to-right (negative deltaX) goes
  //  back to the parent. The animation directions match the
  //  click-driven `slideDir` so touchpad nav is indistinguishable
  //  from click nav.
  //
  //  We only treat the gesture as horizontal when the X-axis delta
  //  dominates the Y-axis (1.5×) — this avoids hijacking vertical
  //  scrolls that happen to have a small X component. After firing,
  //  we lock for 600ms so a single sustained swipe doesn't drill
  //  multiple levels in one motion. The accumulator also resets
  //  between swipes via a 200ms idle reset.
  const swipeAccumRef = useRef<{ deltaX: number; lastTs: number; lockedUntil: number }>({
    deltaX: 0,
    lastTs: 0,
    lockedUntil: 0,
  });
  const SWIPE_THRESHOLD_PX = 80;
  const SWIPE_LOCK_MS = 600;
  const SWIPE_IDLE_RESET_MS = 200;

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
      {/* ─── Sidebar top chrome ───
       *  After the AppHeader was retired, this row is the app's only
       *  identity surface: logo + `ironlore` wordmark + Settings /
       *  Search / Theme icon buttons. The project switcher used to
       *  sit here; it moved to the bottom of the sidebar so the
       *  always-visible chrome is global controls, not project
       *  context. */}
      <SidebarTopChrome collapsed={collapsed} />

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

      {/* ─── Folder breadcrumb ─── upgraded for visibility per the
       *  redesign brief: each segment renders as a clickable pill on
       *  a `--il-slate-elev` row with a left ↑ "up" / Home anchor
       *  and the current folder name at higher contrast + size. The
       *  drop targets behind Home / ↑ are preserved; the segment
       *  pills don't accept drops (single-jump nav rather than
       *  drag-into-arbitrary-ancestor). */}
      {!collapsed && sidebarTab === "files" && sidebarFolder && (
        <SidebarBreadcrumb
          folder={sidebarFolder}
          drillToRoot={drillToRoot}
          drillUp={drillUp}
          dropTarget={dropTarget}
          handleDragOver={handleDragOver}
          handleDragLeave={handleDragLeave}
          handleDrop={handleDrop}
        />
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
      {!collapsed && sidebarTab === "files" && (
        <div
          className={`flex-1 overflow-y-auto px-1 py-1 transition-transform duration-(--motion-transit) ease-in-out ${
            slideDir === "left"
              ? "-translate-x-full opacity-0"
              : slideDir === "right"
                ? "translate-x-full opacity-0"
                : "translate-x-0 opacity-100"
          }`}
          onWheel={(e) => {
            // Touchpad two-finger horizontal swipe → drill / back.
            //  Only fires when |deltaX| dominates |deltaY| by 1.5×
            //  so vertical scrolls with a hint of X drift don't
            //  hijack folder nav.
            const accum = swipeAccumRef.current;
            const now = Date.now();
            if (now < accum.lockedUntil) return;
            if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.5) return;
            // Idle-reset: a long pause between wheel events restarts
            //  the accumulator so a slow back-and-forth gesture
            //  doesn't sum to a phantom swipe.
            if (now - accum.lastTs > SWIPE_IDLE_RESET_MS) accum.deltaX = 0;
            accum.deltaX += e.deltaX;
            accum.lastTs = now;
            if (accum.deltaX >= SWIPE_THRESHOLD_PX) {
              // R→L swipe (deltaX > 0) → drill into the focused
              //  directory if there is one. Without a focused dir
              //  we no-op rather than guess; the user keeps clicking
              //  to drill in.
              const focused = visibleItems[focusedTreeIdx];
              if (focused?.type === "directory") drillInto(focused.path);
              accum.deltaX = 0;
              accum.lockedUntil = now + SWIPE_LOCK_MS;
            } else if (accum.deltaX <= -SWIPE_THRESHOLD_PX) {
              // L→R swipe (deltaX < 0) → drillUp (parent). No-op at
              //  the root; the breadcrumb's Home anchor handles deep
              //  drill-back.
              if (sidebarFolder) drillUp();
              accum.deltaX = 0;
              accum.lockedUntil = now + SWIPE_LOCK_MS;
            }
          }}
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

      {/* ─── Inbox tab body ─── moved from the content area into the
       *  sidebar per the redesign brief. The full InboxPanel renders
       *  here; users widen the sidebar via the resize handle when
       *  reviewing a busy inbox. The content area no longer routes
       *  to InboxPanel. */}
      {!collapsed && sidebarTab === "inbox" && (
        <div className="flex-1 overflow-hidden">
          <InboxPanel />
        </div>
      )}

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

      {/* ─── Files-tab "New page" rail ─── primary creation action
       *  for the Files tab. Pinned beneath the lowermost row in the
       *  tree. The Agents tab has its own NewAgentRail rendered
       *  inside AgentsPanel; the Inbox tab has no creation surface,
       *  so we gate this rail to `sidebarTab === "files"`. */}
      {!collapsed && sidebarTab === "files" && <NewPageRail onClick={handleNewPageFromSidebar} />}

      {/* ─── Project switcher tile ─── moved from the top of the
       *  sidebar to the bottom per the redesign brief. The top is
       *  now global chrome (logo + settings + search + theme); the
       *  bottom is project context. Clicking the tile opens the
       *  project switcher modal anchored above this tile (see
       *  ProjectSwitcher). */}
      {!collapsed && <ProjectTile collapsed={false} />}
      {collapsed && <ProjectTile collapsed={true} />}

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
    // Clicking any collapsed-state tab icon expands the sidebar AND
    //  switches to that tab in one motion (`openSidebarTab` does
    //  both via the existing store helper). Mirrors the sidebar
    //  redesign's "click any icon while collapsed → re-open" rule.
    const openTab = (tab: "files" | "agents" | "inbox") => {
      useAppStore.getState().openSidebarTab(tab);
      onSelect(tab);
    };
    return (
      <div className="flex flex-col items-center gap-0.5 border-b border-border px-1 py-1.5">
        <SidebarBottomTab icon={Home} label="Files" collapsed onClick={() => openTab("files")} />
        <SidebarBottomTab icon={Bot} label="Agents" collapsed onClick={() => openTab("agents")} />
        <SidebarBottomTab
          icon={InboxIcon}
          label="Inbox"
          collapsed
          badge={inboxCount > 0 ? inboxCount : undefined}
          onClick={() => openTab("inbox")}
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
/**
 * SidebarBreadcrumb — the in-tab navigator for the Files surface.
 *
 * Upgraded for visibility per the redesign brief: a 28px-tall row on
 * `var(--il-slate-elev)` with a Home anchor (root), an Up arrow
 * (parent), and one pill per path segment. The current folder pill
 * is highlighted (`var(--il-text)` + bold); ancestor segments are
 * clickable and drill straight to that level. Drop targets behind
 * Home + Up are preserved; segment pills don't accept drops to keep
 * the drag interaction model simple.
 */
function SidebarBreadcrumb({
  folder,
  drillToRoot,
  drillUp,
  dropTarget,
  handleDragOver,
  handleDragLeave,
  handleDrop,
}: {
  folder: string;
  drillToRoot: () => void;
  drillUp: () => void;
  dropTarget: string | null;
  handleDragOver: (e: React.DragEvent, target: string, valid: boolean) => void;
  handleDragLeave: () => void;
  handleDrop: (e: React.DragEvent, targetDir: string) => Promise<void> | void;
}) {
  const segments = folder.split("/");
  // Pre-compute each segment's cumulative path so clicking jumps
  //  directly to that level (rather than walking up one-by-one).
  const segmentPaths = segments.map((_, i) => segments.slice(0, i + 1).join("/"));
  return (
    <div
      className="flex items-center gap-1 overflow-x-auto border-b border-border"
      style={{
        padding: "6px 8px",
        background: "var(--il-slate-elev)",
        fontSize: 13,
      }}
    >
      <button
        type="button"
        onClick={drillToRoot}
        onDragOver={(e) => handleDragOver(e, "__root__", true)}
        onDragLeave={handleDragLeave}
        onDrop={(e) => void handleDrop(e, "")}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded outline-none transition-colors hover:bg-ironlore-slate-hover hover:text-primary focus-visible:ring-1 focus-visible:ring-ironlore-blue/50 ${
          dropTarget === "__root__"
            ? "bg-ironlore-slate-hover text-primary ring-1 ring-ironlore-blue"
            : "text-secondary"
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
          const parts = folder.split("/");
          parts.pop();
          void handleDrop(e, parts.join("/"));
        }}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded outline-none transition-colors hover:bg-ironlore-slate-hover hover:text-primary focus-visible:ring-1 focus-visible:ring-ironlore-blue/50 ${
          dropTarget === "__up__"
            ? "bg-ironlore-slate-hover text-primary ring-1 ring-ironlore-blue"
            : "text-secondary"
        }`}
        title="Go up one level (drop here to move up)"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <span aria-hidden="true" style={{ color: "var(--il-text4)" }}>
        ·
      </span>
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        const targetPath = segmentPaths[i] ?? "";
        return (
          <span key={targetPath} className="flex items-center gap-1">
            <button
              type="button"
              onClick={() =>
                isLast ? undefined : useAppStore.getState().setSidebarFolder(targetPath)
              }
              disabled={isLast}
              className={`shrink-0 rounded px-1.5 py-0.5 outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ironlore-blue/50 ${
                isLast ? "" : "hover:bg-ironlore-slate-hover hover:text-primary"
              }`}
              style={{
                color: isLast ? "var(--il-text)" : "var(--il-text2)",
                fontWeight: isLast ? 600 : 400,
                cursor: isLast ? "default" : "pointer",
                maxWidth: 120,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={targetPath}
            >
              {seg}
            </button>
            {!isLast && (
              <span aria-hidden="true" style={{ color: "var(--il-text4)" }}>
                /
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

/**
 * SidebarTopChrome — replaces the retired top platform header
 * ([AppHeader.tsx]). Holds the global app identity + chrome:
 *
 *   Expanded:  [Logo] ironlore                  [⚙]  [🔍]  [☀/🌙]  [⮜]
 *   Collapsed: [Logo]      (the whole tile click-expands the sidebar)
 *
 * Per the user's sidebar redesign brief: "Remove the top header of
 * the platform completely and add the settings, search and dark
 * mode, where the project switcher was. Next to the logo add
 * 'ironlore'." The collapse chevron is the one chrome control
 * inherited from the prior logo row — without it the sidebar has
 * no visible collapse affordance (only ⌘B / drag-to-collapse).
 *
 * Click on the logo or wordmark routes to Home (clears `activePath`
 * + `activeAgentSlug`) so the brand mark always honours the
 * "click-to-home" convention.
 */
function SidebarTopChrome({ collapsed }: { collapsed: boolean }) {
  const theme = useAppStore((s) => s.theme);
  const goHome = useCallback(() => {
    const store = useAppStore.getState();
    store.setActivePath(null);
    store.setActiveAgentSlug(null);
  }, []);

  if (collapsed) {
    // Collapsed: the whole tile is a click-expand target with the
    //  Ironlore mark in the centre. Hovering reveals the chevron
    //  (mirrors the pre-existing collapsed-tile behaviour).
    return (
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
    );
  }

  return (
    <div
      className="relative flex h-10 items-center gap-1 border-b border-border px-2"
      style={{ flexShrink: 0 }}
    >
      <button
        type="button"
        onClick={goHome}
        className="flex items-center gap-2 rounded-[3px] px-1 py-1 outline-none hover:bg-ironlore-slate-hover focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
        aria-label="Ironlore home"
        title="Home"
      >
        <Logo size={18} />
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 13.5,
            fontWeight: 500,
            letterSpacing: "-0.02em",
            color: "var(--il-text)",
          }}
        >
          ironlore
        </span>
      </button>
      <span className="flex-1" />
      <ChromeIconButton
        icon={SettingsIcon}
        ariaLabel="Settings"
        title="Settings"
        onClick={() => useAppStore.getState().toggleSettings("general")}
      />
      <ChromeIconButton
        icon={SearchIcon}
        ariaLabel="Search (⌘K)"
        title="Search"
        onClick={() => useAppStore.getState().toggleSearchDialog()}
      />
      <ChromeIconButton
        icon={theme === "dark" ? Sun : Moon}
        ariaLabel={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        title={theme === "dark" ? "Light mode" : "Dark mode"}
        onClick={() => useAppStore.getState().toggleTheme()}
      />
      <ChromeIconButton
        icon={PanelLeftClose}
        ariaLabel="Collapse sidebar"
        title="Collapse sidebar (⌘B)"
        onClick={() => useAppStore.getState().toggleSidebar()}
      />
    </div>
  );
}

function ChromeIconButton({
  icon: Icon,
  ariaLabel,
  title,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  ariaLabel: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={title}
      className="flex h-7 w-7 items-center justify-center rounded text-secondary outline-none transition-colors duration-(--motion-snap) hover:bg-ironlore-slate-hover hover:text-primary focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

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
  // Collapsed-state click also expands the sidebar so the redesign
  //  rule "any icon click while collapsed re-opens the sidebar"
  //  holds for the project switcher tile too.
  const onClickCollapsed = () => {
    useAppStore.getState().setSidebarOpen(true);
    onClick();
  };

  if (collapsed) {
    return (
      <div className="flex items-center justify-center border-b border-border px-2 py-2">
        <button
          type="button"
          onClick={onClickCollapsed}
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
    //  Clicking opens the Agents tab in the expanded sidebar (the
    //  redesign rule "any icon click → re-open" — see onClick
    //  below); the previous "jump to first running agent's detail"
    //  behaviour was lossy because there's no signal a user wants
    //  that specific agent vs. the list.
    if (agents.length === 0) return null;
    return (
      <button
        type="button"
        onClick={() => {
          // Click while collapsed → expand sidebar AND open the
          //  Agents tab; jumping straight to a single agent's detail
          //  page from the collapsed rail loses the surrounding
          //  context. Per redesign: "any icon click → re-open."
          useAppStore.getState().openSidebarTab("agents");
        }}
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

      {/* Library templates — un-activated personas curated under
       *  `.agents/.library/` (Researcher, Wiki Gardener, Evolver per
       *  docs/04-ai-and-agents.md §Default agents). Surfacing them
       *  here gives the Agents tab content even when only the
       *  default seeded agents are installed and turns "agent list
       *  looks empty" into a clear next action: pick a template →
       *  one-click Activate. */}
      {expanded && <LibraryTemplatesSection />}

      {/* Primary "New agent" rail per the sidebar redesign — same
       *  visual contract as Files-tab "New page", scaffolds the
       *  same persona template so the engine picks it up on next
       *  poll. The legacy dashed-border `+ add agent` row was retired
       *  in favour of this larger, lighter-bg primary action so the
       *  Agents tab grows a proper bottom-aligned creation surface. */}
      {expanded && <NewAgentRail onClick={onAdd} />}
    </div>
  );
}

/**
 * LibraryTemplatesSection — surfaces inert library personas
 * (`.agents/.library/<slug>/persona.md`) as one-click "Activate"
 * cards beneath the active-agents list. The Agents tab can otherwise
 * read empty for users who only have the seeded Librarian + Editor
 * defaults; this section turns that empty space into a discovery
 * surface. Activation calls `POST /agents/<slug>/activate`, which
 * scaffolds the persona under `.agents/<slug>/`; on success the
 * activity poller picks the new agent up and the row promotes itself
 * into the active list above.
 */
function LibraryTemplatesSection() {
  const [templates, setTemplates] = useState<LibraryTemplate[] | null>(null);
  const [activating, setActivating] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void fetchLibraryTemplates()
      .then(setTemplates)
      .catch(() => setTemplates([]));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onActivate = useCallback(
    async (slug: string) => {
      setActivating(slug);
      try {
        await activateAgent(slug);
        refresh();
      } catch (err) {
        window.alert(err instanceof Error ? err.message : "Couldn't activate that template.");
      } finally {
        setActivating(null);
      }
    },
    [refresh],
  );

  if (templates === null) return null;
  if (templates.length === 0) return null;

  return (
    <div className="mt-4">
      <div
        className="mb-2 flex items-center gap-2 font-mono uppercase"
        style={{ fontSize: 10.5, color: "var(--il-text3)", letterSpacing: "0.08em" }}
      >
        <span>Templates</span>
        <span className="flex-1" />
        <span style={{ color: "var(--il-text3)" }}>{templates.length}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {templates.map((tpl) => (
          <div
            key={tpl.slug}
            className="rounded border"
            style={{
              padding: "8px 10px",
              borderColor: "var(--il-border-soft)",
              background: "color-mix(in oklch, var(--il-slate-elev) 50%, transparent)",
            }}
          >
            <div className="flex items-center gap-2">
              {tpl.emoji && <span style={{ fontSize: 14 }}>{tpl.emoji}</span>}
              <span
                className="truncate"
                style={{ fontSize: 12.5, fontWeight: 500, color: "var(--il-text)" }}
              >
                {tpl.name ?? tpl.slug}
              </span>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => onActivate(tpl.slug)}
                disabled={activating === tpl.slug}
                className="rounded px-2 py-0.5 font-mono uppercase outline-none transition-colors hover:bg-ironlore-blue/15 focus-visible:ring-1 focus-visible:ring-ironlore-blue/50 disabled:opacity-50"
                style={{
                  fontSize: 10,
                  letterSpacing: "0.06em",
                  border: "1px solid color-mix(in oklch, var(--il-blue) 35%, transparent)",
                  color: "var(--il-blue)",
                }}
              >
                {activating === tpl.slug ? "…" : "Activate"}
              </button>
            </div>
            {(tpl.description || tpl.role) && (
              <p
                className="mt-1 truncate"
                style={{ fontSize: 11, color: "var(--il-text3)", lineHeight: 1.4 }}
                title={tpl.description ?? tpl.role ?? ""}
              >
                {tpl.description ?? tpl.role}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * NewPageRail — primary action row pinned beneath the lowermost
 * file in the Files tab. Centered label, larger font + height, bg
 * lighter than the sidebar (slate-elev > slate per
 * docs/09-ui-and-brand.md), with a transit-snap hover lift and
 * active-press depth so the button reads as the primary creation
 * affordance for the whole tab. Mirrors the global ⌘N keymap.
 */
function NewPageRail({ onClick }: { onClick: () => void }) {
  const isMac = typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  const chord = isMac ? "⌘N" : "Ctrl+N";
  return <PrimaryActionRail icon={FilePlus} label="New page" chord={chord} onClick={onClick} />;
}

/**
 * NewAgentRail — sibling of NewPageRail for the Agents tab. Same
 * shape; the only difference is the icon + label + the click handler
 * (delegates to whatever the parent supplies — typically the same
 * `onAdd` callback the AgentsPanel exposes via its `+ add agent`
 * button so both surfaces ship to the same place).
 */
function NewAgentRail({ onClick }: { onClick: () => void }) {
  return <PrimaryActionRail icon={Bot} label="New agent" onClick={onClick} />;
}

/**
 * Shared visual contract for both the Files and Agents bottom
 * action rails. Centered text, lighter-than-sidebar bg, hover lift,
 * active-press depth — the primary creation affordance per
 * docs/09-ui-and-brand.md §Buttons. Optional chord chip floats to
 * the right; when omitted the label centers visually. Sized larger
 * than tree rows so the button reads as a deliberate primary
 * action, not just another row.
 */
function PrimaryActionRail({
  icon: Icon,
  label,
  chord,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  chord?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="il-sidebar-action-rail group relative flex w-full shrink-0 items-center justify-center outline-none transition-all duration-(--motion-snap) focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
      style={{
        height: 44,
        margin: "8px 10px",
        width: "calc(100% - 20px)",
        borderRadius: 6,
        // Lighter than the sidebar per the user's spec — slate-elev
        //  is the documented "card / elevated surface" tier.
        background: "var(--il-slate-elev)",
        border: "1px solid var(--il-border-soft)",
        color: "var(--il-text)",
        fontFamily: "var(--font-sans)",
        fontSize: 14,
        fontWeight: 500,
      }}
      title={chord ? `${label} (${chord})` : label}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="ml-2">{label}</span>
      {chord && (
        <span
          aria-hidden="true"
          className="absolute font-mono"
          style={{
            right: 12,
            fontSize: 10.5,
            color: "var(--il-text3)",
            letterSpacing: "0.04em",
          }}
        >
          {chord}
        </span>
      )}
    </button>
  );
}
