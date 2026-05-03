import { composeBoundariesSection } from "@ironlore/core";
import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type BuildAgentInput, buildAgent } from "../lib/api.js";

/**
 * Visual Agent Builder — Phase-11 A.9.1 deliverable.
 *
 * Translates plain-English form fields into a properly-shaped
 * `.agents/<slug>/persona.md` via the server's
 * `POST /api/projects/:id/agents` endpoint. The user never has
 * to touch YAML; the server compiles the inputs into the
 * persona-frontmatter shape the executor already understands.
 *
 * **Note on egress:** the proposal asks for a per-agent
 * "Allow this agent to read the internet?" toggle, but Ironlore's
 * egress chokepoint is project-level (one `fetchForProject` per
 * project) — inventing per-agent egress would mean a different
 * architecture. This dialog instead surfaces the project's
 * existing policy as read-only context so the user understands
 * the scope.
 */

export function AgentBuilderDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (slug: string) => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [role, setRole] = useState("");
  const [constraintDraft, setConstraintDraft] = useState("");
  // Each constraint carries a synthetic `id` so React's keys stay
  // stable when the user reorders / removes — entries are
  // user-provided text and could legitimately repeat.
  const [constraints, setConstraints] = useState<Array<{ id: string; text: string }>>([]);
  const constraintIdRef = useRef(0);
  const [scopePath, setScopePath] = useState("/**");
  const [canEditPages, setCanEditPages] = useState(true);
  const [reviewBeforeMerge, setReviewBeforeMerge] = useState(false);
  const [heartbeat, setHeartbeat] = useState<string>("manual");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-derive slug from the name as the user types — the user
  // can override by editing the slug field (slugTouched flips on
  // first manual edit so we stop overwriting).
  useEffect(() => {
    if (slugTouched) return;
    const auto = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 41);
    setSlug(auto);
  }, [name, slugTouched]);

  // Esc closes — modal-standard.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const addConstraint = () => {
    const trimmed = constraintDraft.trim();
    if (!trimmed) return;
    constraintIdRef.current += 1;
    setConstraints((prev) => [...prev, { id: `c${constraintIdRef.current}`, text: trimmed }]);
    setConstraintDraft("");
  };

  const removeConstraint = (id: string) => {
    setConstraints((prev) => prev.filter((c) => c.id !== id));
  };

  const handleSubmit = async () => {
    if (!name.trim() || !role.trim() || !slug.trim()) {
      setError("Name, slug, and role are all required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const input: BuildAgentInput = {
        name: name.trim(),
        slug: slug.trim(),
        role: role.trim(),
        constraints: constraints.map((c) => c.text),
        scopePath: scopePath.trim() || undefined,
        canEditPages,
        reviewBeforeMerge,
        heartbeat: heartbeat === "manual" ? undefined : heartbeat,
      };
      const result = await buildAgent(input);
      onCreated(result.slug);
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setSubmitting(false);
    }
  };

  const formValid = name.trim().length > 0 && slug.trim().length > 0 && role.trim().length > 0;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close paired with the Escape handler above
    <div
      role="dialog"
      aria-label="Build a custom agent"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 70,
        background: "color-mix(in oklch, black 50%, transparent)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 520,
          maxWidth: "92vw",
          maxHeight: "90vh",
          overflowY: "auto",
          background: "var(--il-slate-elev)",
          border: "1px solid var(--il-border)",
          borderRadius: 6,
          padding: 18,
        }}
      >
        <header className="flex items-center gap-2 border-b border-border pb-2">
          <span
            className="font-mono uppercase"
            style={{ fontSize: 10.5, letterSpacing: "0.06em", color: "var(--il-text3)" }}
          >
            Build a custom agent
          </span>
          <span className="flex-1" />
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded p-0.5 hover:bg-ironlore-slate-hover"
          >
            <X className="h-3.5 w-3.5" style={{ color: "var(--il-text3)" }} />
          </button>
        </header>

        <div className="mt-3 flex flex-col gap-3 text-xs">
          <FieldLabel hint="Display name shown in the UI.">
            <span>Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Research Assistant"
              maxLength={80}
              className="rounded border border-border bg-transparent px-2 py-1.5 text-primary focus:border-ironlore-blue focus:outline-none"
            />
          </FieldLabel>

          <FieldLabel hint="Auto-derived from name. Override only if you need a specific URL slug.">
            <span>Slug</span>
            <input
              type="text"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugTouched(true);
              }}
              placeholder="research-assistant"
              maxLength={41}
              className="rounded border border-border bg-transparent px-2 py-1.5 font-mono text-primary focus:border-ironlore-blue focus:outline-none"
            />
          </FieldLabel>

          <FieldLabel hint="One-line description of what this agent is for. Becomes the agent's role in its persona prompt.">
            <span>Role</span>
            <input
              type="text"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="Find sources, summarize papers, draft research notes"
              maxLength={200}
              className="rounded border border-border bg-transparent px-2 py-1.5 text-primary focus:border-ironlore-blue focus:outline-none"
            />
          </FieldLabel>

          {/* "Never do this" rules — multi-line list */}
          <div className="flex flex-col gap-1">
            <span style={{ color: "var(--il-text3)" }}>Never do this</span>
            <span style={{ color: "var(--il-text4)", fontSize: 10.5 }}>
              Each rule becomes part of the agent's system prompt under "Constraints."
            </span>
            <div className="flex gap-1.5">
              <input
                type="text"
                value={constraintDraft}
                onChange={(e) => setConstraintDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addConstraint();
                  }
                }}
                placeholder="e.g. Modify pages outside /research/"
                maxLength={200}
                className="flex-1 rounded border border-border bg-transparent px-2 py-1.5 text-primary focus:border-ironlore-blue focus:outline-none"
              />
              <button
                type="button"
                onClick={addConstraint}
                disabled={!constraintDraft.trim()}
                className="rounded border border-border px-2 py-1 hover:bg-ironlore-slate-hover disabled:opacity-50"
                aria-label="Add constraint"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            {constraints.length > 0 && (
              <ul className="mt-1 flex flex-col gap-1">
                {constraints.map((c, i) => (
                  <li
                    key={c.id}
                    className="flex items-start gap-1.5 rounded px-1.5 py-1"
                    style={{
                      background: "color-mix(in oklch, var(--il-amber) 6%, transparent)",
                      border: "1px solid color-mix(in oklch, var(--il-amber) 25%, transparent)",
                      fontSize: 11,
                    }}
                  >
                    <span
                      className="font-mono uppercase"
                      style={{ fontSize: 9, color: "var(--il-amber)" }}
                    >
                      NEVER
                    </span>
                    <span className="flex-1">{c.text}</span>
                    <button
                      type="button"
                      aria-label={`Remove constraint ${i + 1}`}
                      onClick={() => removeConstraint(c.id)}
                      className="rounded p-0.5 hover:bg-ironlore-slate-hover"
                    >
                      <X className="h-3 w-3" style={{ color: "var(--il-text3)" }} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Toggle
            label="Allow this agent to edit pages?"
            hint="If off, the agent can read pages and answer questions but can't change anything (writable_kinds: [])."
            checked={canEditPages}
            onChange={setCanEditPages}
          />

          <Toggle
            label="Review changes before they merge?"
            hint="If on, autonomous runs land on a staging branch you approve through the Inbox before merge (review_mode: inbox)."
            checked={reviewBeforeMerge}
            onChange={setReviewBeforeMerge}
          />

          <FieldLabel hint="Limit the agent to a folder. Default '/**' = the whole vault.">
            <span>Scope path</span>
            <input
              type="text"
              value={scopePath}
              onChange={(e) => setScopePath(e.target.value)}
              placeholder="/research/**"
              className="rounded border border-border bg-transparent px-2 py-1.5 font-mono text-primary focus:border-ironlore-blue focus:outline-none"
            />
          </FieldLabel>

          <FieldLabel hint="How often should the agent run on its own? Manual = never (you trigger every run).">
            <span>Schedule</span>
            <select
              value={heartbeat}
              onChange={(e) => setHeartbeat(e.target.value)}
              className="rounded border border-border bg-transparent px-2 py-1.5 text-primary focus:border-ironlore-blue focus:outline-none"
            >
              <option value="manual">Manual only</option>
              <option value="0 9 * * 1-5">Weekday mornings (09:00 Mon-Fri)</option>
              <option value="0 6 * * 0">Weekly (Sunday 06:00)</option>
              <option value="0 6 * * *">Daily (06:00)</option>
            </select>
          </FieldLabel>

          {/* Boundaries preview — renders the same string the
           *  server will write to persona.md so the user sees their
           *  agent's structural envelope before clicking Create.
           *  Mirrors composeBoundariesSection() in
           *  packages/core/src/boundaries.ts — single source of truth.
           */}
          <BoundariesPreview
            scopePath={scopePath}
            canEditPages={canEditPages}
            reviewBeforeMerge={reviewBeforeMerge}
            heartbeat={heartbeat}
          />

          {/* Project-egress note — calling out the architectural boundary */}
          <div
            className="rounded p-2"
            style={{
              background: "color-mix(in oklch, var(--il-blue) 8%, transparent)",
              border: "1px solid color-mix(in oklch, var(--il-blue) 25%, transparent)",
              fontSize: 10.5,
              color: "var(--il-text2)",
              lineHeight: 1.5,
            }}
          >
            <span className="font-mono uppercase" style={{ color: "var(--il-blue)" }}>
              Network access
            </span>
            <span>
              {" "}
              · the agent uses this project's egress policy. Open it in Settings → Project to change
              which hosts agents can reach.
            </span>
          </div>

          {error && (
            <p role="alert" className="text-signal-red">
              {error}
            </p>
          )}
        </div>

        <footer className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded border border-border px-3 py-1 text-xs hover:bg-ironlore-slate-hover disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!formValid || submitting}
            className="rounded bg-ironlore-blue px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            {submitting ? "Building…" : "Build agent"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  // The input is passed via `children` — every callsite renders an
  // <input> / <select> inside, so the label IS associated with a
  // control. Biome's static rule can't see through the children
  // prop; the suppression is the cleanest fix without adding a
  // synthetic id-passing dance.
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: input is passed through `children` at every callsite
    <label className="flex flex-col gap-1">
      <span className="flex items-center gap-2" style={{ color: "var(--il-text3)" }}>
        {children}
      </span>
      {hint && (
        <span style={{ color: "var(--il-text4)", fontSize: 10.5, lineHeight: 1.4 }}>{hint}</span>
      )}
    </label>
  );
}

/**
 * Live-updating preview of the `## Boundaries` section the server
 * will write into persona.md. Calls the same `composeBoundariesSection`
 * helper from `@ironlore/core` that `buildPersona()` uses, so what
 * the user sees in the form is exactly what lands on disk.
 *
 * Intentionally rendered inline (not a collapsible "Show preview")
 * because the whole point of the section is "tell the user what
 * they're agreeing to before they click Create" — hiding it behind
 * a toggle defeats the purpose.
 */
function BoundariesPreview({
  scopePath,
  canEditPages,
  reviewBeforeMerge,
  heartbeat,
}: {
  scopePath: string;
  canEditPages: boolean;
  reviewBeforeMerge: boolean;
  heartbeat: string;
}) {
  const text = useMemo(() => {
    return composeBoundariesSection({
      scopePages: scopePath.trim() ? [scopePath.trim()] : [],
      canEditPages,
      reviewBeforeMerge,
      heartbeat: heartbeat === "manual" ? undefined : heartbeat,
    });
  }, [scopePath, canEditPages, reviewBeforeMerge, heartbeat]);

  return (
    <div
      className="rounded p-2"
      style={{
        background: "color-mix(in oklch, var(--il-amber) 6%, transparent)",
        border: "1px solid color-mix(in oklch, var(--il-amber) 25%, transparent)",
        fontSize: 10.5,
        color: "var(--il-text2)",
        lineHeight: 1.5,
      }}
    >
      <div
        className="font-mono uppercase"
        style={{
          color: "var(--il-amber)",
          fontSize: 10,
          letterSpacing: "0.06em",
          marginBottom: 4,
        }}
      >
        Boundaries · receipt
      </div>
      <div style={{ color: "var(--il-text3)", marginBottom: 6 }}>
        These will be appended to the agent's persona.md as a<code> ## Boundaries</code> section.
        The runtime enforces them — this is the human-readable mirror of <code>scope.pages</code>,{" "}
        <code>writable_kinds</code>,<code> review_mode</code>, and <code>heartbeat</code>.
      </div>
      <pre
        className="rounded"
        style={{
          background: "var(--il-bg)",
          border: "1px solid var(--il-border-soft)",
          padding: "6px 8px",
          fontFamily: "var(--font-mono)",
          fontSize: 10.5,
          color: "var(--il-text)",
          whiteSpace: "pre-wrap",
          margin: 0,
          maxHeight: 220,
          overflowY: "auto",
        }}
      >
        {text}
      </pre>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="h-3.5 w-3.5"
        />
        <span style={{ color: "var(--il-text2)" }}>{label}</span>
      </label>
      {hint && (
        <span
          style={{ color: "var(--il-text4)", fontSize: 10.5, lineHeight: 1.4, paddingLeft: 22 }}
        >
          {hint}
        </span>
      )}
    </div>
  );
}
