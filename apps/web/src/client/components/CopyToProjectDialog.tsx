import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap.js";
import {
  copyPageToProject,
  fetchProjects,
  getApiProject,
  type ProjectListEntry,
} from "../lib/api.js";

/**
 * Cross-project copy dialog (docs/08-projects-and-isolation.md §Cross-
 * project copy workflow). Opened from the sidebar context menu on a
 * page row. The user picks a target project + collision strategy; the
 * server stamps `copied_from` into the destination's frontmatter.
 *
 * The crossing is deliberate: the user must read the source before
 * clicking Copy — per the lethal-trifecta design, this is the
 * contract that no automated flow can violate.
 */
interface CopyToProjectDialogProps {
  srcPath: string;
  onClose: () => void;
}

export function CopyToProjectDialog({ srcPath, onClose }: CopyToProjectDialogProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true);

  const srcProjectId = getApiProject();
  const [projects, setProjects] = useState<ProjectListEntry[] | null>(null);
  const [targetProjectId, setTargetProjectId] = useState<string | null>(null);
  const [onConflict, setOnConflict] = useState<"rename" | "overwrite">("rename");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ path: string; renamed: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchProjects()
      .then((list) => {
        if (cancelled) return;
        // Two filters per docs/08 §Cross-project copy workflow:
        //   1. Same-project copies are nonsensical.
        //   2. Targets must accept promotions from this source. Absent
        //      `acceptPromotionsFrom` = backwards-compat (allow any);
        //      explicit `[]` = strict (no promotions).
        const candidates = list.filter((p) => {
          if (p.id === srcProjectId) return false;
          if (p.acceptPromotionsFrom === undefined) return true;
          return p.acceptPromotionsFrom.includes(srcProjectId);
        });
        setProjects(candidates);
        if (candidates[0]) setTargetProjectId(candidates[0].id);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [srcProjectId]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current && !busy) onClose();
    },
    [busy, onClose],
  );

  const handleKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        onClose();
      }
    },
    [busy, onClose],
  );

  const handleCopy = useCallback(async () => {
    if (!targetProjectId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await copyPageToProject({
        srcProjectId,
        srcPath,
        targetProjectId,
        onConflict,
      });
      setSuccess({ path: result.targetPath, renamed: result.renamed });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [targetProjectId, srcProjectId, srcPath, onConflict]);

  const empty = projects !== null && projects.length === 0;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={handleOverlayClick}
      onKeyDown={handleKey}
      role="dialog"
      aria-modal="true"
      aria-label="Copy to project"
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md overflow-hidden rounded-md shadow-2xl"
        style={{ background: "var(--il-slate)", border: "1px solid var(--il-border)" }}
      >
        <div
          className="flex items-center justify-between"
          style={{
            padding: "10px 14px",
            borderBottom: "1px solid var(--il-border-soft)",
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
            copy to project
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded p-1 text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div style={{ padding: "16px 18px" }}>
          <div
            style={{
              fontSize: 11.5,
              color: "var(--il-text3)",
              marginBottom: 4,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              fontFamily: "var(--font-mono)",
            }}
          >
            source
          </div>
          <div style={{ fontSize: 13, color: "var(--il-text)", marginBottom: 14 }}>
            <code
              style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
            >{`${srcProjectId}/${srcPath}`}</code>
          </div>

          <div
            style={{
              fontSize: 11.5,
              color: "var(--il-text3)",
              marginBottom: 4,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              fontFamily: "var(--font-mono)",
            }}
          >
            target
          </div>
          {projects === null && !error && (
            <div style={{ fontSize: 12.5, color: "var(--il-text3)" }}>Loading…</div>
          )}
          {empty && !error && (
            <div style={{ fontSize: 12.5, color: "var(--il-text3)" }}>
              No projects accept promotions from <code>{srcProjectId}</code>. Add this project's id
              to a target's <code>accept_promotions_from</code> list in its{" "}
              <code>project.yaml</code>.
            </div>
          )}
          {projects && !empty && (
            <select
              value={targetProjectId ?? ""}
              onChange={(e) => setTargetProjectId(e.target.value)}
              style={{
                width: "100%",
                padding: "6px 8px",
                background: "var(--il-slate-elev)",
                border: "1px solid var(--il-border-soft)",
                borderRadius: 3,
                fontSize: 13,
                color: "var(--il-text)",
              }}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.id}, {p.preset})
                </option>
              ))}
            </select>
          )}

          <div
            style={{
              marginTop: 14,
              fontSize: 11.5,
              color: "var(--il-text3)",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              fontFamily: "var(--font-mono)",
              marginBottom: 4,
            }}
          >
            on conflict
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {(["rename", "overwrite"] as const).map((opt) => {
              const active = onConflict === opt;
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setOnConflict(opt)}
                  style={{
                    padding: "5px 12px",
                    fontSize: 12,
                    fontFamily: "var(--font-sans)",
                    fontWeight: 500,
                    color: active ? "var(--il-text)" : "var(--il-text2)",
                    background: active ? "var(--il-slate-elev)" : "transparent",
                    border: `1px solid ${active ? "var(--il-border)" : "var(--il-border-soft)"}`,
                    borderRadius: 3,
                    cursor: "pointer",
                  }}
                >
                  {opt}
                </button>
              );
            })}
          </div>

          {error && (
            <div
              style={{
                marginTop: 14,
                padding: 10,
                fontSize: 12.5,
                color: "var(--il-red)",
                border: "1px solid var(--il-border-soft)",
                borderRadius: 3,
              }}
            >
              {error}
            </div>
          )}
          {success && (
            <div
              style={{
                marginTop: 14,
                padding: 10,
                fontSize: 12.5,
                color: "var(--il-green)",
                border: "1px solid var(--il-border-soft)",
                borderRadius: 3,
              }}
            >
              Copied to <code>{success.path}</code>
              {success.renamed ? " (renamed due to collision)" : ""}.
            </div>
          )}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "10px 14px",
            borderTop: "1px solid var(--il-border-soft)",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{
              padding: "5px 12px",
              fontSize: 12,
              background: "transparent",
              border: "1px solid var(--il-border-soft)",
              borderRadius: 3,
              color: "var(--il-text2)",
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            Close
          </button>
          {!success && (
            <button
              type="button"
              onClick={handleCopy}
              disabled={busy || !targetProjectId}
              style={{
                padding: "5px 14px",
                fontSize: 12,
                background: "var(--il-blue)",
                border: "1px solid var(--il-blue)",
                borderRadius: 3,
                color: "var(--il-text)",
                cursor: busy ? "not-allowed" : "pointer",
                opacity: !targetProjectId || busy ? 0.5 : 1,
              }}
            >
              {busy ? "Copying…" : "Copy"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
