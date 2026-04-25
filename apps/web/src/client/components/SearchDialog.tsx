import { messages } from "@ironlore/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap.js";
import {
  fetchRecentEdits,
  getApiProject,
  type RecentEdit,
  type SearchResult,
  searchPages,
} from "../lib/api.js";
import { useAppStore } from "../stores/app.js";
import { Key, Meta, Reuleaux } from "./primitives/index.js";

type Tab = "ALL" | "PAGES" | "BLOCKS" | "AGENTS";

/** Auto-focus an input element via ref callback. */
function focusRef(el: HTMLInputElement | null) {
  el?.focus();
}

/**
 * 1px Ironlore-Blue vertical bar that blinks once per second. Purely
 * decorative — sits next to the native <input> caret and gives the
 * ⌘K dialog the canvas's "active query" feel. Lives outside the
 * input because positioning a blinking element *after the typed text*
 * inside a native <input> isn't possible without re-implementing the
 * input itself.
 */
function SearchCaret() {
  return (
    <span
      aria-hidden="true"
      className="il-search-caret"
      style={{
        display: "inline-block",
        width: 1.5,
        height: 16,
        background: "var(--il-blue)",
        marginLeft: 2,
      }}
    />
  );
}

/**
 * Render an FTS5 snippet safely: the server wraps matched terms in
 * `<mark>…</mark>`, but the text between tags is raw file content and
 * may contain user-authored HTML. Split on the literal marker tags and
 * render each chunk as a text node so no HTML is interpreted. Matches
 * paint in Signal-Amber per docs/09-ui-and-brand.md §Search.
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
        <mark
          key={i}
          className="rounded-sm px-0.5"
          style={{ background: "var(--il-amber)", color: "var(--il-bg)" }}
        >
          {p}
        </mark>
      ) : (
        <span key={i}>{p}</span>
      ),
    );
  }
  return out;
}

/**
 * ⌘K search dialog — canvas-grammar per docs/09-ui-and-brand.md
 * §Search. Blue Reuleaux pip in the input, mono tab row with
 * ALL/PAGES/BLOCKS/AGENTS counts, Ironlore-Blue top-hit block with
 * a 2px left bar, compact subsequent hits, mono uppercase footer
 * hints. Agents tab is a visible placeholder until Phase 6.
 */
