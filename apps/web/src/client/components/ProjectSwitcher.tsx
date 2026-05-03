import { Briefcase, ChevronLeft, CircleCheck, Plus, ShieldCheck, Telescope, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap.js";
import { ApiError, createProject, fetchProjects, type ProjectListEntry } from "../lib/api.js";
import { useAppStore } from "../stores/app.js";
import { useAuthStore } from "../stores/auth.js";

/**
 * ⌘P project switcher + new-project wizard.
 *
 * Two stages in one modal:
 *
 * 1. **List** — the default. Filterable list of installed projects,
 *    recent-first. Keyboard-first (↑/↓/Enter/Esc). A `+ New project`
 *    row at the bottom swaps to stage 2.
 * 2. **Create** — a name → id → preset → create wizard. No search
 *    box in this stage per the spec brief. The in-flight server
 *    can't yet hot-mount the new project's routes, so on success we
 *    show a `restart required` confirmation pane — the user restarts
 *    the server themselves, then opens ⌘P and switches.
 *
 * Switching still uses the documented `?project=<id>` reload so
 * per-project state never leaks across projects in one app
 * lifetime (docs/08-projects-and-isolation.md §Project switcher UX).
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

type Stage = "list" | "create" | "created";

type Preset = "main" | "research" | "sandbox";

export function ProjectSwitcher() {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useFocusTrap(dialogRef, true);

  const close = useCallback(() => useAppStore.getState().toggleProjectSwitcher(), []);
  const currentProjectId = useAuthStore((s) => s.currentProjectId);

  const [stage, setStage] = useState<Stage>("list");
  const [projects, setProjects] = useState<ProjectListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Create-stage state. Kept alongside list-stage state so a user
  //  who toggles between stages doesn't lose their draft.
  const [createName, setCreateName] = useState("");
  const [createId, setCreateId] = useState("");
  const [createIdDirty, setCreateIdDirty] = useState(false);
  const [createPreset, setCreatePreset] = useState<Preset>("main");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);

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

  // Focus management — re-focus the appropriate input on stage flip.
  useEffect(() => {
    if (stage === "list") inputRef.current?.focus();
  }, [stage]);

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

  // The list stage shows one extra row at the bottom: "+ New
  //  project". We compute a combined index space so arrow-nav lands
  //  on it naturally.
  const LIST_EXTRA_ROWS = 1; // just the "+ New project" row
  const maxIdx = ordered.length + LIST_EXTRA_ROWS - 1;
  const isOnNewRow = selectedIdx === ordered.length;

  useEffect(() => {
    if (selectedIdx > maxIdx) setSelectedIdx(Math.max(0, maxIdx));
  }, [maxIdx, selectedIdx]);

  const commit = useCallback(
    (projectId: string) => {
      pushRecentId(projectId);
      // No-op when the picked row is already the active project. We
      //  used to reload anyway, which made the switcher feel broken
      //  ("I clicked it and nothing happened") since the recent-first
      //  ordering puts the current project at the top of the list.
      if (projectId === currentProjectId) {
        close();
        return;
      }
      close();
      const url = new URL(window.location.href);
      url.searchParams.set("project", projectId);
      window.location.href = url.toString();
    },
    [close, currentProjectId],
  );

  const openCreate = useCallback(() => {
    setStage("create");
    setCreateError(null);
  }, []);

  const backToList = useCallback(() => {
    setStage("list");
    setCreateError(null);
  }, []);

  const handleKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (stage !== "list") {
          backToList();
        } else {
          close();
        }
        return;
      }
      if (stage !== "list") return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, maxIdx));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (isOnNewRow) {
          openCreate();
          return;
        }
        const pick = ordered[selectedIdx];
        if (pick) commit(pick.id);
      }
    },
    [stage, maxIdx, isOnNewRow, openCreate, ordered, selectedIdx, commit, close, backToList],
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
        {stage === "list" && (
          <ListStage
            inputRef={inputRef}
            query={query}
            setQuery={setQuery}
            setSelectedIdx={setSelectedIdx}
            close={close}
            error={error}
            projects={projects}
            ordered={ordered}
            selectedIdx={selectedIdx}
            isOnNewRow={isOnNewRow}
            commit={commit}
            openCreate={openCreate}
            currentProjectId={currentProjectId}
          />
        )}

        {stage === "create" && (
          <CreateStage
            name={createName}
            setName={(n) => {
              setCreateName(n);
              if (!createIdDirty) setCreateId(slugifyName(n));
            }}
            id={createId}
            setId={(v) => {
              setCreateId(v);
              setCreateIdDirty(true);
            }}
            preset={createPreset}
            setPreset={setCreatePreset}
            creating={creating}
            error={createError}
            onCancel={backToList}
            onSubmit={async () => {
              setCreateError(null);
              const cleanName = createName.trim();
              const cleanId = createId.trim().toLowerCase();
              if (!cleanName) {
                setCreateError("Please provide a display name.");
                return;
              }
              if (!/^[a-z0-9][a-z0-9_-]*$/.test(cleanId)) {
                setCreateError(
                  "Id must start with a letter/digit and contain only a-z, 0-9, _, -.",
                );
                return;
              }
              setCreating(true);
              try {
                const result = await createProject({
                  id: cleanId,
                  name: cleanName,
                  preset: createPreset,
                });
                setCreatedId(result.id);
                setStage("created");
                // Refresh the list so the new project appears when
                //  the user clicks Back (or reopens the switcher).
                fetchProjects()
                  .then(setProjects)
                  .catch(() => {});
              } catch (err) {
                if (err instanceof ApiError) {
                  // 409 = exists, 400 = validation. Surface the body.
                  setCreateError(err.body || `Create failed (HTTP ${err.status}).`);
                } else {
                  setCreateError(err instanceof Error ? err.message : String(err));
                }
              } finally {
                setCreating(false);
              }
            }}
          />
        )}

        {stage === "created" && createdId && (
          <CreatedStage
            projectId={createdId}
            onDone={() => {
              // Reset the create draft so a second creation starts
              //  fresh, then drop back to the list where the new
              //  project is visible (even if its routes aren't
              //  mounted until restart).
              setCreateName("");
              setCreateId("");
              setCreateIdDirty(false);
              setCreatePreset("main");
              setCreatedId(null);
              setStage("list");
            }}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stage 1 — List
// ---------------------------------------------------------------------------

function ListStage({
  inputRef,
  query,
  setQuery,
  setSelectedIdx,
  close,
  error,
  projects,
  ordered,
  selectedIdx,
  isOnNewRow,
  commit,
  openCreate,
  currentProjectId,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  setQuery: (v: string) => void;
  setSelectedIdx: (updater: number | ((prev: number) => number)) => void;
  close: () => void;
  error: string | null;
  projects: ProjectListEntry[] | null;
  ordered: ProjectListEntry[];
  selectedIdx: number;
  isOnNewRow: boolean;
  commit: (id: string) => void;
  openCreate: () => void;
  currentProjectId: string | null;
}) {
  return (
    <>
      <div
        className="flex items-center gap-2 border-b"
        style={{ borderColor: "var(--il-border-soft)", padding: "10px 14px" }}
      >
        <span
          className="font-mono uppercase"
          style={{ fontSize: 10.5, letterSpacing: "0.06em", color: "var(--il-text3)" }}
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
                  style={{ fontSize: 10.5, color: "var(--il-text3)", letterSpacing: "0.04em" }}
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

        {/* + New project — anchored below the list. Keyboard cursor
         *  lands on it after the last real project; clicking it or
         *  pressing Enter flips the modal to the create stage. */}
        <button
          type="button"
          onClick={openCreate}
          onMouseEnter={() => setSelectedIdx(ordered.length)}
          className="flex w-full items-center gap-2 text-left outline-none"
          style={{
            padding: "10px 14px",
            borderTop: "1px solid var(--il-border-soft)",
            background: isOnNewRow
              ? "color-mix(in oklch, var(--il-blue) 14%, transparent)"
              : "transparent",
            borderLeft: `2px solid ${isOnNewRow ? "var(--il-blue)" : "transparent"}`,
            color: isOnNewRow ? "var(--il-text)" : "var(--il-text2)",
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          <span style={{ fontSize: 13 }}>New project…</span>
        </button>
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
    </>
  );
}

