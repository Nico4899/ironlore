import type { TreeNode } from "@ironlore/core";
import { Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../stores/app.js";
import { useTreeStore } from "../stores/tree.js";

/**
 * Folder peek — small icon-button anchored in the row's hover slot
 * that opens a portal-rendered popover next to the folder. The
 * popover lists every descendant (files + sub-folders) flattened
 * into one searchable list. Click a result to navigate; the popover
 * closes on outside-click, Esc, or pointer-leave with a 250 ms
 * grace.
 *
 * Trigger is a deliberate click rather than pure hover to avoid
 * "tooltip explosion" — users sweeping the cursor across the tree
 * shouldn't fire a popover for every folder they pass.
 */

const ROW_CAP = 200;
const LEAVE_GRACE_MS = 250;

export function FolderPeekButton({ folder }: { folder: TreeNode }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (buttonRef.current) {
            setAnchor(buttonRef.current.getBoundingClientRect());
          }
          setOpen(true);
        }}
        title={`Search inside ${folder.name}`}
        aria-label={`Search inside ${folder.name}`}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-secondary opacity-0 outline-none transition-opacity hover:bg-ironlore-slate-hover hover:text-primary group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
      >
        <Search className="h-3 w-3" aria-hidden="true" />
      </button>
      {open && anchor && (
        <FolderPeekPopover folder={folder} anchor={anchor} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function FolderPeekPopover({
  folder,
  anchor,
  onClose,
}: {
  folder: TreeNode;
  anchor: DOMRect;
  onClose: () => void;
}) {
  const nodes = useTreeStore((s) => s.nodes);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const leaveTimer = useRef<number | null>(null);

  // Flatten descendants — anything under `<folder.path>/`.
  const descendants = useMemo(() => {
    const prefix = `${folder.path}/`;
    return nodes
      .filter((n) => n.path.startsWith(prefix))
      .map((n) => {
        const rel = n.path.slice(prefix.length);
        const depth = rel.split("/").length - 1;
        return { ...n, rel, depth };
      });
  }, [nodes, folder.path]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return descendants;
    return descendants.filter(
      (n) => n.rel.toLowerCase().includes(q) || n.name.toLowerCase().includes(q),
    );
  }, [descendants, query]);

  const visible = filtered.slice(0, ROW_CAP);
  const truncated = filtered.length > ROW_CAP;

  // Position the popover next to the row, flipping to the left when
  //  the row is too close to the viewport's right edge.
  const popoverWidth = 320;
  const popoverGap = 4;
  const flipLeft = anchor.right + popoverWidth + popoverGap > window.innerWidth;
  const left = flipLeft
    ? Math.max(8, anchor.left - popoverWidth - popoverGap)
    : anchor.right + popoverGap;
  // Clamp to viewport vertical bounds with a small inset so the
  //  popover never disappears off-screen for rows near the bottom.
  const popoverHeight = 360;
  const top = Math.min(Math.max(8, anchor.top), window.innerHeight - popoverHeight - 8);

  // Close on outside-click + Esc.
  useEffect(() => {
    inputRef.current?.focus();
    const onClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const open = (path: string) => {
    useAppStore.getState().setActivePath(path);
    onClose();
  };

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={`Files in ${folder.name}`}
      onMouseEnter={() => {
        if (leaveTimer.current) {
          window.clearTimeout(leaveTimer.current);
          leaveTimer.current = null;
        }
      }}
      onMouseLeave={() => {
        leaveTimer.current = window.setTimeout(onClose, LEAVE_GRACE_MS);
      }}
      style={{
        position: "fixed",
        top,
        left,
        width: popoverWidth,
        maxHeight: popoverHeight,
        background: "var(--il-slate)",
        border: "1px solid var(--il-border)",
        borderRadius: 6,
        boxShadow: "0 12px 32px oklch(0.05 0 0 / 0.4)",
        zIndex: 60,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        className="flex items-center gap-2 border-b px-2 py-1.5"
        style={{ borderColor: "var(--il-border-soft)" }}
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-tertiary" aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          placeholder={`Search inside ${folder.name}…`}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIdx(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActiveIdx((i) => Math.min(i + 1, visible.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActiveIdx((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const pick = visible[activeIdx];
              if (pick && pick.type !== "directory") open(pick.path);
            }
          }}
          className="flex-1 bg-transparent text-sm text-primary placeholder:text-tertiary focus:outline-none"
          style={{ fontSize: 12.5 }}
        />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded p-0.5 text-tertiary hover:bg-ironlore-slate-hover hover:text-primary"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {visible.length === 0 && (
          <div className="px-3 py-4 text-center text-xs text-tertiary">
            {descendants.length === 0 ? "Empty folder" : "No matches"}
          </div>
        )}
        {visible.map((n, idx) => {
          const isFolder = n.type === "directory";
          const isActive = idx === activeIdx;
          return (
            <button
              key={n.path}
              type="button"
              onClick={() => {
                if (isFolder) return; // peek doesn't drill — files only
                open(n.path);
              }}
              onMouseEnter={() => setActiveIdx(idx)}
              className={`flex w-full items-center gap-2 px-2 py-1 text-left text-sm outline-none ${
                isActive
                  ? "bg-ironlore-slate-hover text-primary"
                  : "text-secondary hover:bg-ironlore-slate-hover"
              } ${isFolder ? "cursor-default" : ""}`}
              style={{ paddingLeft: 8 + Math.min(n.depth, 4) * 10 }}
              disabled={isFolder}
            >
              <span
                className="font-mono shrink-0 text-tertiary"
                style={{ fontSize: 10.5, letterSpacing: "0.04em" }}
              >
                {isFolder ? "DIR" : "FILE"}
              </span>
              <span className="flex-1 truncate" style={{ fontSize: 12.5 }}>
                {n.rel}
              </span>
            </button>
          );
        })}
        {truncated && (
          <div className="px-3 py-2 text-center text-xs text-tertiary">
            Showing {ROW_CAP} of {filtered.length} — refine search
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