export function SearchDialog() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [recentEdits, setRecentEdits] = useState<RecentEdit[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  /**
   * Round-trip latency of the most recent FTS5 query, in whole ms.
   * Measured client-side (performance.now() delta around the fetch)
   * so the "fts5 · Nms" chip reflects the user's observed latency —
   * not a server-reported number that could diverge from reality.
   * `null` until the first query lands; cleared when the query resets.
   */
  const [ftsMs, setFtsMs] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>("ALL");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true);

  useEffect(() => {
    fetchRecentEdits(10)
      .then(setRecentEdits)
      .catch(() => {
        /* ignore */
      });
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!query.trim()) {
      setResults([]);
      setSelectedIdx(0);
      setFtsMs(null);
      return;
    }

    setLoading(true);
    debounceRef.current = setTimeout(() => {
      const t0 = performance.now();
      searchPages(query)
        .then((r) => {
          setResults(r);
          setSelectedIdx(0);
          setFtsMs(Math.round(performance.now() - t0));
        })
        .catch(() => {
          setResults([]);
          setFtsMs(null);
        })
        .finally(() => setLoading(false));
    }, 150);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const close = useCallback(() => {
    useAppStore.getState().toggleSearchDialog();
    setQuery("");
    setResults([]);
    setSelectedIdx(0);
    setFtsMs(null);
    setTab("ALL");
  }, []);

  // Tab filtering: BLOCKS = results with a `#` fragment in the path
  // (chunk-level hits when the server surfaces them); AGENTS has no
  // data source yet, so the tab stays visible but empty. PAGES =
  // everything with a plain path.
  const counts = useMemo(() => {
    const blocks = results.filter((r) => r.path.includes("#"));
    const pages = results.filter((r) => !r.path.includes("#"));
    return {
      ALL: results.length,
      PAGES: pages.length,
      BLOCKS: blocks.length,
      AGENTS: 0,
    } satisfies Record<Tab, number>;
  }, [results]);

  const filtered = useMemo(() => {
    if (tab === "PAGES") return results.filter((r) => !r.path.includes("#"));
    if (tab === "BLOCKS") return results.filter((r) => r.path.includes("#"));
    if (tab === "AGENTS") return [] as SearchResult[];
    return results;
  }, [results, tab]);

  const showRecent = !query.trim();
  const displayItems = showRecent
    ? recentEdits.map((e) => ({ path: e.path, title: e.path, snippet: "" }))
    : filtered.map((r) => ({ path: r.path, title: r.title, snippet: r.snippet }));

  const openPath = useCallback(
    (path: string) => {
      // Split any `path#blk_XXX` fragment so block id goes to provenance
      // while the editor opens the base path.
      const [basePath] = path.split("#");
      if (!basePath) return;
      useAppStore.getState().setActivePath(basePath);
      close();
    },
    [close],
  );

  const openInProvenance = useCallback(
    (path: string) => {
      const [basePath, fragment] = path.split("#");
      if (!basePath) return;
      useAppStore.getState().setActivePath(basePath);
      useAppStore.getState().openProvenance(basePath, fragment ?? "");
      close();
    },
    [close],
  );

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
          if (!item) break;
          if (e.metaKey || e.ctrlKey) openInProvenance(item.path);
          else openPath(item.path);
          break;
        }
        case "Tab": {
          // Cycle visible tabs with Tab / Shift+Tab for keyboard-first users.
          e.preventDefault();
          const order: Tab[] = ["ALL", "PAGES", "BLOCKS", "AGENTS"];
          const idx = order.indexOf(tab);
          const next = order[(idx + (e.shiftKey ? -1 : 1) + order.length) % order.length];
          if (next) setTab(next);
          break;
        }
        case "Escape":
          e.preventDefault();
          close();
          break;
      }
    },
    [displayItems, selectedIdx, openPath, openInProvenance, close, tab],
  );

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) close();
    },
    [close],
  );

  const topHit = !showRecent ? displayItems[0] : undefined;
  const restHits = !showRecent ? displayItems.slice(1) : displayItems;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[15vh]"
      onClick={handleOverlayClick}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label={messages.sidebarSearch}
    >
      <div
        ref={dialogRef}
        className="surface-glass flex w-full flex-col overflow-hidden rounded-md shadow-2xl"
        style={{
          background: "var(--il-slate)",
          border: "1px solid var(--il-border)",
          // Spec §Search (⌘K): fixed 640 px wide. Tailwind max-w-2xl
          //  is 672 — 32 px over spec. Inline style pins the exact
          //  value and leaves the responsive shrink-below-640 path
          //  via `w-full`.
          maxWidth: 640,
        }}
      >
        {/* Input row */}
        <div
          className="flex items-center gap-3 px-5 py-3"
          style={{ borderBottom: "1px solid var(--il-border-soft)" }}
        >
          <Reuleaux size={10} color="var(--il-blue)" aria-label="Search" />
          <div className="relative flex flex-1 items-center">
            <input
              ref={focusRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={messages.sidebarSearchPlaceholder}
              className="w-full bg-transparent text-base text-primary outline-none placeholder:text-tertiary"
              style={{
                fontFamily: "var(--font-sans)",
                letterSpacing: "-0.01em",
              }}
            />
            {/*
             * Blinking cursor per canvas — an Ironlore-Blue vertical
             * bar trailing the query text. Only appears while the
             * query is non-empty so the placeholder row stays clean.
             * The <input> itself still shows a native caret; this
             * decorative bar is the visual anchor the canvas uses.
             */}
            {query.length > 0 && <SearchCaret />}
          </div>
          {/*
           * Timing chip — `fts5 · <state>`. `…` while in flight,
           * `<N>ms` once the round trip completes, hidden when the
           * query is empty.
           */}
          {query.length > 0 && <Meta k="fts5" v={loading || ftsMs === null ? "…" : `${ftsMs}ms`} />}
        </div>

        {/* Tab row */}
        <div
          className="flex items-stretch px-4"
          style={{ borderBottom: "1px solid var(--il-border-soft)", gap: 2 }}
        >
          {(["ALL", "PAGES", "BLOCKS", "AGENTS"] as Tab[]).map((t) => {
            const active = t === tab;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className="font-mono outline-none"
                style={{
                  padding: "6px 10px",
                  marginBottom: -1,
                  fontSize: 10.5,
                  letterSpacing: "0.06em",
                  color: active ? "var(--il-text)" : "var(--il-text3)",
                  borderBottom: `1.5px solid ${active ? "var(--il-blue)" : "transparent"}`,
                  background: "transparent",
                  cursor: "pointer",
                }}
              >
                {t} · {counts[t]}
              </button>
            );
          })}
        </div>

        {/* Results */}
        <div className="max-h-[60vh] overflow-y-auto">
          {showRecent && recentEdits.length > 0 && (
            <div
              className="px-5 pb-1 pt-3 font-mono uppercase"
              style={{
                fontSize: 10.5,
                letterSpacing: "0.08em",
                color: "var(--il-text3)",
              }}
            >
              Recent
            </div>
          )}

          {!showRecent && displayItems.length === 0 && !loading && (
            <div
              className="px-5 py-8 text-center"
              style={{ color: "var(--il-text2)", fontSize: 13 }}
            >
              No results found
            </div>
          )}

          {/* Top hit — only when actively searching */}
          {topHit && (
            <button
              type="button"
              key={topHit.path}
              className="block w-full text-left outline-none"
              style={{
                padding: "14px 20px",
                background: "color-mix(in oklch, var(--il-blue) 12%, transparent)",
                borderLeft: "2px solid var(--il-blue)",
                cursor: "pointer",
              }}
              onClick={() => openPath(topHit.path)}
              onMouseEnter={() => setSelectedIdx(0)}
            >
              <div
                className="font-mono uppercase"
                style={{
                  fontSize: 10.5,
                  letterSpacing: "0.06em",
                  color: "var(--il-text3)",
                  marginBottom: 4,
                }}
              >
                top hit · {topHit.path}
              </div>
              <div
                className="truncate"
                style={{
                  fontFamily: "var(--font-sans)",
                  fontWeight: 600,
                  fontSize: 15,
                  letterSpacing: "-0.015em",
                  color: "var(--il-text)",
                }}
              >
                {topHit.title}
              </div>
              {topHit.snippet && (
                <div
                  className="line-clamp-2"
                  style={{
                    fontSize: 12.5,
                    color: "var(--il-text2)",
                    marginTop: 6,
                    lineHeight: 1.5,
                  }}
                >
                  {renderSnippet(topHit.snippet)}
                </div>
              )}
            </button>
          )}

          {/* Subsequent hits — or the whole recent list */}
          {restHits.map((item, i) => {
            const idx = topHit ? i + 1 : i;
            const focused = idx === selectedIdx;
            return (
              <button
                key={item.path}
                type="button"
                onClick={() => openPath(item.path)}
                onMouseEnter={() => setSelectedIdx(idx)}
                className="grid w-full text-left outline-none"
                style={{
                  padding: "11px 20px",
                  borderTop: "1px solid var(--il-border-soft)",
                  gridTemplateColumns: "auto 1fr auto",
                  gap: 12,
                  alignItems: "baseline",
                  background: focused ? "var(--il-slate-hover)" : "transparent",
                  cursor: "pointer",
                }}
              >
                <Reuleaux size={7} color="var(--il-text3)" />
                <div style={{ minWidth: 0 }}>
                  <div className="flex items-baseline gap-2">
                    <span
                      className="font-mono truncate"
                      style={{ fontSize: 10.5, color: "var(--il-text3)" }}
                    >
                      {item.path}
                    </span>
                    {item.title && item.title !== item.path && (
                      <span
                        className="truncate"
                        style={{
                          fontSize: 13,
                          color: "var(--il-text)",
                          fontWeight: 500,
                        }}
                      >
                        {item.title}
                      </span>
                    )}
                  </div>
                  {item.snippet && (
                    <div
                      className="truncate"
                      style={{
                        fontSize: 12,
                        color: "var(--il-text2)",
                        marginTop: 3,
                      }}
                    >
                      {renderSnippet(item.snippet)}
                    </div>
                  )}
                </div>
                <Key>↵</Key>
              </button>
            );
          })}
        </div>

        {/* Footer — mono uppercase keyboard hints */}
        <div
          className="flex items-center font-mono uppercase"
          style={{
            gap: 18,
            padding: "10px 20px",
            borderTop: "1px solid var(--il-border-soft)",
            background: "var(--il-slate-elev)",
            fontSize: 10.5,
            letterSpacing: "0.04em",
            color: "var(--il-text3)",
          }}
        >
          <span className="flex items-center gap-1">
            <Key>↑↓</Key> navigate
          </span>
          <span className="flex items-center gap-1">
            <Key>↵</Key> open
          </span>
          <span className="flex items-center gap-1">
            <Key>⌘↵</Key> open in provenance
          </span>
          <span style={{ flex: 1 }} />
          <span className="flex items-center gap-1">
            <Key>esc</Key> close
          </span>
        </div>
      </div>
    </div>
  );
}