// ---------------------------------------------------------------------------
// Stage 2 — Create wizard
// ---------------------------------------------------------------------------

function CreateStage({
  name,
  setName,
  id,
  setId,
  preset,
  setPreset,
  creating,
  error,
  onCancel,
  onSubmit,
}: {
  name: string;
  setName: (v: string) => void;
  id: string;
  setId: (v: string) => void;
  preset: Preset;
  setPreset: (p: Preset) => void;
  creating: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: () => Promise<void>;
}) {
  return (
    <>
      <div
        className="flex items-center gap-2 border-b"
        style={{ borderColor: "var(--il-border-soft)", padding: "10px 14px" }}
      >
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1 rounded px-1 py-0.5 text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
          aria-label="Back to project list"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          <span
            className="font-mono uppercase"
            style={{ fontSize: 10.5, letterSpacing: "0.06em", color: "var(--il-text3)" }}
          >
            new project
          </span>
        </button>
        <span className="flex-1" />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit();
        }}
        style={{ padding: "18px 20px 16px", display: "grid", gap: 14 }}
      >
        <LabelledField label="Name" hint="How the project shows up in the switcher and header.">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Q4 Research"
            className="outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
            style={inputStyle}
          />
        </LabelledField>

        <LabelledField
          label="Id"
          hint="Folder name on disk (projects/<id>/). Auto-derived from the name, editable."
        >
          <input
            type="text"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="q4-research"
            className="font-mono outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
            style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 13 }}
          />
        </LabelledField>

        <LabelledField
          label="Preset"
          hint="Egress policy is written into project.yaml and can be changed there later."
        >
          <div
            style={{
              display: "inline-flex",
              padding: 2,
              background: "var(--il-slate)",
              border: "1px solid var(--il-border-soft)",
              borderRadius: 4,
            }}
          >
            {(["main", "research", "sandbox"] as const).map((p) => {
              const active = p === preset;
              const Icon = PRESET_ICONS[p];
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPreset(p)}
                  aria-pressed={active}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "5px 12px",
                    fontSize: 12,
                    fontFamily: "var(--font-sans)",
                    fontWeight: 500,
                    color: active ? "var(--il-text)" : "var(--il-text2)",
                    background: active ? "var(--il-slate-elev)" : "transparent",
                    border: `1px solid ${active ? "var(--il-border)" : "transparent"}`,
                    borderRadius: 3,
                    cursor: "pointer",
                    textTransform: "capitalize",
                  }}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {p}
                </button>
              );
            })}
          </div>
          <PresetBlurb preset={preset} />
        </LabelledField>

        {error && (
          <div
            style={{
              fontSize: 12,
              color: "var(--il-red)",
              padding: "8px 10px",
              border: "1px solid color-mix(in oklch, var(--il-red) 40%, transparent)",
              background: "color-mix(in oklch, var(--il-red) 10%, transparent)",
              borderRadius: 3,
            }}
          >
            {error}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={creating}
            style={{
              padding: "7px 14px",
              fontSize: 12.5,
              fontFamily: "var(--font-sans)",
              fontWeight: 500,
              background: "transparent",
              color: "var(--il-text2)",
              border: "1px solid var(--il-border)",
              borderRadius: 3,
              cursor: creating ? "not-allowed" : "pointer",
              opacity: creating ? 0.5 : 1,
            }}
          >
            Cancel
          </button>
          <span className="flex-1" />
          <button
            type="submit"
            disabled={creating}
            style={{
              padding: "7px 14px",
              fontSize: 12.5,
              fontFamily: "var(--font-sans)",
              fontWeight: 500,
              background: "var(--il-blue)",
              color: "var(--il-bg)",
              border: "none",
              borderRadius: 3,
              cursor: creating ? "progress" : "pointer",
              boxShadow: creating ? "none" : "0 0 10px var(--il-blue-glow)",
              opacity: creating ? 0.7 : 1,
            }}
          >
            {creating ? "Creating…" : "Create project"}
          </button>
        </div>
      </form>
    </>
  );
}

