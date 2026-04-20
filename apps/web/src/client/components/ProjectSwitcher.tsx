import { X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap.js";
import { fetchProjects, type ProjectListEntry } from "../lib/api.js";
import { useAppStore } from "../stores/app.js";
import { useAuthStore } from "../stores/auth.js";

/**
 * Cmd+P project switcher (docs/08-projects-and-isolation.md
 * §Project switcher UX).
 *
 * Keyboard-first command-palette pattern:
 *  · Trigger from Cmd+P / Ctrl+P (wired in App.tsx).
 *  · Reads `/api/projects` lazily on open — a single GET per palette
 *    open, not per keystroke.
 *  · Recent-first ordering is pulled from `localStorage` and persisted
 *    on switch; the rest of the list falls back to alphabetical.
 *  · Selecting a project triggers `window.location.reload()` with
 *    `?project=<id>` so stores, WebSocket subscriptions, and
 *    per-project caches start fresh — multi-project state in one SPA
 *    lifetime invites leaks across boundaries.
 */

const RECENT_KEY = "ironlore.recentProjects";
const RECENT_CAP = 5;

function loadRecentIds(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x: unknown): x is string => typeof x === "string").slice(0, RECENT_CAP);
  } catch {
    return [];
  }
}

function pushRecentId(id: string): void {
  try {
    const current = loadRecentIds();
    const next = [id, ...current.filter((x) => x !== id)].slice(0, RECENT_CAP);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage denied — non-fatal */
  }
}

export function ProjectSwitcher() {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useFocusTrap(dialogRef, true);

  const close = useCallback(() => useAppStore.getState().toggleProjectSwitcher(), []);
  const currentProjectId = useAuthStore((s) => s.currentProjectId);

  const [projects, setProjects] = useState<ProjectListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Fetch on open.
  useEffect(() => {
    let cancelled = false;
    fetchProjects()
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Recent-first ordering + fuzzy filter. Keep the comparator simple:
  //  exact name prefix first, then substring hit on id or name.
  const ordered = useMemo(() => {
    if (!projects) return [] as ProjectListEntry[];
    const recent = loadRecentIds();
    const recentRank = new Map(recent.map((id, i) => [id, i] as const));
    const sorted = [...projects].sort((a, b) => {
      const ra = recentRank.get(a.id) ?? Number.POSITIVE_INFINITY;
      const rb = recentRank.get(b.id) ?? Number.POSITIVE_INFINITY;
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });
    if (!query.trim()) return sorted;
    const q = query.trim().toLowerCase();
    return sorted.filter(
      (p) =>
        p.id.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        p.preset.toLowerCase().includes(q),
    );
  }, [projects, query]);

  // Keep the selected index in range as the list filters down.
  useEffect(() => {
    if (selectedIdx >= ordered.length) setSelectedIdx(Math.max(0, ordered.length - 1));
  }, [ordered, selectedIdx]);

  const commit = useCallback(
    (projectId: string) => {
      pushRecentId(projectId);
      close();
      // Full reload per spec — a single app lifetime should never hold
      //  two projects' state.
      const url = new URL(window.location.href);
      url.searchParams.set("project", projectId);
      window.location.href = url.toString();
    },
    [close],
  );

  const handleKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, ordered.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const pick = ordered[selectedIdx];
        if (pick) commit(pick.id);
      }
    },
    [close, ordered, selectedIdx, commit],
  );

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) close();
    },
    [close],
  );

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[15vh]"
      onClick={handleOverlayClick}
      onKeyDown={handleKey}
      role="dialog"
      aria-modal="true"
      aria-label="Switch project"
    >
      <div
        ref={dialogRef}
        className="w-full max-w-lg overflow-hidden rounded-md shadow-2xl"
        style={{ background: "var(--il-slate)", border: "1px solid var(--il-border)" }}
      >
        <div
          className="flex items-center gap-2 border-b"
          style={{
            borderColor: "var(--il-border-soft)",
            padding: "10px 14px",
          }}
        >
          <span
            className="font-mono uppercase"
            style={{
              fontSize: 10.5,
              letterSpacing: "0.06em",
              color: "var(--il-text3)",
            }}
          >
            switch project
          </span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIdx(0);
            }}
            placeholder="Type to filter…"
            className="flex-1 bg-transparent outline-none"
            style={{ fontSize: 13, color: "var(--il-text)" }}
          />
          <button
            type="button"
            onClick={close}
            aria-label="Close switcher"
            className="rounded p-1 text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div style={{ maxHeight: "50vh", overflowY: "auto" }}>
          {error && (
            <div style={{ padding: 14, color: "var(--il-red)", fontSize: 12.5 }}>
              Failed to load projects: {error}
            </div>
          )}
          {!error && projects === null && (
            <div style={{ padding: 14, color: "var(--il-text3)", fontSize: 12.5 }}>Loading…</div>
          )}
          {!error && projects && ordered.length === 0 && (
            <div style={{ padding: 14, color: "var(--il-text3)", fontSize: 12.5 }}>
              No matching projects.
            </div>
          )}
          {ordered.map((p, i) => {
            const active = i === selectedIdx;
            const current = p.id === currentProjectId;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => commit(p.id)}
                onMouseEnter={() => setSelectedIdx(i)}
                className="flex w-full items-center justify-between text-left outline-none"
                style={{
                  padding: "10px 14px",
                  background: active
                    ? "color-mix(in oklch, var(--il-blue) 14%, transparent)"
                    : "transparent",
                  borderLeft: `2px solid ${active ? "var(--il-blue)" : "transparent"}`,
                }}
              >
                <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 13, color: "var(--il-text)" }}>{p.name}</span>
                  <span
                    className="font-mono"
                    style={{
                      fontSize: 10.5,
                      color: "var(--il-text3)",
                      letterSpacing: "0.04em",
                    }}
                  >
                    {p.id} · {p.preset}
                  </span>
                </span>
                {current && (
                  <span
                    className="font-mono uppercase"
                    style={{
                      fontSize: 10.5,
                      letterSpacing: "0.06em",
                      color: "var(--il-blue)",
                    }}
                  >
                    current
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div
          className="font-mono"
          style={{
            borderTop: "1px solid var(--il-border-soft)",
            padding: "6px 14px",
            fontSize: 10.5,
            color: "var(--il-text3)",
            letterSpacing: "0.06em",
          }}
        >
          ↑/↓ select · enter open · esc close
        </div>
      </div>
    </div>
  );
}
