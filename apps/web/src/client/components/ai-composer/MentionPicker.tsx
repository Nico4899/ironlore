import type { TreeNode } from "@ironlore/core";
import { Bot, FileText } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchAgents } from "../../lib/api.js";
import { useTreeStore } from "../../stores/tree.js";

/**
 * Mention picker — rendered above the composer when the textarea
 * contains an `@query` token the caret is still inside. Shows
 * matching pages and agents, filtered by substring. Arrow keys
 * navigate; Enter (or click) commits; Escape dismisses.
 *
 * The composer owns the textarea and token-range; this component
 * just receives the current query string and reports a selection
 * back via `onPick(kind, label, path)`.
 */

export interface MentionCandidate {
  kind: "page" | "agent";
  label: string;
  /** Full path (page) or slug (agent). */
  path: string;
  /** Optional status for agent rows. */
  status?: "active" | "paused";
}

interface MentionPickerProps {
  /** True when the picker should render; the composer owns this state. */
  open: boolean;
  /** Substring after the `@` — e.g. "read" for `@read`. */
  query: string;
  /** User committed a choice (enter or click). */
  onPick: (candidate: MentionCandidate) => void;
  /** User dismissed (Escape or click outside). */
  onClose: () => void;
}

const MAX_VISIBLE = 8;

export function MentionPicker({ open, query, onPick, onClose }: MentionPickerProps) {
  const nodes = useTreeStore((s) => s.nodes);
  const [agents, setAgents] = useState<MentionCandidate[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  // Lazy-load agents once the picker opens. Swallowing errors is
  //  fine — the list silently degrades to pages-only, which is
  //  still useful and avoids a modal toast every keystroke.
  useEffect(() => {
    if (!open || agents.length > 0) return;
    let cancelled = false;
    fetchAgents()
      .then((list) => {
        if (cancelled) return;
        setAgents(
          list.map(
            (a) =>
              ({
                kind: "agent",
                label: a.slug,
                path: a.slug,
                status: a.status,
              }) as MentionCandidate,
          ),
        );
      })
      .catch(() => {
        /* keep pages-only */
      });
    return () => {
      cancelled = true;
    };
  }, [open, agents.length]);

  // Build the filtered candidate list. Agents first, then pages —
  //  mirroring the brand grammar where agent voice is signal and
  //  page links are evidence. Within each group we rank by prefix
  //  match over substring match.
  const candidates = useMemo<MentionCandidate[]>(() => {
    const q = query.toLowerCase();
    const pages: MentionCandidate[] = nodes
      .filter((n: TreeNode) => n.type !== "directory")
      .map((n) => ({ kind: "page" as const, label: n.name, path: n.path }));
    const all = [...agents, ...pages];
    if (q.length === 0) return all.slice(0, MAX_VISIBLE);
    const scored = all
      .map((c) => {
        const name = c.label.toLowerCase();
        const pathLower = c.path.toLowerCase();
        let score = -1;
        if (name.startsWith(q)) score = 3;
        else if (name.includes(q)) score = 2;
        else if (pathLower.includes(q)) score = 1;
        return { c, score };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.c);
    return scored.slice(0, MAX_VISIBLE);
  }, [nodes, agents, query]);

  // Reset cursor when the filtered set shrinks past it.
  useEffect(() => {
    if (activeIndex >= candidates.length) setActiveIndex(0);
  }, [candidates.length, activeIndex]);

  // Global key handling for arrow/enter/escape while open. Bound on
  //  window in capture phase so we intercept before the textarea's
  //  default newline-on-enter behavior.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (candidates.length > 0 ? (i + 1) % candidates.length : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) =>
          candidates.length > 0 ? (i - 1 + candidates.length) % candidates.length : 0,
        );
      } else if (e.key === "Enter") {
        const chosen = candidates[activeIndex];
        if (chosen) {
          e.preventDefault();
          onPick(chosen);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Tab") {
        const chosen = candidates[activeIndex];
        if (chosen) {
          e.preventDefault();
          onPick(chosen);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, candidates, activeIndex, onPick, onClose]);

  if (!open) return null;

  return (
    <div
      ref={rootRef}
      role="listbox"
      aria-label="Mention suggestions"
      style={{
        position: "absolute",
        bottom: "calc(100% + 6px)",
        left: 0,
        right: 0,
        background: "var(--il-bg-raised)",
        border: "1px solid var(--il-border-soft)",
        borderRadius: 6,
        boxShadow: "0 6px 20px oklch(0 0 0 / 0.35)",
        padding: 4,
        zIndex: 40,
        animation: "ilSnapIn var(--motion-snap) ease-out",
        maxHeight: 280,
        overflowY: "auto",
      }}
    >
      {candidates.length === 0 ? (
        <div
          style={{
            padding: "8px 10px",
            fontSize: 12,
            color: "var(--il-text3)",
            fontStyle: "italic",
          }}
        >
          No matches for “{query}”
        </div>
      ) : (
        candidates.map((c, i) => (
          <button
            key={`${c.kind}:${c.path}`}
            type="button"
            role="option"
            aria-selected={i === activeIndex}
            data-selected={i === activeIndex ? "true" : undefined}
            className="il-popover-item"
            onMouseEnter={() => setActiveIndex(i)}
            onClick={() => onPick(c)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "6px 8px",
              border: "none",
              background: "transparent",
              color: "var(--il-text)",
              borderRadius: 4,
              textAlign: "left",
              cursor: "pointer",
              fontFamily: "var(--font-sans)",
              fontSize: 12.5,
            }}
          >
            <span
              aria-hidden="true"
              style={{ display: "inline-flex", width: 14, color: "var(--il-text3)" }}
            >
              {c.kind === "agent" ? <Bot size={14} /> : <FileText size={14} />}
            </span>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{c.label}</span>
            <span
              className="font-mono"
              style={{
                fontSize: 10.5,
                letterSpacing: "0.04em",
                color: "var(--il-text4)",
                textTransform: "uppercase",
              }}
            >
              {c.kind}
            </span>
          </button>
        ))
      )}
    </div>
  );
}
