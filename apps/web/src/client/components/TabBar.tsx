import type { PageType } from "@ironlore/core";
import { detectPageType } from "@ironlore/core";
import {
  Captions,
  FileCode,
  FileSpreadsheet,
  FileText,
  FileType,
  Image,
  Mail,
  Music,
  Video,
  Workflow,
  X,
} from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useCallback } from "react";
import { useAppStore } from "../stores/app.js";

/**
 * Map PageType → Lucide icon. Mirrors the sidebar table but returns a
 * smaller, tab-sized icon.
 */
function tabIcon(type: PageType) {
  const cls = "h-3.5 w-3.5 shrink-0 text-secondary";
  switch (type) {
    case "markdown":
    case "text":
      return <FileText className={cls} />;
    case "pdf":
    case "word":
      return <FileType className={cls} />;
    case "csv":
    case "excel":
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
    case "transcript":
      return <Captions className={cls} />;
    case "email":
      return <Mail className={cls} />;
    default:
      return <FileText className={cls} />;
  }
}

/**
 * VS Code–style tab strip. Shows every open file; the active tab is
 * highlighted. Middle-click or the X closes a tab. Falls back to the
 * neighbor to the left when the active tab is closed.
 *
 * Rendered only when at least one tab is open so it doesn't take up
 * chrome space on the welcome screen.
 */
export function TabBar() {
  const openPaths = useAppStore((s) => s.openPaths);
  const activePath = useAppStore((s) => s.activePath);

  const onClick = useCallback((path: string) => {
    useAppStore.getState().setActivePath(path);
  }, []);

  const onClose = useCallback((e: MouseEvent, path: string) => {
    e.stopPropagation();
    useAppStore.getState().closeTab(path);
  }, []);

  const onAuxClick = useCallback((e: MouseEvent, path: string) => {
    // Middle-click closes the tab.
    if (e.button === 1) {
      e.preventDefault();
      useAppStore.getState().closeTab(path);
    }
  }, []);

  const onKey = useCallback(
    (e: KeyboardEvent, path: string) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        useAppStore.getState().setActivePath(path);
        return;
      }
      // Tab-pattern keyboard nav — WAI-ARIA authoring practices.
      const i = openPaths.indexOf(path);
      let target: string | undefined;
      if (e.key === "ArrowRight") target = openPaths[i + 1];
      else if (e.key === "ArrowLeft") target = openPaths[i - 1];
      else if (e.key === "Home") target = openPaths[0];
      else if (e.key === "End") target = openPaths[openPaths.length - 1];
      else if (e.key === "Delete" || (e.key === "Backspace" && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        useAppStore.getState().closeTab(path);
        return;
      }
      if (target) {
        e.preventDefault();
        useAppStore.getState().setActivePath(target);
        // Move focus to the newly activated tab so arrow-nav continues.
        requestAnimationFrame(() => {
          const el = document.querySelector<HTMLElement>(`[data-tab-path="${target}"]`);
          el?.focus();
        });
      }
    },
    [openPaths],
  );

  if (openPaths.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-label="Open files"
      className="flex shrink-0 items-stretch overflow-x-auto border-b border-border bg-ironlore-slate"
    >
      {openPaths.map((path) => {
        const name = path.split("/").pop() ?? path;
        const type = detectPageType(path);
        const active = path === activePath;
        return (
          <div
            key={path}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            data-tab-path={path}
            onClick={() => onClick(path)}
            onAuxClick={(e) => onAuxClick(e, path)}
            onKeyDown={(e) => onKey(e, path)}
            title={path}
            className={`group flex cursor-pointer items-center gap-1.5 border-r border-border px-3 py-1.5 text-xs ${
              active
                ? "bg-ironlore-slate-hover text-primary"
                : "text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
            }`}
          >
            {tabIcon(type)}
            <span className="max-w-40 truncate">{name}</span>
            <button
              type="button"
              onClick={(e) => onClose(e, path)}
              aria-label={`Close ${name}`}
              className="ml-1 rounded p-0.5 opacity-0 hover:bg-ironlore-slate group-hover:opacity-100 aria-selected:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
