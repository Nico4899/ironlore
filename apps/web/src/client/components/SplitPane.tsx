import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
  /** Initial left-pane ratio [0, 1]. Defaults to 0.5. */
  defaultRatio?: number;
  /** Minimum ratio for either side — prevents users hiding a pane. */
  minRatio?: number;
  /** localStorage key for persisting the ratio. Omit to disable persistence. */
  storageKey?: string;
  /** aria-label for the draggable handle. */
  handleLabel?: string;
}

/**
 * Two-pane horizontal split with a draggable handle.
 *
 * Keeps the ratio in state (optionally persisted to localStorage) and
 * clamps to `[minRatio, 1 - minRatio]` during drag. Pointer events so
 * touch works alongside mouse. The handle also responds to ArrowLeft /
 * ArrowRight for keyboard users.
 */
export function SplitPane({
  left,
  right,
  defaultRatio = 0.5,
  minRatio = 0.15,
  storageKey,
  handleLabel = "Resize panes",
}: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(() => {
    if (!storageKey) return defaultRatio;
    try {
      const raw = window.localStorage.getItem(storageKey);
      const n = raw ? Number.parseFloat(raw) : Number.NaN;
      if (!Number.isFinite(n)) return defaultRatio;
      return clamp(n, minRatio, 1 - minRatio);
    } catch {
      return defaultRatio;
    }
  });
  const dragging = useRef(false);

  useEffect(() => {
    if (!storageKey) return;
    try {
      window.localStorage.setItem(storageKey, String(ratio));
    } catch {
      // Storage denied (private mode / quota) — not load-bearing.
    }
  }, [ratio, storageKey]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    (e.target as Element).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width === 0) return;
      const raw = (e.clientX - rect.left) / rect.width;
      setRatio(clamp(raw, minRatio, 1 - minRatio));
    },
    [minRatio],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    (e.target as Element).releasePointerCapture(e.pointerId);
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 0.05 : 0.01;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setRatio((r) => clamp(r - step, minRatio, 1 - minRatio));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setRatio((r) => clamp(r + step, minRatio, 1 - minRatio));
      } else if (e.key === "Home") {
        e.preventDefault();
        setRatio(0.5);
      }
    },
    [minRatio],
  );

  const leftPct = ratio * 100;
  const rightPct = (1 - ratio) * 100;

  return (
    <div ref={containerRef} className="flex flex-1 overflow-hidden">
      <div className="overflow-hidden" style={{ flex: `0 0 ${leftPct}%` }}>
        {left}
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: <hr> has no interactive affordance; this separator must accept pointer, focus, and key events */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={handleLabel}
        aria-valuemin={minRatio * 100}
        aria-valuemax={(1 - minRatio) * 100}
        aria-valuenow={Math.round(leftPct)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
        className="relative w-px shrink-0 cursor-col-resize bg-border outline-none hover:bg-ironlore-blue focus-visible:bg-ironlore-blue"
      >
        {/* Invisible hit area around the 1px visual line — 6px click target */}
        <span aria-hidden="true" className="absolute -inset-x-1.5 inset-y-0" />
      </div>
      <div className="overflow-hidden" style={{ flex: `0 0 ${rightPct}%` }}>
        {right}
      </div>
    </div>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
