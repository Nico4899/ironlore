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
 * Compute display labels for a list of tab paths. When two or more paths
 * share a basename, walk parent segments outward until each label is
 * unique — `editor / persona.md` vs `general / persona.md` instead of
 * two indistinguishable `persona.md` tabs.
 *
 * Result keys are the original paths so the caller can look up labels in
 * stable iteration order.
 */
export function disambiguateTabLabels(paths: readonly string[]): Map<string, string> {
  const labels = new Map<string, string>();
  if (paths.length === 0) return labels;

  // Pre-split each path into segments so we can grow labels segment-by-segment.
  const segments = new Map<string, string[]>();
  for (const p of paths) segments.set(p, p.split("/"));

  // Start every label at depth 1 (basename only); expand collided labels
  // until each is unique.
  const depths = new Map<string, number>();
  for (const p of paths) depths.set(p, 1);

  while (true) {
    const current = new Map<string, string[]>();
    for (const p of paths) {
      const segs = segments.get(p) ?? [];
      const depth = Math.min(depths.get(p) ?? 1, segs.length);
      const label = segs.slice(-depth).join(" / ");
      if (!current.has(label)) current.set(label, []);
      current.get(label)?.push(p);
    }

    let didExpand = false;
    for (const [, owners] of current) {
      if (owners.length <= 1) continue;
      for (const p of owners) {
        const segs = segments.get(p) ?? [];
        const d = depths.get(p) ?? 1;
        if (d < segs.length) {
          depths.set(p, d + 1);
          didExpand = true;
        }
      }
    }
    if (!didExpand) {
      for (const [label, owners] of current) {
        for (const p of owners) labels.set(p, label);
      }
      return labels;
    }
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

  const labels = disambiguateTabLabels(openPaths);

  return (
    <div
      role="tablist"
      aria-label="Open files"
      className="flex shrink-0 items-stretch overflow-x-auto border-b border-border bg-ironlore-slate"
    >
      {openPaths.map((path) => {
        const label = labels.get(path) ?? path.split("/").pop() ?? path;
        const closeLabel = path.split("/").pop() ?? path;
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
            className={`group relative flex cursor-pointer items-center gap-1.5 border-r border-border px-3 py-1.5 text-xs ${
              active
                ? "bg-background font-medium text-primary"
                : "text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
            }`}
          >
            {active && (
              <span
                aria-hidden="true"
                className="absolute inset-x-0 bottom-0 h-0.5 bg-ironlore-blue"
              />
            )}
            {tabIcon(type)}
            <span className="max-w-40 truncate">{label}</span>
            <button
              type="button"
              onClick={(e) => onClose(e, path)}
              aria-label={`Close ${closeLabel}`}
              className={`ml-1 rounded p-0.5 hover:bg-ironlore-slate-hover ${
                active ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
              }`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