function LabelledField({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  // Uses `<div role="group">` instead of `<label>` because the
  //  child isn't guaranteed to be a single form control — the
  //  Preset row holds a SegChoice-style button group. Biome's
  //  noLabelWithoutControl would flag the <label> in that case
  //  even though the others are fine.
  return (
    <fieldset
      style={{
        display: "grid",
        gap: 4,
        margin: 0,
        padding: 0,
        border: "none",
      }}
    >
      <legend
        className="font-mono uppercase"
        style={{
          fontSize: 10.5,
          letterSpacing: "0.06em",
          color: "var(--il-text3)",
          padding: 0,
          marginBottom: 4,
        }}
      >
        {label}
      </legend>
      {children}
      <span style={{ fontSize: 11.5, color: "var(--il-text3)", lineHeight: 1.4 }}>{hint}</span>
    </fieldset>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "7px 9px",
  fontSize: 13,
  fontFamily: "var(--font-sans)",
  color: "var(--il-text)",
  background: "var(--il-bg)",
  border: "1px solid var(--il-border)",
  borderRadius: 3,
};

const PRESET_ICONS = {
  main: Briefcase,
  research: Telescope,
  sandbox: ShieldCheck,
} as const;

function PresetBlurb({ preset }: { preset: Preset }) {
  // Plain-language copy aimed at non-technical users; the technical
  //  egress detail lives in the field-level hint footnote so the
  //  preset row reads as intent ("for everyday work") rather than
  //  policy ("egress: allowlist").
  const blurb =
    preset === "main"
      ? "For your everyday work. Agents can use trusted AI services (Anthropic, OpenAI). Recommended for most projects."
      : preset === "research"
        ? "For gathering sources. Agents can fetch from any website — use when an agent needs to read the open web."
        : "For private notes or untrusted content. No internet access — agents stay fully local.";
  return (
    <span
      style={{
        fontSize: 11.5,
        color: "var(--il-text3)",
        marginTop: 2,
        lineHeight: 1.45,
      }}
    >
      {blurb}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Stage 3 — Created confirmation
// ---------------------------------------------------------------------------

function CreatedStage({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  return (
    <>
      <div
        className="flex items-center gap-2 border-b"
        style={{ borderColor: "var(--il-border-soft)", padding: "10px 14px" }}
      >
        <span
          className="font-mono uppercase"
          style={{ fontSize: 10.5, letterSpacing: "0.06em", color: "var(--il-text3)" }}
        >
          project created
        </span>
      </div>

      <div style={{ padding: "20px 20px 18px", display: "grid", gap: 14 }}>
        <div className="flex items-center gap-3">
          <CircleCheck className="h-5 w-5" style={{ color: "var(--il-green)" }} />
          <span style={{ fontSize: 14, color: "var(--il-text)" }}>
            <code
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12.5,
                color: "var(--il-text2)",
              }}
            >
              {projectId}
            </code>{" "}
            is on disk.
          </span>
        </div>

        {/* "Restart required" amber strip — matches the Onboarding
         *  §04 "What happens next" grammar so the trust-boundary
         *  call-out looks consistent across the app. */}
        <div
          style={{
            borderLeft: "3px solid var(--il-amber)",
            background: "color-mix(in oklch, var(--il-amber) 8%, transparent)",
            padding: "10px 14px",
            borderRadius: "0 3px 3px 0",
          }}
        >
          <div
            className="font-mono uppercase"
            style={{ fontSize: 10.5, color: "var(--il-amber)", letterSpacing: "0.08em" }}
          >
            restart required
          </div>
          <p
            style={{
              margin: "6px 0 0",
              fontSize: 13,
              color: "var(--il-text2)",
              lineHeight: 1.5,
            }}
          >
            Restart the Ironlore server so it mounts the new project's routes under{" "}
            <code
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11.5,
                color: "var(--il-text)",
              }}
            >
              /api/projects/{projectId}/…
            </code>
            . Once restarted, open ⌘P and switch to it.
          </p>
        </div>

        <div className="flex items-center">
          <span className="flex-1" />
          <button
            type="button"
            onClick={onDone}
            style={{
              padding: "7px 14px",
              fontSize: 12.5,
              fontFamily: "var(--font-sans)",
              fontWeight: 500,
              background: "var(--il-blue)",
              color: "var(--il-bg)",
              border: "none",
              borderRadius: 3,
              cursor: "pointer",
              boxShadow: "0 0 10px var(--il-blue-glow)",
            }}
          >
            Got it
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * Slugify a display name into an Ironlore project id. Lowercases,
 * collapses whitespace + runs of punctuation into single dashes,
 * strips anything outside the `^[a-z0-9_-]+$` alphabet, and trims
 * leading/trailing dashes so the result always matches the server
 * regex on first try.
 */
function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
