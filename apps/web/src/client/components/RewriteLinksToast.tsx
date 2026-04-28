import { Link as LinkIcon, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { rewriteBacklinks } from "../lib/api.js";

interface PendingToast {
  id: string;
  oldPath: string;
  newPath: string;
  count: number;
  status: "prompting" | "rewriting" | "done" | "error";
  result?: number;
  error?: string;
}

const AUTO_DISMISS_MS = 30_000;
const SUCCESS_DISMISS_MS = 4_000;

let pushFn: ((entry: Omit<PendingToast, "status">) => void) | null = null;

/**
 * Surface a "N pages link to <oldPath>. Update them?" toast after a
 * successful rename. The user clicks Update to trigger the
 * server-side rewrite, or Skip / wait for the auto-dismiss to leave
 * inbound links pointing at the (now-broken) old path.
 *
 * Per docs/03-editor.md §Rename-rewrite: the rewrite is the only
 * automated cross-page write in Ironlore — always user-initiated,
 * never silent.
 */
export function showRewriteLinksToast(input: {
  oldPath: string;
  newPath: string;
  count: number;
}): void {
  if (input.count <= 0) return;
  pushFn?.({
    id: `${input.oldPath}->${input.newPath}-${Date.now()}`,
    oldPath: input.oldPath,
    newPath: input.newPath,
    count: input.count,
  });
}

/**
 * Toast container for inbound-link rewrites. Stack-friendly: rapid
 * successive renames each get their own toast that the user can act
 * on (or ignore) independently. Mount once in App.tsx.
 */
export function RewriteLinksToastContainer() {
  const [toasts, setToasts] = useState<PendingToast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const update = useCallback((id: string, patch: Partial<PendingToast>) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  useEffect(() => {
    pushFn = (entry) => {
      setToasts((prev) => [...prev, { ...entry, status: "prompting" }]);
    };
    return () => {
      pushFn = null;
    };
  }, []);

  // Per-toast auto-dismiss: a long timer for the prompting state so
  //  a passively-ignored toast doesn't linger forever, plus a short
  //  timer for success states so the confirmation reads as
  //  transient acknowledgment.
  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((t) => {
      if (t.status === "prompting") {
        return setTimeout(() => dismiss(t.id), AUTO_DISMISS_MS);
      }
      if (t.status === "done") {
        return setTimeout(() => dismiss(t.id), SUCCESS_DISMISS_MS);
      }
      return null;
    });
    return () => {
      for (const t of timers) if (t !== null) clearTimeout(t);
    };
  }, [toasts, dismiss]);

  const handleUpdate = useCallback(
    async (toast: PendingToast) => {
      update(toast.id, { status: "rewriting" });
      try {
        const result = await rewriteBacklinks(toast.oldPath, toast.newPath);
        update(toast.id, { status: "done", result: result.updated });
      } catch (e) {
        update(toast.id, {
          status: "error",
          error: e instanceof Error ? e.message : "Rewrite failed.",
        });
      }
    },
    [update],
  );

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-16 right-4 z-50 flex max-w-sm flex-col gap-2"
    >
      {toasts.map((t) => {
        const oldName = t.oldPath.split("/").pop() ?? t.oldPath;
        return (
          <div
            key={t.id}
            role="status"
            className="surface-glass pointer-events-auto flex items-start gap-2 rounded-xl px-4 py-3 text-xs"
            style={{
              boxShadow: "var(--shadow-lg), 0 0 12px oklch(0.62 0.18 240 / 0.18)",
              borderLeft: "2px solid var(--il-blue)",
            }}
          >
            <LinkIcon className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--il-blue)" }} />
            <div className="min-w-0 flex-1">
              {t.status === "prompting" && (
                <>
                  <div
                    className="font-mono uppercase"
                    style={{
                      fontSize: 10.5,
                      letterSpacing: "0.04em",
                      color: "var(--il-text3)",
                    }}
                  >
                    {oldName} renamed
                  </div>
                  <p className="mt-0.5 font-medium text-primary">
                    {t.count} page{t.count === 1 ? "" : "s"} link{t.count === 1 ? "s" : ""} here.
                    Update {t.count === 1 ? "it" : "them"}?
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleUpdate(t)}
                      className="rounded border-none bg-ironlore-blue px-2.5 py-0.5 text-xs font-medium text-background hover:bg-ironlore-blue-strong"
                      style={{ boxShadow: "0 0 8px var(--il-blue-glow)" }}
                    >
                      Update
                    </button>
                    <button
                      type="button"
                      onClick={() => dismiss(t.id)}
                      className="rounded px-2.5 py-0.5 text-xs text-secondary outline-none hover:bg-ironlore-slate-hover hover:text-primary focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
                    >
                      Skip
                    </button>
                  </div>
                </>
              )}
              {t.status === "rewriting" && (
                <>
                  <div
                    className="font-mono uppercase"
                    style={{
                      fontSize: 10.5,
                      letterSpacing: "0.04em",
                      color: "var(--il-text3)",
                    }}
                  >
                    Rewriting…
                  </div>
                  <p className="mt-0.5 text-secondary">
                    Updating {t.count} page{t.count === 1 ? "" : "s"}.
                  </p>
                </>
              )}
              {t.status === "done" && (
                <>
                  <div
                    className="font-mono uppercase"
                    style={{
                      fontSize: 10.5,
                      letterSpacing: "0.04em",
                      color: "var(--il-green)",
                    }}
                  >
                    Done
                  </div>
                  <p className="mt-0.5 font-medium text-primary">
                    {t.result ?? 0} page{t.result === 1 ? "" : "s"} updated.
                  </p>
                </>
              )}
              {t.status === "error" && (
                <>
                  <div
                    className="font-mono uppercase"
                    style={{
                      fontSize: 10.5,
                      letterSpacing: "0.04em",
                      color: "var(--il-red)",
                    }}
                  >
                    Rewrite failed
                  </div>
                  <p className="mt-0.5 text-secondary">{t.error}</p>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="shrink-0 rounded text-tertiary outline-none hover:text-primary focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
