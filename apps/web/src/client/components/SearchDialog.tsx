import { messages } from "@ironlore/core";
import { Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchRecentEdits, type RecentEdit, type SearchResult, searchPages } from "../lib/api.js";
import { useAppStore } from "../stores/app.js";

/** Auto-focus an input element via ref callback. */
function focusRef(el: HTMLInputElement | null) {
  el?.focus();
}

/**
 * Render an FTS5 snippet safely: the server wraps matched terms in
 * `<mark>…</mark>`, but the text between tags is raw file content and
 * may contain user-authored HTML. Split on the literal marker tags and
 * render each chunk as a text node so no HTML is interpreted.
 */
function renderSnippet(snippet: string): React.ReactNode {
  const parts = snippet.split(/(<mark>|<\/mark>)/g);
  const out: React.ReactNode[] = [];
  let inMark = false;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === "<mark>") {
      inMark = true;
      continue;
    }
    if (p === "</mark>") {
      inMark = false;
      continue;
    }
    if (!p) continue;
    out.push(
      inMark ? (
        <mark key={i} className="bg-signal-amber/30 text-primary">
          {p}
        </mark>
      ) : (
        <span key={i}>{p}</span>
      ),
    );
  }
  return out;
}

export function SearchDialog() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [recentEdits, setRecentEdits] = useState<RecentEdit[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Load recent edits on mount
  useEffect(() => {
    fetchRecentEdits(10)
      .then(setRecentEdits)
      .catch(() => {
        // Ignore errors
      });
  }, []);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    if (!query.trim()) {
      setResults([]);
      setSelectedIdx(0);
      return;
    }

    setLoading(true);
    debounceRef.current = setTimeout(() => {
      searchPages(query)
        .then((r) => {
          setResults(r);
          setSelectedIdx(0);
        })
        .catch(() => {
          setResults([]);
        })
        .finally(() => {
          setLoading(false);
        });
    }, 150);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [query]);

  const close = useCallback(() => {
    useAppStore.getState().toggleSearchDialog();
    setQuery("");
    setResults([]);
    setSelectedIdx(0);
  }, []);

  const selectResult = useCallback(
    (path: string) => {
      useAppStore.getState().setActivePath(path);
      close();
    },
    [close],
  );

  // Items to display — search results or recent edits
  const showRecent = !query.trim();
  const displayItems = showRecent
    ? recentEdits.map((e) => ({ path: e.path, title: e.path, snippet: "" }))
    : results.map((r) => ({ path: r.path, title: r.title, snippet: r.snippet }));

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIdx((i) => Math.min(i + 1, displayItems.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIdx((i) => Math.max(i - 1, 0));
          break;
        case "Enter": {
          e.preventDefault();
          const item = displayItems[selectedIdx];
          if (item) {
            selectResult(item.path);
          }
          break;
        }
        case "Escape":
          e.preventDefault();
          close();
          break;
      }
    },
    [displayItems, selectedIdx, selectResult, close],
  );

  // Close on backdrop click
  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) {
        close();
      }
    },
    [close],
  );

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh]"
      onClick={handleOverlayClick}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label={messages.sidebarSearch}
    >
      <div className="flex w-full max-w-lg flex-col rounded-lg border border-border bg-ironlore-slate shadow-lg">
        {/* Search input */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-secondary" />
          <input
            ref={focusRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={messages.sidebarSearchPlaceholder}
            className="flex-1 bg-transparent text-sm text-primary outline-none placeholder:text-secondary"
          />
          {loading && <span className="text-xs text-secondary">...</span>}
        </div>

        {/* Results */}
        <div className="max-h-[60vh] overflow-y-auto">
          {showRecent && recentEdits.length > 0 && (
            <div className="px-4 pt-2 pb-1 text-xs font-medium uppercase tracking-wide text-secondary">
              Recent
            </div>
          )}

          {displayItems.length === 0 && query.trim() && !loading && (
            <div className="px-4 py-6 text-center text-sm text-secondary">No results found</div>
          )}

          {displayItems.map((item, idx) => (
            <button
              key={item.path}
              type="button"
              className={`flex w-full flex-col gap-0.5 px-4 py-2 text-left ${
                idx === selectedIdx ? "bg-ironlore-slate-hover" : "hover:bg-ironlore-slate-hover"
              }`}
              onClick={() => selectResult(item.path)}
              onMouseEnter={() => setSelectedIdx(idx)}
            >
              <span className="truncate text-sm text-primary">{item.title}</span>
              <span className="truncate text-xs text-secondary">{item.path}</span>
              {item.snippet && (
                <span className="mt-0.5 line-clamp-2 text-xs text-secondary">
                  {renderSnippet(item.snippet)}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-xs text-secondary">
          <span>
            <kbd className="rounded bg-ironlore-slate-hover px-1 py-0.5">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="rounded bg-ironlore-slate-hover px-1 py-0.5">↵</kbd> open
          </span>
          <span>
            <kbd className="rounded bg-ironlore-slate-hover px-1 py-0.5">esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
